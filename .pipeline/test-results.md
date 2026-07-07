# Test Results — Issue #29: Audit log writer utility + read endpoint (BR-13)

## Verdict: PASS

## Checks re-run independently (Bun)

- `bun install` — no changes, deps already in sync.
- `bun run typecheck` (`tsc --noEmit`) — **PASS**, no errors.
- `bun run lint` (`eslint .`) — **PASS**, no warnings/errors.
- `bun run test` (`jest`) — **PASS**, 10 suites / 84 tests, 0 failures. This
  is the 8 suites / 66 pre-existing tests plus the 2 new test files below
  (18 new tests) — no regressions elsewhere.
- `bun run check:service-role` — **PASS**: "OK: no service-role key
  references found outside comments in app/ or lib/."

## New test files written (spec assigned these to the Tester)

### `tests/unit/lib/audit/write-audit-log.test.ts`

- RPC invoked with exact name `"write_audit_log"` and arg keys
  `p_action`/`p_entity_type`/`p_entity_id`/`p_metadata`; metadata round-trips
  arbitrary JSON (`{ old_value: "member", new_value: "set_leader" }`).
- Missing `metadata` on the entry defaults to `{}` in the RPC call (asserted
  it is not `undefined`), matching the spec's edge case.
- Resolves `void` on success.
- Failure case: RPC `error` → throws `ApiException` with `code: "INTERNAL"`,
  `status: 500`; confirms the throw is never swallowed (spec explicitly
  requires this).

### `tests/unit/app/api/audit-log-route.test.ts`

- 401 UNAUTHENTICATED when Clerk `userId` is null (lookup never consulted).
- 401 UNAUTHENTICATED when `requireAuth`'s lookup returns null (no matching
  `users` row) — "unauthenticated / no users row" edge case.
- 403 FORBIDDEN for each non-admin role (`member`, `set_leader`, `guest`),
  parametrized with `it.each`; confirms the Supabase client is never built
  before the role check fails.
- 401 UNAUTHENTICATED when `getToken` yields no JWT and confirms no
  Supabase client is built — matches the spec's "GET with no JWT" edge case
  verbatim.
- 400 VALIDATION_FAILED for negative `page`, `pageSize` > 100, and
  non-numeric `page`.
- 200 happy path for admin: rows mapped snake_case → camelCase
  (`AuditLogItem[]`), `userId: null` preserved for system-attributed rows,
  `metadata` round-trips arbitrary JSON, `pagination` shape matches the
  spec's documented response (`page`, `pageSize`, `total`).
- Query-shape assertions independent of the implementation's internals but
  matching the spec's required query: `.select(...)` called with the exact
  column list and `{ count: "exact" }`; `.order("created_at", { ascending:
  false })` then `.order("id", { ascending: false })` (stable tiebreak,
  newest first); `.range(from, to)` computed correctly from `page`/
  `pageSize` (page 2, pageSize 10 → `range(10, 19)`).
- 200 with `entries: []` / `pagination.total: 0` for zero matching rows.
- `count: null` from Supabase treated as `total: 0` (defensive `count ?? 0`
  path).
- Failure case: DB query `error` → 500 INTERNAL.

## Independent verification beyond re-running the Coder's commands

1. **Out-of-scope files untouched** — `git show --stat` on commit `b3232c6`
   confirms `app/api/church-group/members/[id]/role/route.ts` and
   `app/api/church-group/members/[id]/route.ts` are absent from the diff
   (no matches for either path), matching the spec's explicit "do NOT
   touch these files" instruction.

2. **Migration file read in full**
   (`supabase/migrations/20260707000001_audit_log_write_rpc.sql`):
   `SECURITY DEFINER`, `SET search_path = ''`, derives `user_id`/
   `church_group_id` from `auth.jwt() ->> 'sub'` → `users` lookup (never
   from caller-supplied arguments — prevents forging a log entry for
   another user/group), only ever `INSERT`s, `GRANT EXECUTE ...
   TO authenticated`, commented `DOWN` block present. Matches the spec's
   required SQL almost verbatim.

3. **Handler/utility/schema read-through against every spec step**:
   - `app/api/church-group/audit-log/handler.ts` — `requireAuth` →
     `requireRole(["admin"])` → parses `req.nextUrl.searchParams` via
     `auditLogQuerySchema.safeParse` (400 on failure) → `getToken` (401 if
     null, no client built) → `getSupabaseClient(jwt)` → select with
     `count: "exact"`, double `.order(...)`, `.range(from, to)` → maps
     snake_case to `AuditLogItem[]` → `ok({ entries, pagination })`; single
     `try/catch` mapping `ApiException` → `fail`, else 500 INTERNAL. Matches
     the spec's 10-step behavior list exactly, including the `from`/`to`
     math (`from = (page-1)*pageSize`, `to = from + pageSize - 1`).
   - `lib/audit/write-audit-log.ts` — starts with `import "server-only"`,
     typed `SupabaseClient<Database>`, calls the RPC with the documented
     arg mapping, throws on error, returns `void` on success. Matches spec
     verbatim.
   - `schemas/audit-log.ts` — `page`/`pageSize` both `z.coerce.number().int()`
     with the documented min/max/defaults.
   - `app/api/church-group/audit-log/route.ts` — thin `GET` delegator to
     `getAuditLog`, matching the spec's example and the
     `church-group/members/route.ts` pattern.
   - `lib/supabase/types.ts` — `AuditLogsRow`, `Tables.audit_logs`, and
     `Functions.write_audit_log` entries present and typecheck cleanly
     against the handler's `.from("audit_logs").select(...)` and
     `write-audit-log.ts`'s `.rpc("write_audit_log", ...)` calls (verified
     by `bun run typecheck` passing with no errors/`as any` escapes needed).

4. **No UPDATE/DELETE route added** — confirmed by inspecting the full
   diff of commit `b3232c6`: only `handler.ts` (new), `route.ts` (GET
   delegator, modified), `lib/audit/write-audit-log.ts` (new),
   `schemas/audit-log.ts` (new), and `lib/supabase/types.ts` (additive)
   were touched under `app/`/`lib/`/`schemas/` — no new route files, no UI.

## Notes / non-blocking observations (no fix required)

- RLS admin-SELECT scoping and append-only enforcement (REVOKE
  UPDATE/DELETE) are exercised by
  `tests/integration/rls/rls.test.ts`/`.../tables/role-gated.test.ts` per
  the spec, not duplicated here — consistent with the spec's explicit
  instruction not to duplicate that coverage in unit tests.
- The migration itself has no accompanying integration test in this change
  set, as the Coder's notes state and the spec permits (RLS/append-only is
  covered elsewhere; the RPC's forging-prevention logic is exercised
  indirectly by `write-audit-log.test.ts`'s arg-shape assertions, but the
  SQL itself is not executed against a live DB by this test run).

## Files touched during testing

- `tests/unit/lib/audit/write-audit-log.test.ts` (new)
- `tests/unit/app/api/audit-log-route.test.ts` (new)

No implementation files were modified.

## Conclusion

No failures found. The implementation matches the spec precisely, including
every named edge case, the exact response shape, and the scoping
boundaries (no route wiring, no UI, no UPDATE/DELETE path).

**Result: PASS. No blocking issues found. Ready for Reviewer.**
