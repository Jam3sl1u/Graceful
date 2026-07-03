# Spec — Issue #14: Integrate Clerk authentication (Sprint 0)

## OPEN QUESTIONS
None blocking. Two clarifying notes (proceed with the stated default):

1. **Scope boundary with #15 / #5 / #6.** This issue is *base authentication only*: Clerk sign-up/sign-in flows, session availability, redirect of signed-out users, and reading basic profile (email/name) from the Clerk session. JWT verification middleware for API routes (#15), and church-group/role resolution (#5/#6) are explicitly downstream and MUST NOT be implemented here. Do **not** touch the role/church-group TODOs in `lib/api/auth.ts` or `lib/clerk/server.ts`.
2. **Acceptance criterion "session/JWT usable by API routes."** For this issue, "usable" means the Clerk session reaches API route handlers (i.e. `auth()` from `@clerk/nextjs/server` resolves a `userId` inside a route). Full signature-verified middleware enforcement is #15. Deliver the minimal proof: one API route that returns the caller's `userId` (or 401 if signed out).

## Current state (already done — do NOT recreate)
- `@clerk/nextjs@^6.12.0` is installed (`package.json`). No dependency changes needed.
- `<ClerkProvider>` already wraps the app in `app/layout.tsx`.
- `app/(auth)/sign-in/[[...sign-in]]/page.tsx` renders `<SignIn />`; `app/(auth)/sign-up/[[...sign-up]]/page.tsx` renders `<SignUp />`. These are the Clerk-default flows the issue asks for — leave as-is.
- `middleware.ts` runs `clerkMiddleware()` with a correct `config.matcher` and an `isPublicRoute` matcher — but does **not** enforce auth yet (it calls `clerkMiddleware()` with no callback).
- Clerk env placeholders exist in `.env.example` (`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `CLERK_WEBHOOK_SECRET`).

## Gaps to close (the actual work — 4 changes)

### 1. Enforce authentication in middleware (redirect signed-out users)
**File:** `middleware.ts` (modify)

Replace the no-op `export default clerkMiddleware();` (line 20) with a callback that protects every non-public route:

```ts
export default clerkMiddleware(async (auth, req) => {
  if (!isPublicRoute(req)) {
    await auth.protect();
  }
});
```

- Keep the existing `isPublicRoute` matcher (lines 10–18) and `config.matcher` (lines 22–24) exactly as-is.
- Remove the now-stale comment block (lines 3–9) that says enforcement is deferred to #5/#6 — we are enabling it now. Replace it with a one-line comment noting that request-level auth is enforced here while role-level checks (`requireRole`) still land in #6.
- Effect: `auth.protect()` redirects unauthenticated browser requests to the Clerk sign-in and returns 404 for unauthenticated API requests. Satisfies "signed-out users are redirected away from authenticated routes."

### 2. Point Clerk at the app's own sign-in/up routes
**File:** `.env.example` (modify)

Under the existing `# Clerk (Auth)` block (after line 12, `CLERK_WEBHOOK_SECRET=`), add these public env vars so Clerk uses the in-app `/sign-in` and `/sign-up` routes rather than the hosted account portal. Give the URL vars concrete route values (they are paths, not secrets):

```
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL=/dashboard
NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL=/dashboard
```

`/dashboard` exists at `app/(app)/dashboard/page.tsx` and is a protected route, so a freshly-authenticated user lands there. Match the file's placeholder style (`# fill in later`-type comments not required for these path values).

### 3. Expose basic profile data from the Clerk session (email + name)
**File:** `app/(app)/profile/page.tsx` (modify — currently the static stub `<h1>Profile — coming soon</h1>`)

Convert to an async server component that reads the current user from Clerk and renders their name and primary email, proving profile data is available from the session:

```tsx
import { currentUser } from "@clerk/nextjs/server";

export default async function ProfilePage() {
  const user = await currentUser();
  // Guaranteed non-null because middleware protects this route; guard anyway.
  // Render: name (user.fullName, falling back to firstName/lastName, then "—")
  //         and email (user.primaryEmailAddress?.emailAddress ?? "—").
}
```

- Use `currentUser()` from `@clerk/nextjs/server`. Do **NOT** use `lib/clerk/server.ts`'s `getAuthContext` — it intentionally throws until #5/#6.
- Minimal markup only. Follow the inline-style `<main>` pattern in `app/(marketing)/page.tsx`. No new UI components, no CSS module. Polish is out of scope.

### 4. Prove the session reaches API routes
**File:** `app/api/profile/route.ts` (modify — currently returns `notImplemented` for GET and PUT)

Implement **only** the `GET` handler to return the authenticated caller's `userId` from the Clerk session. Leave `PUT` exactly as-is (`notImplemented` — profile mutation is out of scope for #14).

```ts
import { auth } from "@clerk/nextjs/server";
import { ok, fail } from "@/lib/api/response";
import { ErrorCode } from "@/lib/api/errors";

export async function GET() {
  const { userId } = await auth();
  if (!userId) return fail("Not authenticated", ErrorCode.UNAUTHENTICATED, 401);
  return ok({ userId });
}
```

- Use `ErrorCode.UNAUTHENTICATED` (confirmed to exist in `lib/api/errors.ts`). Do NOT invent new codes.
- Use the existing helpers from `lib/api/response.ts`: `ok(data, status?)` and `fail(error, code, status)`.
- Keep the `import { NextRequest }` line only if `PUT` still needs it; `GET` here takes no args. Ensure no unused imports remain (lint is strict).
- Do NOT call `requireAuth` from `lib/api/auth.ts` — it throws until #6. Reading `auth()` directly is the #14-scoped proof.

## Edge cases the implementation must handle
- Signed-out browser request to a protected route (`/dashboard`, `/profile`, etc.) -> redirected to `/sign-in` by middleware.
- Signed-out request to `GET /api/profile` -> middleware `auth.protect()` handles it; the handler's own `userId` null-check returns a clean 401 as a second layer.
- Public routes stay reachable while signed out — verify `isPublicRoute` list is unchanged: `/`, `/sign-in(.*)`, `/sign-up(.*)`, `/join(.*)`, `/invite(.*)`, `/api/health`, `/api/webhooks(.*)`.
- `currentUser()` returning a user with no name (Clerk allows email-only signup): the profile page must not crash — fall back gracefully (show email only / `—`) when `fullName`/`firstName`/`lastName` are null.
- Missing Clerk env keys at runtime is a deploy/config concern (#10), not a code concern — do not add runtime key-presence guards.

## Patterns to follow
- API route + response helpers: `lib/api/response.ts` (signatures) and `lib/api/errors.ts` (codes). Any existing `app/api/*` route using `ok`/`fail` shows the shape.
- Server component reading Clerk: `@clerk/nextjs/server` (`auth`, `currentUser`) — same package already imported in `middleware.ts`.
- Minimal inline-style markup: `app/(marketing)/page.tsx`.
- Env placeholder style: existing `# Clerk (Auth)` block in `.env.example`.

## Explicitly OUT OF SCOPE (do not implement)
- Any change to `lib/clerk/server.ts` (`getAuthContext`) or `lib/api/auth.ts` (`requireAuth`/`requireRole`) — that is #5/#6.
- JWT signature verification / claim extraction beyond `auth()`'s built-in resolution — that is #15.
- Clerk webhook (`app/api/webhooks/clerk/route.ts`) user-sync — leave as `notImplemented`.
- Custom-branded auth UI, social providers, password reset (Clerk defaults only).
- `PUT /api/profile` implementation.
- Any change to route structure, dependencies, or config files.

## Suggested verification (for the tester stage)
- `bun run lint` and `bun run typecheck` must pass.
- Playwright (fixture style in `tests/e2e/health.spec.ts`): unauthenticated `GET /api/profile` returns 401 (or a redirect/404 from middleware); unauthenticated GET of a protected page redirects toward `/sign-in`.
