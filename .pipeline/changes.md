# Changes — Issue #15: JWT verification + role-check middleware

## Files changed

- `lib/api/auth.ts` (rewrite of the two stubs)
  - Implemented `requireAuth(req, lookup = lookupUserByClerkId)`:
    1. Calls Clerk's `auth()` to get `clerkId`. Throws `ApiException("Authentication
       required", ErrorCode.UNAUTHENTICATED, 401)` if null/undefined — this check
       strictly precedes any DB lookup.
    2. Calls the injected `lookup(clerkId)`. Throws the same 401 UNAUTHENTICATED
       (not 403) if it resolves to `null` (Clerk-authenticated user with no matching
       `users` row).
    3. Returns the resolved `AuthContext`.
  - Implemented `requireRole(ctx, roles)`: returns void if `roles.includes(ctx.role)`,
    otherwise throws `ApiException("Insufficient permissions", ErrorCode.FORBIDDEN, 403)`.
  - Added the `UserLookup` type (`(clerkId: string) => Promise<AuthContext | null>`) as
    the lookup seam called out in the spec's open question — real `users` table query
    is blocked on #16, so `lookupUserByClerkId` (kept internal/unexported) throws
    `"user lookup not implemented — blocked on #16 ..."` and carries a
    `// TODO(#16): SELECT id, church_group_id, role FROM users WHERE clerk_id = $1`
    comment. It is the default `lookup` argument; tests inject a fake instead.
  - `AuthContext` shape (`{ userId, churchGroupId, role }`) unchanged.

## Files created

- `app/api/_examples/admin-only/route.ts` — minimal example admin-only `GET` route
  (per spec verbatim) that calls `requireAuth` then `requireRole(ctx, ["admin"])`,
  wrapping `ApiException` into `fail()` and any other error into a 500 `INTERNAL`.
  Takes an optional `lookup` test seam parameter (unused by Next's route contract in
  production, where it's `undefined` and the real default lookup applies). Exists only
  to support #15's unit tests, not a product endpoint (`_examples` prefix).

- `tests/unit/lib/api/auth.test.ts` — unit tests for `requireAuth`/`requireRole`
  directly, mocking `@clerk/nextjs/server`'s `auth`:
  - 401 UNAUTHENTICATED when Clerk `userId` is null (lookup never called).
  - 401 UNAUTHENTICATED when Clerk `userId` is set but injected lookup returns null.
  - Returns the injected lookup's `AuthContext` when Clerk `userId` is set.
  - `requireRole` no-op when role is in the allow-list.
  - `requireRole` throws `ApiException` (`FORBIDDEN`, 403) when role is not allowed.

- `tests/unit/app/api/admin-only-route.test.ts` — table-driven test importing `GET`
  from the fixture route, covering all four `UserRole` values (`admin` → 200,
  `set_leader`/`member`/`guest` → 403 `FORBIDDEN`), plus the `auth()` returning
  `{ userId: null }` case → 401 `UNAUTHENTICATED` (lookup never consulted). This
  satisfies the "unit tests cover all four roles against an admin-only route"
  acceptance criterion.

## Deviation from spec (typecheck-driven, non-functional)

The spec's test snippet used `const mockAuth = auth as jest.Mock;`. `tsc --noEmit`
rejected this direct cast (Clerk's `auth` export type doesn't sufficiently overlap
with `jest.Mock`). Used `auth as unknown as jest.Mock` instead in both test files —
purely a cast-syntax fix to satisfy `npm run typecheck`; no behavioral change and no
scope added.

## Verification performed

- `bun run typecheck` — passes.
- `bun run test` — all 3 suites / 13 tests pass, including the two new files and the
  pre-existing `tests/unit/lib/api/response.test.ts`.
- `bun run lint` — clean.

## Out of scope / untouched (per spec)

- `middleware.ts`, `lib/supabase/*`, `lib/clerk/server.ts` — not modified.
- No existing route handlers converted to use `requireAuth`/`requireRole`.
- No `users` table / migration work (#16) — `lookupUserByClerkId` remains an
  intentional stub pending that issue.

## What the Tester should focus on

- Confirm the 401-vs-403 distinction: authenticated-but-no-`users`-row is 401
  (`UNAUTHENTICATED`), only a resolved user with a disallowed role is 403
  (`FORBIDDEN`).
- Confirm `requireAuth` never invokes `lookup` when Clerk `auth()` returns no
  `userId` (ordering: JWT check strictly before DB lookup).
- Confirm the `app/api/_examples/admin-only/route.ts` fixture's `catch` maps any
  non-`ApiException` to a 500 `INTERNAL` response rather than leaking a raw error.
- The `auth as unknown as jest.Mock` cast deviation above — confirm it's acceptable
  as a typecheck fix rather than a spec violation.
