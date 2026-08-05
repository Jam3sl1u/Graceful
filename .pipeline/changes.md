# Changes — Issue #76: Rate limiting on auth, SMS, and write endpoints

## Files created

- **`lib/api/rate-limit.ts`** — the limiter, all pure/testable logic:
  - `RATE_LIMIT_POLICIES` (webhook 600/min, read 240/min, write 60/min, auth
    10/min, sms 5/min).
  - `resolveTier(pathname, method)` — classifies any `/api/*` request into
    `webhook | sms | auth | write | read | null` per the exact precedence
    order in the spec (health/page exemptions first, then webhooks, then the
    named SMS-triggering routes, then the named auth-brute-force routes,
    then non-GET/HEAD/OPTIONS → write, else read). Normalizes trailing
    slashes and method casing before matching.
  - `getRequestIdentifier(req, clerkUserId)` — `user:<id>` for signed-in
    callers, else `ip:<first x-forwarded-for hop>`, else `ip:<x-real-ip>`,
    else the shared `ip:unknown` bucket (documented trade-off).
  - `checkRateLimit(key, policy, now?)` — fixed-window counter against a
    module-level `Map`. Denied requests still increment the counter but
    never move `windowStartMs` forward (so a blocked caller's own window
    isn't extended). Store is pruned once it exceeds 10,000 entries (sweep
    stale entries using the largest configured `windowMs`, then
    `store.clear()` if still oversized).
  - `checkRequestRateLimit(req, clerkUserId, now?)` — the middleware entry
    point; returns `null` for exempt requests, otherwise resolves tier +
    policy, builds the `${tier}:${identifier}` key, and returns a full
    `RateLimitDecision`.
  - `rateLimitResponse(decision)` — builds the `429` with `{ error, code:
    "RATE_LIMITED" }` body and a single `Retry-After` header.
  - `resetRateLimitStore()` — test-only store reset.

  **Server-only branch taken**: the spec's primary path (importing
  `{ ErrorCode }` from `@/lib/api/errors`, which itself is `server-only`
  tagged) was verified via `bun run build`. The build **compiled
  successfully** (middleware bundling completed with no `server-only`
  error) before failing later, during static page generation, on a
  pre-existing/unrelated issue (see "Build" below). So the primary path was
  kept — no fallback `const RATE_LIMIT_CODE` literal was needed. A comment
  at the top of the file documents the deviation from the `lib/**`
  `server-only` convention as the spec requires.

- **`tests/unit/lib/api/rate-limit.test.ts`** — unit tests covering:
  happy path (remaining counts down to 0), limit firing on request N+1,
  the 429 shape (`status`, integer `Retry-After`, JSON envelope), window
  rollover, "denied requests do not extend the window" (asserts
  `resetAtMs` is unchanged across repeated denials and the caller is
  allowed again exactly at the original `resetAtMs`), tier isolation
  (`sms` exhaustion doesn't touch `read`) and identity isolation (two
  different identities don't share a bucket), the full `resolveTier` table
  from the spec (including trailing slash, lowercase method, and the
  `GET /api/invitations` → `read` vs `POST /api/invitations` → `sms`
  distinction), `getRequestIdentifier` for all four cases (`user:`,
  first-hop XFF, `x-real-ip` fallback, `ip:unknown`), and the
  `sms < auth < write < read` policy-ordering invariant.

- **`tests/unit/middleware.test.ts`** — proves the 429 fires through the
  real `middleware.ts` with Clerk mocked as an identity function
  (`clerkMiddleware: (handler) => handler`, `createRouteMatcher: () => ()
  => true`). Covers: requests within the `sms` limit to
  `POST /api/invitations` are not `429`; the first request past the `sms`
  limit is `429` with a parsable integer `Retry-After` and
  `code: "RATE_LIMITED"`; `GET /api/health` never `429`s regardless of call
  count. `resetRateLimitStore()` runs in `beforeEach` so tests don't leak
  counters into each other.

## Files modified

- **`middleware.ts`** — `isPublicRoute` and `config.matcher` are untouched
  (matcher already covers `/(api|trpc)(.*)`). Inside the `clerkMiddleware`
  callback, before the existing `auth.protect()` call: resolves
  `clerkUserId` from `await auth()` (catching and falling back to `null`/IP
  bucketing if it throws on a malformed/expired session), calls
  `checkRequestRateLimit(req, clerkUserId)`, and returns
  `rateLimitResponse(decision)` immediately if the decision is non-null and
  denied — before the `isPublicRoute` check, so unauthenticated floods
  (including the public invitation-token endpoints) are rejected cheaply
  pre-auth.

Nothing under `app/`, `schemas/`, or `supabase/` was touched. No new
dependencies or env vars were added; `package.json` and `.env.example` are
unchanged. `.pipeline/spec.md` was already updated by the Planning stage
before this run started (not touched further here).

## Known limitation (carried from spec's OPEN QUESTIONS, non-blocking)

Rate limiting is in-memory (module-level `Map`), not Redis-backed. On
serverless/multi-instance deployments each instance holds its own counters,
so the effective limit is per-instance, not global. The concrete limits
(webhook 600, read 240, write 60, auth 10, sms 5, all per 60s) are a first
pass meant to be tuned by a human later.

## Verification

- `bun run typecheck` — **pass**, no errors.
- `bun run lint` — **pass**, no errors (initial `@typescript-eslint/no-explicit-any`
  failures in `middleware.test.ts` were fixed by giving the mocked handler an
  explicit type instead of casting through `any`).
- `bun run test` — **pass**, 84 suites / 1084 tests total, including the 2
  new test files added here.
- `bun run build` — compiles successfully (Next reports "Compiled
  successfully"), confirming `middleware.ts`'s new import of
  `lib/api/rate-limit.ts` (and its transitive import of
  `lib/api/errors.ts`, which is `server-only` tagged) bundles fine for the
  Edge runtime with **no `server-only` error**. The build then fails later,
  during static page generation of `/conflicts` (and other app pages), with
  `Error: @clerk/clerk-react: Missing publishableKey` — this is a
  pre-existing environment issue (no Clerk env vars are configured in this
  sandbox), **not** caused by this change. Confirmed by stashing this
  branch's diff and re-running `bun run build` against the unmodified
  baseline: it fails at the exact same static-generation step with the
  same missing-publishableKey error (on `/_not-found` instead of
  `/conflicts` — which page prerenders first varies, but the root cause is
  identical). No fallback branch (local `RATE_LIMITED_CODE` constant) was
  needed.

## What the Tester should focus on

- The `resolveTier` precedence order, especially that `GET /api/invitations`
  resolves to `read` (not `sms`) while `POST /api/invitations` resolves to
  `sms` — method matters, not just path.
- The "denied requests do not extend the window" behavior — this is the
  subtlest part of the fixed-window implementation and is easy to get wrong
  in a way that either bans callers forever or lets them reset their own
  window by continuing to hammer it.
- That the store-pruning threshold (10,000 keys) and `ip:unknown` shared
  bucket are deliberate, documented trade-offs, not bugs.
- `middleware.ts`'s Clerk `auth()` failure fallback (`try/catch` around
  `await auth()`) — verify it degrades to IP bucketing rather than
  throwing/500ing.
