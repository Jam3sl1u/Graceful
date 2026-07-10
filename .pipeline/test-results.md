# Test Results — Issue #27: Role assignment & multi-admin support

## Verdict: PASS

## Context
A prior automated pipeline run left this file describing issue #33 (rebased
in from the `origin/main` merge required to pick up #29's audit-log
infrastructure), and before that, issue #26. This is the first test-results
pass that actually covers #27's own implementation.

## What was independently verified

### 1. Static checks (re-run from scratch)
- `bun run typecheck` (`tsc --noEmit`) — **passes**, 0 errors.
- `bun run lint` (`eslint .`) — **passes**, 0 errors/warnings.
- `bun run test` (`jest`, unit suite) — **passes**: 12 suites / 132 tests,
  0 failures. Includes the 20 new tests in
  `tests/unit/app/api/church-group-members-role-route.test.ts` and all
  suites brought in by the `origin/main` merge (#29/#30/#31/#33) with no
  regressions.
- `bun run format:check` — the 4 files this issue actually touched
  (`schemas/role.ts`, `handler.ts`, `route.ts`, the new test file) are
  correctly formatted. 16 other files flagged by prettier were already
  unformatted before this change (brought in wholesale by the
  `origin/main` merge — `tests/integration/rls/**`, `README.md`,
  `tsconfig.json`, etc.) — confirmed via `git status` that none of them are
  modified by this issue's work, so left untouched as out of scope.

### 2. Code review against spec (`.pipeline/spec.md`)
Read `schemas/role.ts`, `handler.ts`, and `route.ts` in full against the
spec's control-flow description:

- Order of checks matches exactly: auth → role → path-id validation → body
  validation → JWT/Supabase client → target lookup → BR-12 → update → audit
  log → response.
- `requireRole(ctx, ["admin"])` is the only role gate; confirmed no other
  code path in this handler can reach `.update()`.
- BR-12 trigger condition (`target.role === "admin" && newRole !== "admin"`,
  count ≤ 1) matches spec exactly — verified via the "BR-03/BR-04: promoting
  ... (no admin-count query made)" test, which asserts the mock's `.from()`
  was called exactly twice (target lookup + update only) for a promotion,
  proving the count query is genuinely skipped, not just ignored.
- Audit log call uses `action: "user.role_changed"`, `entityType: "user"`,
  `metadata: { old_value, new_value }` — matches `writeAuditLog`'s own
  contract and its existing unit-test fixture verbatim (checked
  `tests/unit/lib/audit/write-audit-log.test.ts` directly, not just the
  issue text, which doesn't specify the key names).
- 404-not-403 for missing/cross-group targets: confirmed both scenarios hit
  the same code path (the `.eq("church_group_id", ...)` filter makes them
  indistinguishable at the query level), and that `writeAuditLog` is not
  called in either case.

### 3. Test coverage assessment
All 20 cases in the new test file were run and pass; reviewed for
meaningfulness (not just green):
- Each 403/401/400/404/422/500 case asserts both the status code and the
  `code` field in the response body, not just the status.
- The BR-12 self-demotion cases (target id === caller id) confirm the rule
  keys off `target.role`/admin count, not identity — there is no
  `ctx.userId === targetUserId` branch anywhere in the handler to
  special-case, so this is a real behavioral proof, not a tautology.
- The "no admin-count query made" assertion for promotions is a call-count
  check on the mock `.from()`, which would fail if the BR-12 branch were
  accidentally entered for a promotion — this is a meaningful negative
  assertion, not just a happy-path check.
- Audit-log-failure test confirms the response body has no `data` key on a
  500, i.e. a failed audit write genuinely fails the whole request rather
  than silently succeeding.

## Known residual gap (not a blocker)
- No live-database/integration test exercises the real
  `write_audit_log` RPC or the `users_update_leader_admin` RLS policy for
  this route — coverage here is unit-level with a mocked Supabase client,
  consistent with every other route in this codebase (`church-group-route`,
  `church-group-members-route`, `profile-route`, `instruments-route`,
  `audit-log-route` are all unit-only; only issue #33's cross-tenant matrix
  uses the live-DB integration harness, and extending that harness to cover
  role-change RLS specifically was not part of this issue's AC).

## Final numbers
- `bun run typecheck`: pass
- `bun run lint`: pass
- `bun run test`: 12 suites / 132 tests pass (20 new)
- `bun run format:check`: pass for all files this issue touched

No failures found. Recommend proceeding to Reviewer.
