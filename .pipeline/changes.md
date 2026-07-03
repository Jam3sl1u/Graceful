# Changes — Issue #14: Integrate Clerk authentication (Sprint 0)

## What changed

1. **`middleware.ts`**
   - Replaced the no-op `export default clerkMiddleware();` with a callback that calls `await auth.protect()` for any request that doesn't match `isPublicRoute`.
   - Removed the stale "enforcement deferred" comment block and replaced it with a one-line note that request-level auth is enforced here while role-level checks (`requireRole`) still land in #6.
   - `isPublicRoute` matcher and `config.matcher` left untouched.

2. **`.env.example`**
   - Added four new public Clerk env vars under the existing `# Clerk (Auth)` block: `NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in`, `NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up`, `NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL=/dashboard`, `NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL=/dashboard`, so Clerk routes to the app's own sign-in/up pages instead of the hosted account portal.

3. **`app/(app)/profile/page.tsx`**
   - Converted the static `<h1>Profile — coming soon</h1>` stub into an async server component that calls `currentUser()` from `@clerk/nextjs/server` and renders the user's name (falls back through `fullName` -> `firstName` -> `lastName` -> `"—"`) and primary email (`primaryEmailAddress?.emailAddress ?? "—"`).
   - Follows the inline-style `<main>` markup pattern from `app/(marketing)/page.tsx`. No new components/CSS.
   - Does not use `lib/clerk/server.ts`'s `getAuthContext` (left untouched, out of scope).

4. **`app/api/profile/route.ts`**
   - Implemented `GET` to call `auth()` from `@clerk/nextjs/server`, returning `fail("Not authenticated", ErrorCode.UNAUTHENTICATED, 401)` when `userId` is null, otherwise `ok({ userId })`.
   - `PUT` left exactly as-is (`notImplemented("PUT /api/profile")`).
   - Removed the now-unused `_req: NextRequest` param from `GET` (kept the `NextRequest` import since `PUT` still uses it).

## Out of scope (untouched, per spec)
- `lib/clerk/server.ts` (`getAuthContext`) and `lib/api/auth.ts` (`requireAuth`/`requireRole`) — unchanged.
- `app/api/webhooks/clerk/route.ts` — unchanged, still `notImplemented`.
- `app/(auth)/sign-in`, `app/(auth)/sign-up` pages, `app/layout.tsx` `<ClerkProvider>` — unchanged, already correct.
- No dependency, route-structure, or other config changes.

## Verification performed
- `bun run lint` — passes (no warnings/errors).
- `bun run typecheck` — passes.
- `bun run test` (jest unit tests) — all 3 existing tests pass (`tests/unit/lib/api/response.test.ts`).
- Did not run `bun run test:e2e` (Playwright) — requires a running dev server / Clerk env keys; left for the tester stage per the spec's "Suggested verification" section.

## Focus for the tester
- Confirm unauthenticated `GET /api/profile` returns 401 with `ErrorCode.UNAUTHENTICATED` (or that middleware's `auth.protect()` intercepts it first with a redirect/404, per Clerk's behavior for API vs. browser requests).
- Confirm unauthenticated browser GET to a protected page (e.g. `/dashboard`, `/profile`) redirects toward `/sign-in`.
- Confirm public routes (`/`, `/sign-in(.*)`, `/sign-up(.*)`, `/join(.*)`, `/invite(.*)`, `/api/health`, `/api/webhooks(.*)`) remain reachable while signed out.
- Confirm the profile page renders gracefully with `"—"` fallbacks when Clerk user has no name (email-only signup) — cannot be fully exercised without live Clerk test data, so reasoning-based review of the fallback logic in `app/(app)/profile/page.tsx` may be needed.
