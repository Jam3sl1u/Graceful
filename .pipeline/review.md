# Review — Issue #14: Integrate Clerk authentication (Sprint 0)

## VERDICT: SHIP

## Basis
Reviewed spec, changes.md, test-results.md, and independently ran `git diff main...HEAD`,
re-ran `bun run typecheck` and `bun run lint` (both clean), and grep-verified the
supporting facts rather than trusting the summaries.

## Spec conformance (all 4 gaps closed, exactly)
1. `middleware.ts` — no-op `clerkMiddleware()` replaced with the prescribed callback
   `if (!isPublicRoute(req)) await auth.protect();`. `isPublicRoute` list and
   `config.matcher` are byte-for-byte unchanged (confirmed in diff). Stale
   "deferred to #5/#6" comment replaced with the one-line note about #6 role checks.
2. `.env.example` — exactly the 4 public URL vars, correct values, placed after
   `CLERK_WEBHOOK_SECRET=`. No secrets added.
3. `app/(app)/profile/page.tsx` — async server component using `currentUser()`
   (not `getAuthContext`). Fallback chain `fullName || firstName || lastName || "—"`
   and `primaryEmailAddress?.emailAddress ?? "—"` — handles the email-only-signup
   edge case without crashing. Inline `<main style={{ padding: "3rem 1.5rem" }}>`
   markup matches `app/(marketing)/page.tsx`.
4. `app/api/profile/route.ts` — GET uses `auth()`, returns
   `fail("Not authenticated", ErrorCode.UNAUTHENTICATED, 401)` on null userId
   (arg order matches `fail(error, code, status)`), else `ok({ userId })`.
   `UNAUTHENTICATED` confirmed present in `lib/api/errors.ts`. PUT untouched
   (`notImplemented`). `NextRequest` import retained and still used by PUT — no
   unused imports (lint passes under strict config).

## Out-of-scope respected
`lib/clerk/server.ts`, `lib/api/auth.ts`, `app/api/webhooks/clerk/route.ts`,
`app/layout.tsx`, and `app/(auth)/**` are all untouched (empty diff stat).
No dependency, route-structure, or config changes.

## Correctness notes
- Defense-in-depth is correct: middleware `auth.protect()` fronts the route, and the
  handler's own `userId` null-check is a deterministic second-layer 401. The tester
  verified the 401 layer directly in keyless mode (does not depend on Clerk handshake).
- The one behavior not black-box verifiable in-sandbox — that browser requests redirect
  specifically to the app's own `/sign-in` — is a live-credential/deploy concern (#10),
  not a code defect. The code (`auth.protect()` gated by `isPublicRoute`, plus the
  `NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in` env var) is correct per Clerk's documented API.

## Hygiene
Working tree clean except the expected `.pipeline/` artifacts. No stray code changes,
no leftover `.clerk/` or `.env.local` from testing (tester cleaned up). Single commit
on the issue branch.

No blocking or must-fix issues. Ready to ship.
