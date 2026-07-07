# Review — Issue #29: Audit log writer utility + read endpoint (BR-13)

VERDICT: SHIP

## What I verified independently
- Ran `git diff main...HEAD` on `app/ lib/ schemas/ supabase/` — only the six
  in-scope files changed. Out-of-scope stubs
  (`members/[id]/role/route.ts`, `members/[id]/route.ts`) untouched. No UI, no
  UPDATE/DELETE route added.
- Re-ran `bun run typecheck` (clean), `bun run lint` (clean),
  `bun run check:service-role` (OK — no service-role key in app/ or lib/),
  `bun run test` (10 suites / 84 tests, 0 failures).

## Correctness
- **RPC** (`20260707000001_audit_log_write_rpc.sql`): mirrors the approved
  `create_church_group` pattern — `SECURITY DEFINER`, `SET search_path = ''`,
  schema-qualified names, `GRANT EXECUTE ... TO authenticated`, commented DOWN.
  Derives `user_id`/`church_group_id` from `auth.jwt() ->> 'sub'` → `users`
  lookup, never from caller args, so a route cannot forge an entry for another
  user/group. Only ever INSERTs; UPDATE/DELETE stay REVOKEd (append-only
  preserved). Handles the no-metadata case via `COALESCE(p_metadata,'{}')`.
- **RLS**: confirmed `audit_logs_select_admin` policy exists in
  `20260704000001_rls_policies.sql` (church_group + role='admin' scoped) and RLS
  is enabled. Handler relying on RLS for group scoping (spec made the extra
  `.eq` optional) is correct and consistent.
- **Handler**: auth → requireRole(["admin"]) → safeParse query (400) → JWT (401,
  no client built) → RLS client → select with `count:"exact"`, `created_at DESC,
  id DESC`, `.range(from,to)` → snake→camel map → `ok({entries,pagination})`.
  Single try/catch maps ApiException→fail else 500. Matches spec step-for-step,
  incl. `count ?? 0` and pagination math.
- **Utility**: `import "server-only"` first, exact RPC arg mapping,
  `metadata ?? {}` default, throws ApiException(INTERNAL,500) on error, never
  swallows.
- **Types**: `AuditLogsRow`, `Tables.audit_logs`, `Functions.write_audit_log`
  added; typecheck passes with no `as any` escapes. `metadata` typed
  `Record<string,unknown>` (jsonb) and `user_id` nullable — both match the DB
  schema (varchar/uuid/jsonb NOT NULL default '{}', user_id NULL).

## Tests — meaningful, not superficial
- `write-audit-log.test.ts`: asserts exact RPC name + arg keys, metadata
  pass-through, `{}` default (explicitly `not.toBeUndefined()`), void on success,
  ApiException INTERNAL/500 on error.
- `audit-log-route.test.ts`: 401 (null userId, no users row, no JWT — with
  "client not built" assertions), 403 for each non-admin role, 400 for
  negative/over-max/non-numeric params, 200 happy path with camelCase mapping +
  null userId preserved, query-shape assertions (select columns, both orders,
  range(10,19) for page 2/size 10), empty set, null-count→0, DB error 500.
  Covers every named edge case in the spec.

## Notes (non-blocking)
- Migration has no live-DB integration test; spec permits this (RLS/append-only
  covered by existing integration suites; forgery-prevention logic is SQL not
  exercised by unit run). Acceptable per scope.

Green tests here reflect genuinely correct behavior. Ship it.
