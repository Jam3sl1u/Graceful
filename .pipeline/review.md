# Review — Issue #15: JWT verification + role-check middleware

VERDICT: SHIP

## Scope & branch
Branch `issue-15-jwt-verification-role-check-middleware`, commit 660fff0.
Diff reviewed firsthand via `git diff main...HEAD` — not trusted from summaries.

## What was verified independently
- `bun run test` — 3 suites / 13 tests pass (re-run, not trusted).
- `bun run typecheck` — clean.
- Cross-checked `lib/api/errors.ts`, `types/domain.ts`, `lib/api/response.ts`
  against the implementation and test assertions.

## Correctness assessment (genuinely critical pass)
- **Auth-before-lookup ordering** is real, not just claimed: `requireAuth` calls
  `auth()` and throws 401 before touching `lookup`. The test asserts
  `lookup` is never called on the null-userId path — meaningful, not superficial.
- **401 vs 403 distinction** is implemented as specified: no `users` row → 401
  UNAUTHENTICATED (not 403). Rationale documented; matches spec.
- **`requireRole`** uses `roles.includes(ctx.role)`; multi-role allow-list is
  actually exercised (`["admin","set_leader"]`), not just single-role.
- **Response envelope match**: `fail()` returns `{ error, code }` and `ok()`
  returns `{ data }`. Route test asserts `body.code === "FORBIDDEN"` and
  `body === { data: { ok: true } }` — both consistent with the real envelope.
  This is a place a superficial test could have been wrong; it is correct.
- **All four UserRole values** (`admin`/`set_leader`/`member`/`guest`) are
  table-driven and exhaustive against `types/domain.ts`. Confirmed the union
  has exactly these four members, so the table is complete.
- **Error-mapping in fixture**: `catch` maps `ApiException` → `fail(...)` and any
  other throw → 500 INTERNAL. No raw stack can escape.
- **`ErrorCode.UNAUTHENTICATED`/`FORBIDDEN`/`INTERNAL`** all exist in errors.ts.

## Deviations
- `auth as unknown as jest.Mock` instead of the spec's `auth as jest.Mock`.
  Confirmed this is a required typecheck fix (Clerk's `auth` type does not
  overlap `jest.Mock`), purely cast syntax, no behavioral change. Acceptable.

## Scope discipline
- Only `lib/api/auth.ts` (modified), `app/api/_examples/admin-only/route.ts`
  (new), and the two new test files touched (plus `.pipeline/spec.md`).
- `middleware.ts`, `lib/supabase/*`, `lib/clerk/server.ts`, existing routes —
  untouched, matching Definition of Done.
- `lookupUserByClerkId` remains the single deferred stub for #16, with the
  TODO(#16) SQL comment present. Correct.

## Residual notes (non-blocking, for follow-up issues — NOT fixes for #15)
- The real `lookupUserByClerkId` throw path is not unit-tested. Spec explicitly
  does not require it (needs real Clerk/DB context). Fine for #15; #16 must add
  the real impl + its test.
- Middleware enforcement wiring is intentionally out of scope; nothing enforces
  `requireAuth` on real routes yet. Tracked elsewhere per spec — acceptable.

Green tests here reflect correct behavior, not just passing assertions. Ship it.
