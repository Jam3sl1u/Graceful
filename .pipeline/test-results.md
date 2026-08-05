# Test Results — Issue #76: Rate limiting on auth, SMS, and write endpoints

## Verdict: PASS

All checks below were re-run independently in this worktree
(`/Users/jamesliu/Documents/Graceful/.claude/worktrees/issue-76`), not just
taken on the Coder's word.

## Commands re-run

- `bun run typecheck` — **pass**, no errors.
- `bun run lint` — **pass**, no errors.
- `bun run test` (full suite, after adding the two supplemental test files
  below) — **pass**: 86 suites / 1093 tests, 0 failures.
- `bun run build` — reproduced the Coder's claim exactly: Next reports
  "Compiled successfully" (proving `middleware.ts`'s new import of
  `lib/api/rate-limit.ts`, and its transitive import of the `server-only`
  `lib/api/errors.ts`, bundles fine for the Edge runtime — no `server-only`
  error). The build then fails later, during static generation of
  `/_not-found`, with `Error: @clerk/clerk-react: Missing publishableKey`.
  Confirmed this is a pre-existing environment gap, not caused by this
  change: no `.env` file exists in this worktree (only `.env.example`), so
  no Clerk keys are configured in this sandbox regardless of branch. Not a
  regression.

## Coder's own tests — re-read and re-run

- `tests/unit/lib/api/rate-limit.test.ts` and `tests/unit/middleware.test.ts`
  were read in full and executed. They pass and, on inspection, genuinely
  cover what `changes.md` claims: happy path counting down to 0, the N+1
  denial (limit-fires / required failure case), the 429 shape, window
  rollover, "denied requests don't extend the window" (checked via
  `resetAtMs` equality across repeated denials plus an allow exactly at the
  original `resetAtMs`), tier/identity isolation, the full `resolveTier`
  precedence table (including the `GET` vs `POST /api/invitations`
  distinction, trailing slash, lowercase method), all four
  `getRequestIdentifier` branches, the policy-ordering invariant, and the
  real end-to-end 429 through `middleware.ts` with Clerk mocked.

## Independent tests added by this stage

Two new files were written from scratch (not modifications to the Coder's
tests), specifically to probe claims and edge cases the existing suite left
unexercised, per the repo's existing "tester-supplement" convention (see
e.g. `tests/unit/app/api/cron-invitation-reminders-route-tester-supplement.test.ts`):

### `tests/unit/middleware-tester-supplement.test.ts`

The Coder's `middleware.test.ts` mocks `authFn` to always resolve
`{ userId: null }` (never throws) and mocks `createRouteMatcher` to always
report "public" (so `auth.protect()` is never asserted). That left two
spec-required behaviors completely untested:

1. **"`await auth()` throwing must not 500, and must fall back to IP
   bucketing"** (spec edge case #6, and explicitly called out in
   `changes.md`'s "what the Tester should focus on"). Added a throwing
   `authFn` and confirmed: no exception escapes `middleware()`, the request
   still gets IP-bucketed and correctly 429s once the `sms` limit is
   exceeded for that IP, and two different IPs both hitting a throwing
   `auth()` get independent budgets (not a shared bucket).
2. **`auth.protect()` still fires for allowed requests on protected
   (non-public) routes, but not for denied ones** — verified by mocking
   `createRouteMatcher` to report "not public" and asserting `protect` is
   called once for an allowed request, and that the call count does not
   grow on the request that gets rate-limited (proving the 429
   short-circuits before the auth gate, as the spec requires: "rate
   limiting must run before auth.protect()").

All 4 tests in this file pass. (One assertion in a first draft of this file
was itself wrong — it asserted `protect` was never called across a loop
that included allowed calls before the denial; fixed to compare the call
count immediately before/after the denied call specifically. Noting this
because it was this stage's own test bug, not a code bug.)

### `tests/unit/lib/api/rate-limit-tester-supplement.test.ts`

The Coder's tier/identity-isolation tests use hand-built keys (e.g.
`"sms:user:1"`) rather than exercising the real key construction inside
`checkRequestRateLimit`. Added:

1. A test that calls `checkRequestRateLimit` twice for the *same* identity
   across two different tiers (`write` then `read`) and confirms exhausting
   `write` does not touch `read` — this is the only test in the whole suite
   that would catch a regression where the `${tier}:${identifier}` key
   prefix was dropped (e.g. keying purely by identifier).
2. Blank-but-present header edge cases (`x-forwarded-for: ""`, and
   `x-forwarded-for: ""` + `x-real-ip: ""` together) — spec edge case #4
   says "missing/blank", but the Coder's suite only tests the
   header-absent-entirely case.
3. Query-string irrelevance — confirms two requests sharing a pathname but
   differing only in unrelated request identity still land in the same
   bucket (classification only ever reads `nextUrl.pathname`).
4. Empty-string `clerkUserId` (as opposed to `null`/`undefined`) correctly
   falls back to IP bucketing rather than producing `user:`.

All 5 tests in this file pass.

## Manual/code review verification

- Confirmed `ErrorCode.RATE_LIMITED` exists in `lib/api/errors.ts` and
  `rateLimitResponse`'s body shape (`{ error: string; code: string }`)
  matches `types/api.ts`'s `ApiError`.
- Confirmed `middleware.ts` calls `checkRequestRateLimit` and returns
  `rateLimitResponse(decision)` **before** the `isPublicRoute` check, so
  public invitation-token endpoints are still rate-limited pre-auth, as the
  spec requires.
- Confirmed `resolveTier`'s regexes (`RESPOND_TOKEN_RE`,
  `INVITATION_ID_ACCEPT_RE`, `INVITATION_ID_DENY_RE`, `SETLIST_PUBLISH_RE`)
  are anchored (`^...$`) and use `[^/]+` for the id/token segment, matching
  the spec.
- Confirmed the store-pruning code path (`pruneStoreIfNeeded`) matches the
  spec's algorithm (sweep by `MAX_CONFIGURED_WINDOW_MS`, then `clear()` if
  still oversized). This was not independently re-tested at the 10,000-key
  threshold: the module doesn't export the store or its size, so the only
  way to assert pruning behavior from outside would be a slow
  10,000+-iteration test with no externally observable pass/fail signal
  beyond "didn't crash" (pruning has no behavioral effect visible through
  the public API — `checkRateLimit` already resets stale windows on access
  regardless of whether the entry was swept). Judged not worth the ~10k-key
  test given it can't actually distinguish "pruned correctly" from "pruned
  incorrectly" without a store-size accessor. Flagging this as a residual
  gap for the Reviewer rather than silently skipping it.

## Failure case coverage (required by the pipeline contract)

At least one failure case was independently verified, beyond the Coder's
own "limit fires" test:
- `middleware-tester-supplement.test.ts`'s throwing-`auth()` tests exercise
  the failure path of an upstream dependency (Clerk) and confirm the system
  degrades (IP bucketing + eventual 429) instead of failing closed with a
  500.
- The `auth.protect()`-not-called-on-denial test confirms the rate limiter
  actually short-circuits the request pipeline on a real failure/denial
  path, not just returning a decision object that something downstream
  ignores.

## Summary

No regressions found. No test failures. The implementation matches the
spec's contract for `resolveTier` precedence, the fixed-window algorithm
(including the "denied requests don't extend the window" subtlety), the
identifier fallback chain, the 429 response shape, and the middleware
wiring (order relative to `auth.protect()`, and graceful degradation when
`auth()` throws). Recommend proceeding to Review.
