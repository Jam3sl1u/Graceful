# Spec — Issue #76: [Sprint 4] Implement rate limiting on auth, SMS, and write endpoints

## OPEN QUESTIONS

**None blocking — do not stop the pipeline.** Two things a human should know are
recorded here because they shape the design; both already have a defensible
resolution baked into this spec.

1. **This repo has no login/signup API route to rate limit.** Verified: sign-in
   and sign-up are Clerk-hosted components (`app/(auth)/sign-in/[[...sign-in]]/page.tsx`,
   `app/(auth)/sign-up/[[...sign-up]]/page.tsx`); credential submission goes to
   Clerk's own API, not to this app, and Clerk rate-limits it. The "auth" tier in
   this spec therefore covers the app's own credential-checking surfaces — invite
   code redemption and the no-session invitation response tokens — which are the
   brute-forceable auth endpoints this codebase actually owns. If the human wants
   the Clerk-hosted `/sign-in` / `/sign-up` *page* routes throttled too, that is a
   separate decision; this spec deliberately limits only `/api/*`.
2. **Limits are in-memory, not Redis-backed.** The AC explicitly allows either.
   In-memory keeps the change dependency-free (`@upstash/redis` is present but is
   reserved for the Phase 3/4 transcription queue and its env vars are unset —
   see `lib/upstash/redis.ts`). Known limitation to state in `changes.md`: on
   serverless each instance holds its own counters, so the effective limit is
   per-instance, not global. The concrete numbers below are a first pass and are
   meant to be tuned by a human later.

## Goal

Add an application-layer rate limiter that runs in `middleware.ts` for every
`/api/*` request, with stricter tiers for SMS-triggering, auth-credential, and
write endpoints. Exceeding a limit returns `429` with a `Retry-After` header and
the repo's standard `{ error, code }` envelope. Cover it with unit tests that
prove the limit actually fires.

PRD ref: Phase 1 PRD §25.3 ("Rate limiting") and §26 ("Rate limit tests").

## Current state (verified by reading the code)

- **No rate limiting exists anywhere.** The only trace is the already-defined
  `ErrorCode.RATE_LIMITED` in `lib/api/errors.ts` (unused today).
- `middleware.ts` (repo root) is `clerkMiddleware(...)` with
  `createRouteMatcher` for public routes; its `config.matcher` already matches
  `/(api|trpc)(.*)`, so **no matcher change is needed**.
- Route files under `app/api/**/route.ts` are thin and delegate to a sibling
  `handler.ts`. Do **not** touch any of them — rate limiting is applied once, in
  middleware.
- `lib/api/response.ts` exposes `ok()` / `fail()` / `notImplemented()`. `fail()`
  cannot attach headers. **Do not modify `lib/api/response.ts`** — the 429 is
  built in the new module instead (see "server-only constraint" below).
- Unit tests live in `tests/unit/**`, run by Jest via `bun run test`
  (`jest.config.js`, `testMatch: **/tests/unit/**/*.test.ts`,
  `moduleNameMapper: ^@/(.*)$ -> <rootDir>/$1`, `server-only` mapped to
  `tests/mocks/server-only.js`). `collectCoverageFrom` already includes
  `lib/api/**/*.ts`, so no Jest config change is needed.
- SMS/email dispatch is still stubbed (`lib/pingram/client.ts`,
  `lib/resend/client.ts`), but the SMS-triggering *endpoints* exist and are
  identified by `TODO(#67/#68)` markers plus the live `sendSms` call site.

## Files

### Create

1. `lib/api/rate-limit.ts` — the limiter (all logic, pure and testable).
2. `tests/unit/lib/api/rate-limit.test.ts` — unit tests for the limiter.
3. `tests/unit/middleware.test.ts` — proves the 429 actually fires through
   `middleware.ts`.

### Modify

4. `middleware.ts` — call the limiter before anything else.

Nothing else. No new dependencies (`package.json` unchanged), no new env vars
(`.env.example` unchanged), no changes under `app/`, `schemas/`, or
`supabase/`.

---

## 1. `lib/api/rate-limit.ts`

### server-only constraint (important)

Every other `lib/**` module starts with `import "server-only"`. **This file must
NOT import `server-only`, and must not import `lib/api/response.ts`** — it is
imported by `middleware.ts`, which Next bundles for the Edge runtime, and the
repo has no existing precedent for pulling a `server-only` module into that
bundle. Add a short comment at the top of the file saying exactly that, so the
deviation from the `lib/**` convention is not read as an oversight.

It **may** import `{ ErrorCode }` from `@/lib/api/errors` (which does import
`server-only`) — this is the single source of truth for the `RATE_LIMITED`
string and duplicating the literal is worse. Verify it with `bun run build` (see
"Verification"). If and only if that build fails with a `server-only` error
originating from the middleware bundle, fall back to a local
`const RATE_LIMITED_CODE = "RATE_LIMITED"` in this file and add an assertion in
`tests/unit/lib/api/rate-limit.test.ts` that it equals `ErrorCode.RATE_LIMITED`
(the test runs under Jest, where `server-only` is mocked). Record which branch
you took in `.pipeline/changes.md`.

### Exported interface

```ts
import { NextRequest, NextResponse } from "next/server";

export type RateLimitTier = "webhook" | "sms" | "auth" | "write" | "read";

export type RateLimitPolicy = { limit: number; windowMs: number };

export type RateLimitDecision = {
  tier: RateLimitTier;
  allowed: boolean;
  limit: number;
  remaining: number;        // 0 once the limit is hit
  retryAfterSeconds: number; // integer >= 1 when denied, 0 when allowed
  resetAtMs: number;         // epoch ms at which the current window ends
};

// Tier -> policy table. Exported so tests assert the ordering invariant
// (sms < auth < write < read) instead of hardcoding numbers twice.
export const RATE_LIMIT_POLICIES: Record<RateLimitTier, RateLimitPolicy>;

// Pure path/method -> tier classification. Returns null when the request is
// exempt from rate limiting entirely.
export function resolveTier(pathname: string, method: string): RateLimitTier | null;

// Stable per-caller bucket identity.
export function getRequestIdentifier(req: NextRequest, clerkUserId: string | null): string;

// Fixed-window counter against the module-level store. `now` defaults to
// Date.now() and is injectable so tests never need fake timers.
export function checkRateLimit(
  key: string,
  policy: RateLimitPolicy,
  now?: number,
): Omit<RateLimitDecision, "tier">;

// Test-only: clears the module-level store.
export function resetRateLimitStore(): void;

// Full request-level entry point used by middleware. Returns null when the
// request is exempt. Consumes one unit of budget when it does not return null.
export function checkRequestRateLimit(
  req: NextRequest,
  clerkUserId: string | null,
  now?: number,
): RateLimitDecision | null;

// Builds the 429. Only ever called with a denied decision.
export function rateLimitResponse(decision: RateLimitDecision): NextResponse;
```

### Policies

```
webhook: { limit: 600, windowMs: 60_000 }
read:    { limit: 240, windowMs: 60_000 }
write:   { limit: 60,  windowMs: 60_000 }
auth:    { limit: 10,  windowMs: 60_000 }
sms:     { limit: 5,   windowMs: 60_000 }
```

### `resolveTier(pathname, method)` — first match wins, in this exact order

Normalize first: `const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;`
and `const verb = method.toUpperCase();`.

1. `!path.startsWith("/api/")` and `path !== "/api"` → `null` (page routes are
   never rate limited).
2. `path === "/api/health"` → `null` (uptime monitor + `tests/e2e/health.spec.ts`).
3. `path.startsWith("/api/webhooks/")` → `"webhook"`.
4. `"sms"` if any of:
   - `POST /api/invitations` (exact — create invitation, #40 SMS dispatch)
   - `POST /api/invitations/{id}/deny` (SMS + email to the admin)
   - `POST /api/setlists/{id}/publish` (member SMS/email fan-out)
   - `/api/cron/invitation-reminders` (any method — #45 reminder SMS)
5. `"auth"` if any of:
   - `POST /api/church-group/join` (invite-code brute force)
   - `GET /api/invitations/respond/{token}` (response-token brute force)
   - `POST /api/invitations/{id}/accept` (response-token brute force)
6. `verb` not in `["GET", "HEAD", "OPTIONS"]` → `"write"`.
7. otherwise → `"read"`.

`{id}` / `{token}` are single path segments — match with `[^/]+`, anchored
(`^...$`). `GET /api/invitations` (the roster list) must resolve to `"read"`,
not `"sms"` — the method is part of the rule.

### `getRequestIdentifier`

- If `clerkUserId` is a non-empty string → `` `user:${clerkUserId}` ``.
- Else derive the client IP: first comma-separated entry of the
  `x-forwarded-for` header, trimmed; if absent/empty, `x-real-ip`, trimmed; if
  that is also absent/empty, the literal `"unknown"`. Return `` `ip:${ip}` ``.

### `checkRateLimit` (fixed window)

- Module-level `const store = new Map<string, { count: number; windowStartMs: number }>()`.
- On call with `now`: if no entry, or `now - entry.windowStartMs >= policy.windowMs`,
  start a fresh window (`count = 1`, `windowStartMs = now`). Otherwise `count += 1`.
- `resetAtMs = windowStartMs + policy.windowMs`.
- `allowed = count <= policy.limit`.
- `remaining = Math.max(0, policy.limit - count)`.
- `retryAfterSeconds = allowed ? 0 : Math.max(1, Math.ceil((resetAtMs - now) / 1000))`.
- The counter increments on denied requests too, but `windowStartMs` is **never**
  moved forward by them — a blocked caller must not have its own ban extended.
- Store pruning: after writing, if `store.size > 10_000`, delete every entry
  whose `windowStartMs + windowMs` is `<= now` (use the largest configured
  `windowMs` as the sweep threshold); if the size is still `> 10_000` after the
  sweep, `store.clear()`. This keeps memory bounded.

### `checkRequestRateLimit`

`resolveTier(req.nextUrl.pathname, req.method)` → if `null`, return `null`.
Otherwise look up the policy, build the key as
`` `${tier}:${getRequestIdentifier(req, clerkUserId)}` `` (tier is part of the
key so a caller's read budget and write budget are independent), call
`checkRateLimit`, and return `{ tier, ...decision }`.

### `rateLimitResponse(decision)`

```ts
NextResponse.json(
  { error: "Rate limit exceeded", code: ErrorCode.RATE_LIMITED },
  { status: 429, headers: { "Retry-After": String(decision.retryAfterSeconds) } },
);
```

Body shape must match `types/api.ts`'s `ApiError`. `Retry-After` is the only
header to set — do not add `X-RateLimit-*` headers.

---

## 2. `middleware.ts` (modify)

Keep `isPublicRoute` and `config` exactly as they are. Inside the
`clerkMiddleware` callback, before `auth.protect()`:

```ts
export default clerkMiddleware(async (auth, req) => {
  let clerkUserId: string | null = null;
  try {
    clerkUserId = (await auth()).userId;
  } catch {
    clerkUserId = null; // malformed/expired session -> fall back to IP bucketing
  }

  const decision = checkRequestRateLimit(req, clerkUserId);
  if (decision && !decision.allowed) {
    return rateLimitResponse(decision);
  }

  if (!isPublicRoute(req)) {
    await auth.protect();
  }
});
```

Rate limiting must run **before** `auth.protect()` so an unauthenticated flood is
rejected cheaply, and it must apply to public API routes too (the invitation
token endpoints are public and are precisely what the auth tier is for).

---

## 3. Tests

### `tests/unit/lib/api/rate-limit.test.ts`

No Clerk mocks needed. Build `NextRequest`-ish fakes as plain objects cast
through `as unknown as NextRequest` (same style as `makeJsonReq` in
`tests/support/api-auth.ts`), e.g.
`{ nextUrl: { pathname }, method, headers: new Headers({ ... }) }`.
Call `resetRateLimitStore()` in `beforeEach`. Always pass an explicit `now`.

Must cover:
- **Happy path**: requests 1..N of an N-limit policy are all `allowed`, with
  `remaining` counting down to 0.
- **Limit fires (the AC's required case)**: request N+1 is `allowed === false`,
  `remaining === 0`, `retryAfterSeconds >= 1`.
- **429 shape**: `rateLimitResponse(denied)` has `status === 429`,
  `headers.get("Retry-After")` parses to an integer `>= 1`, and the JSON body is
  `{ error: <string>, code: "RATE_LIMITED" }`.
- **Window rollover**: at `now = windowStart + windowMs` the caller is allowed
  again and `remaining` resets.
- **Denied requests do not extend the window**: hammer past the limit, then
  assert `resetAtMs` is unchanged from the first denial and the caller is allowed
  again at the original `resetAtMs`.
- **Tier isolation**: exhausting `sms` for an identity still allows that
  identity's `read` requests (separate keys), and two different identities do not
  share a bucket.
- **`resolveTier` table**, at minimum: `POST /api/invitations` → `sms`;
  `GET /api/invitations` → `read`; `POST /api/invitations/<uuid>/deny` → `sms`;
  `POST /api/invitations/<uuid>/accept` → `auth`;
  `GET /api/invitations/respond/<token>` → `auth`;
  `POST /api/church-group/join` → `auth`;
  `POST /api/setlists/<uuid>/publish` → `sms`;
  `GET /api/cron/invitation-reminders` → `sms`;
  `POST /api/webhooks/clerk` → `webhook`; `PATCH /api/profile` → `write`;
  `DELETE /api/events/<uuid>` → `write`; `GET /api/events` → `read`;
  `GET /api/health` → `null`; `GET /dashboard` → `null`;
  trailing slash (`/api/health/`) → `null`; lowercase method (`post`) is
  classified the same as `POST`.
- **Identifier**: signed-in user → `user:<id>`; anonymous with
  `x-forwarded-for: "1.2.3.4, 5.6.7.8"` → `ip:1.2.3.4`; anonymous with only
  `x-real-ip` → that IP; anonymous with neither → `ip:unknown`.
- **Policy ordering invariant**: `sms.limit < auth.limit < write.limit < read.limit`.

### `tests/unit/middleware.test.ts`

Proves the limit fires through the real middleware. Mock Clerk:

```ts
jest.mock("@clerk/nextjs/server", () => ({
  clerkMiddleware: (handler: unknown) => handler,
  createRouteMatcher: () => () => true, // treat everything as public
}));
```

With `clerkMiddleware` as the identity function, the default export *is* the
handler, so call it as `middleware(authFn, req)` where `authFn` is
`Object.assign(async () => ({ userId: null }), { protect: jest.fn() })`.

Must cover:
- Requests within the `sms` limit to `POST /api/invitations` are not 429 (the
  handler returns `undefined` when it falls through — assert it is not a 429
  response rather than asserting an exact value).
- The first request past the `sms` limit returns status `429` with a
  `Retry-After` header and `code: "RATE_LIMITED"`.
- `GET /api/health` never 429s no matter how many times it is called.
- Call `resetRateLimitStore()` in `beforeEach` so tests do not leak counters into
  each other.

---

## Edge cases the implementation must handle

1. Trailing slashes on the pathname must not change the tier.
2. Method casing must not change the tier.
3. Query strings are irrelevant — always classify on `req.nextUrl.pathname`.
4. Missing/blank `x-forwarded-for` **and** `x-real-ip` → the shared
   `ip:unknown` bucket (accepted trade-off; note it in a code comment).
5. `x-forwarded-for` with multiple hops → use the first entry only.
6. `await auth()` throwing must not 500 the request — fall back to IP bucketing.
7. `retryAfterSeconds` must never be `0` or fractional on a denial.
8. Denied requests increment the counter but must not slide the window forward.
9. The store must stay bounded (pruning rule above).
10. Non-`/api` page navigations must never be rate limited.
11. `GET /api/invitations` (roster read) must not fall into the `sms` tier.

## Verification

Run all of these from the repo root and report results in `.pipeline/changes.md`:

- `bun run typecheck`
- `bun run lint`
- `bun run test`
- `bun run build` — required for this issue specifically, because `middleware.ts`
  is bundled at build time and neither Jest nor CI would catch a middleware
  bundling failure. If the build fails for reasons unrelated to rate limiting
  (e.g. missing Clerk/Supabase env vars in this environment), say so explicitly in
  `changes.md` and move on; if it fails with a `server-only` error from the
  middleware bundle, apply the documented fallback in §1.

## Out of scope

- Redis/Upstash-backed distributed counters.
- Any DDoS protection above the application layer (Vercel/Cloudflare).
- Throttling the Clerk-hosted `/sign-in` / `/sign-up` page routes.
- Per-user transcription job-submission limits (Phase 3, PRD §25.4).
- Changes to any `app/api/**` route or handler.
- The broader rate-limit test suite tracked separately as #81 — this issue ships
  only the unit tests listed above.
