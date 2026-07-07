# Changes — Issue #29: Audit log writer utility + read endpoint (BR-13)

## Summary

Implemented exactly the two capabilities in scope: a shared `writeAuditLog()`
server utility, and `GET /api/church-group/audit-log` (paginated, admin-only,
read-only). No route was wired to call `writeAuditLog()` — that's explicitly
deferred to #24/#27/#28 per the spec.

## Files created

- `supabase/migrations/20260707000001_audit_log_write_rpc.sql`
  New `public.write_audit_log(p_action, p_entity_type, p_entity_id, p_metadata)`
  `SECURITY DEFINER` RPC, modeled on
  `20260706000001_church_group_create_rpc.sql`. Derives `user_id` and
  `church_group_id` from the caller's JWT (`auth.jwt() ->> 'sub'` → `users`
  lookup) so a route cannot forge a log entry for another user/group. Only
  ever INSERTs (bypasses RLS for the insert only; `UPDATE`/`DELETE` remain
  `REVOKE`d at the table level from cluster-6). `GRANT EXECUTE` to
  `authenticated`. Includes a commented DOWN block.

- `lib/audit/write-audit-log.ts`
  `writeAuditLog(supabase, entry)` — thin wrapper around
  `supabase.rpc("write_audit_log", ...)`. Requires the RLS-scoped client for
  the acting user. Defaults `metadata` to `{}`. Throws
  `ApiException("Internal error", ErrorCode.INTERNAL, 500)` on RPC error;
  never swallows. `import "server-only"` at top, matching
  `loadInstruments`/`app/api/profile/handler.ts` conventions.

- `schemas/audit-log.ts`
  `auditLogQuerySchema` — Zod schema for `page` (default 1, min 1) and
  `pageSize` (default 50, min 1, max 100), both `z.coerce.number().int()`
  since they come from URL search params.

- `app/api/church-group/audit-log/handler.ts`
  `getAuditLog(req, lookup?)` — `requireAuth` → `requireRole(["admin"])` →
  parse `req.nextUrl.searchParams` via `auditLogQuerySchema` (400
  VALIDATION_FAILED on failure) → get Clerk JWT / build RLS-scoped Supabase
  client (401 UNAUTHENTICATED if no JWT) → `select` from `audit_logs` with
  `count: "exact"`, ordered `created_at DESC, id DESC`, `.range(from, to)`
  for offset pagination → map snake_case rows to `AuditLogItem[]` (camelCase)
  → `ok({ entries, pagination: { page, pageSize, total } })`. Single
  `try/catch` mapping `ApiException` → `fail(...)`, else 500 INTERNAL.

## Files modified

- `app/api/church-group/audit-log/route.ts`
  Replaced the `notImplemented(...)` stub with a thin `GET` delegator to
  `getAuditLog`, matching `app/api/church-group/members/route.ts`.

- `lib/supabase/types.ts`
  Added `AuditLogsRow` type, `audit_logs` entry under `Tables` (Row/Insert/
  Update/Relationships, following the existing hand-written pattern — Insert
  omits `id`/`created_at` as optional), and `write_audit_log` entry under
  `Functions` (Args match the RPC signature; Returns `AuditLogsRow`).

## Explicitly untouched (per spec's OUT OF SCOPE)

- `app/api/church-group/members/[id]/role/route.ts` and
  `app/api/church-group/members/[id]/route.ts` — still stubs, not wired to
  `writeAuditLog()`.
- No audit-log UI/screen added.
- No UPDATE/DELETE route added for audit rows (append-only preserved; the RPC
  only INSERTs).

## Verification run

- `bun run typecheck` — pass, no errors.
- `bun run lint` — pass, no errors.
- `bun run test` — pass, 8 suites / 66 tests (all pre-existing; no new test
  files were added here — the spec assigns those to the Tester:
  `tests/unit/app/api/audit-log-route.test.ts` and
  `tests/unit/lib/audit/write-audit-log.test.ts`).
- `bun run check:service-role` — pass ("OK: no service-role key references
  found outside comments in app/ or lib/").

## Notes for the Tester

- The mocked `NextRequest` for the handler test must expose `nextUrl` (the
  handler reads `req.nextUrl.searchParams`), same caveat the spec calls out.
- `getAuditLog` takes an optional `UserLookup` injection param exactly like
  `getChurchGroupMembers`/`getProfile`, so `tests/unit/app/api/profile-route.test.ts`'s
  `makeLookup(role)` pattern should drop in directly.
- For `writeAuditLog`, assert the exact RPC name (`"write_audit_log"`) and
  arg keys (`p_action`, `p_entity_type`, `p_entity_id`, `p_metadata`), and
  that a missing `metadata` arg becomes `{}` in the call, not `undefined`.
- RLS/append-only enforcement itself is out of scope for new tests here
  (already covered by `tests/integration/rls/rls.test.ts` and
  `.../tables/role-gated.test.ts` per the spec) — the migration file has no
  accompanying integration test in this change set.
