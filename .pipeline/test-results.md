# Test Results — Issue #15: JWT verification + role-check middleware

Branch: `issue-15-jwt-verification-role-check-middleware`

## Verification performed (independently re-run, not trusted from changes.md)

- `bun run typecheck` (`tsc --noEmit`) — **PASS**, no errors.
- `bun run lint` (`eslint .`) — **PASS**, clean.
- `bun run test` (`jest`) — **PASS**, 3 suites / 13 tests, 0 failures:
  - `tests/unit/lib/api/auth.test.ts`
  - `tests/unit/app/api/admin-only-route.test.ts`
  - `tests/unit/lib/api/response.test.ts` (pre-existing, unaffected)
- `git diff a60f52b..660fff0 --stat` — confirmed scope: only `lib/api/auth.ts` (modified),
  `app/api/_examples/admin-only/route.ts` (new), the two new test files, and
  `.pipeline/spec.md`. No changes to `middleware.ts`, `lib/supabase/*`,
  `lib/clerk/server.ts`, or any existing route handler, matching the spec's "Files to
  modify" / "Definition of done" constraints.
- Manually read `lib/api/auth.ts`, `app/api/_examples/admin-only/route.ts`, both test
  files, `lib/api/errors.ts`, and `types/domain.ts` line-by-line against the spec.

## Findings against spec/acceptance criteria

- **401 vs 403 ordering**: `requireAuth` throws `UNAUTHENTICATED`/401 when Clerk
  `auth()` returns no `userId`, and the test at
  `tests/unit/lib/api/auth.test.ts:24-33` asserts `lookup` is **never called** in that
  case — confirms the JWT check strictly precedes the DB lookup as required.
- **No-`users`-row case is 401, not 403**: when `lookup(clerkId)` resolves `null`,
  `requireAuth` throws `UNAUTHENTICATED`/401 (`lib/api/auth.ts:36-38`), matching the
  spec's explicit rationale ("no user record ⇒ cannot authorize ⇒ treat as
  unauthenticated, not 403"). Verified by test at `auth.test.ts:35-43`.
- **`requireRole`**: void/no-throw when role is in the allow-list array (multi-role
  case tested with `["admin", "set_leader"]`); throws `ApiException` FORBIDDEN/403
  otherwise. Matches spec exactly.
- **All four `UserRole` values** (`admin`, `set_leader`, `member`, `guest`) are
  table-driven tested against the admin-only fixture route in
  `tests/unit/app/api/admin-only-route.test.ts`, satisfying the named acceptance
  criterion. `admin` → 200 `{ data: { ok: true } }`; the other three → 403
  `FORBIDDEN`. Confirmed `types/domain.ts` declares exactly these four roles, so the
  table is exhaustive.
- **Fixture route error mapping**: `app/api/_examples/admin-only/route.ts`'s `catch`
  maps `ApiException` to `fail(err.message, err.code, err.status)` and any other
  error to `fail("Internal error", ErrorCode.INTERNAL, 500)` — no raw error/stack can
  leak. Matches spec's edge case requirement.
- **`lookup` param not part of Next's route contract**: correctly noted as an optional
  test seam; production callers get `undefined` and fall back to the real
  `lookupUserByClerkId` default, which still throws the "blocked on #16" error as
  intended (untested here since it requires real Clerk/DB context, and the spec does
  not require testing the stub's throw path).
- **Deviation noted in changes.md** (`auth as unknown as jest.Mock` instead of spec's
  `auth as jest.Mock`): confirmed necessary — this is a pure TypeScript cast-syntax
  fix required to satisfy `tsc --noEmit` (verified passing above), with no behavioral
  or test-coverage change. Both test files use the same pattern consistently.
  Acceptable as a typecheck-driven fix, not a spec violation.

## Failure case coverage

- Unauthenticated request (`userId: null`) — covered in both test files, asserts
  401/UNAUTHENTICATED and (in the fixture route test) that `lookup` is never
  consulted.
- Authenticated-but-unauthorized (role not in allow-list) — covered for all three
  non-admin roles, asserts 403/FORBIDDEN.
- Authenticated-but-no-DB-user (`lookup` resolves `null`) — covered directly against
  `requireAuth` in `auth.test.ts`.

## Overall result: PASS

No code changes needed from the coder. All claims in `.pipeline/changes.md` were
independently verified and hold up. Ready for Reviewer.
