# Performance / Load Testing

## 1. Purpose

PRD §14.1 (Performance Requirements) requires a load-test pass against
staging before Phase 1 launches. This is that pass: issue #81 (Sprint 4,
backlog row 72), and it gates issue #83 (production deploy gate) — #83's
gate reads the results table in §7 below and treats a `Not run` or `Blocked`
row as an incomplete pass.

## 2. Targets

| Target | Threshold | AC |
| --- | --- | --- |
| API response time | p95 < 500ms @ 100 concurrent users | AC1 |
| Signed URL generation | p95 < 200ms | AC3 |
| SMS delivery | p95 < 30s @ 50 simultaneous sends | AC2 |
| Email delivery | p95 < 60s @ 50 simultaneous sends | AC2 |

(Rate limiting under the same 100-concurrent-user load, AC4, is a pass/fail
probe rather than a latency threshold — see §5 and `tests/load/scenarios.ts`
`runRateLimitProbe`.)

## 3. Harness

**Why Bun/TypeScript instead of k6.** The AC says "k6 (or similar)". k6 is a
Go binary that Bun cannot install as a dependency, its test scripts cannot
import this repo's TypeScript (endpoint registry, rate-limit policy, auth
helpers), and a hand-rolled harness keeps the percentile/threshold/report
logic in plain modules the existing Jest suite can unit-test directly. A Bun
+ TypeScript CLI satisfies "or similar" while staying inside the repo's
existing tooling (no new package manager, no new CI runner image).

File map:

| Path | Purpose |
| --- | --- |
| `tests/load/env.ts` | Env-var gating (`readEnv`) |
| `tests/load/targets.ts` | Targets, load profile, endpoint registry, expected rate-limit policies |
| `tests/load/stats.ts` | Pure percentile / summary / threshold-evaluation logic |
| `tests/load/http.ts` | Timed fetch + bounded-concurrency runner |
| `tests/load/scenarios.ts` | The four scenarios: api, signed-url, rate-limit, notifications |
| `tests/load/report.ts` | Markdown table rendering + exit-code resolution |
| `tests/load/run.ts` | CLI entry point (`bun run test:load`) |

The pure logic — `tests/load/stats.ts`, `tests/load/targets.ts` (incl. the
rate-limit-policy sync check against `lib/api/rate-limit.ts`), and
`tests/load/report.ts` — is unit-tested under `bun run test`
(`tests/unit/load/*.test.ts`), same as the rest of the repo's Jest suite.
The network-calling scenario functions (`tests/load/scenarios.ts`) are
exercised by an actual `bun run test:load` pass against staging, not by
Jest.

`tests/load/**` is plain TypeScript executed directly by Bun. It does **not**
import `server-only`, `next/server`, `@clerk/*`, `@supabase/*`, or anything
under `app/**` or `lib/**` — those pull server-only/Next runtime bundles into
a bare Bun process — and uses the global `fetch` only.

## 4. Prerequisites

| Env var | Required | Meaning |
| --- | --- | --- |
| `LOAD_TEST_BASE_URL` | yes (falls back to `STAGING_APP_URL`) | Staging base URL |
| `LOAD_TEST_ADMIN_TOKENS` | yes | Comma-separated Clerk session JWTs for admin-persona user(s) |
| `LOAD_TEST_MEMBER_TOKENS` | yes | Comma-separated Clerk session JWTs for member-persona user(s) |
| `LOAD_TEST_SONG_ID` | no | Song uuid with ≥1 attached document; the signed-URL scenario is `skipped` when absent |

**Obtaining a Clerk session JWT for a seeded staging test user.** Staging
seeds exactly two Clerk test-mode users, `E2E_ADMIN_EMAIL` and
`E2E_MEMBER_EMAIL` (`documentation/staging-environment.md` §7). Sign in as
each via the staging Clerk test instance (e.g. through the Clerk Dashboard's
"impersonate" flow, or the same `@clerk/testing` sign-in-ticket mechanism the
Playwright E2E suite uses, `tests/e2e/support/auth.ts`) and copy the
resulting session token. Set it as `LOAD_TEST_ADMIN_TOKENS` /
`LOAD_TEST_MEMBER_TOKENS`, e.g.:

```bash
export LOAD_TEST_BASE_URL="https://<staging-deployment>.vercel.app"
export LOAD_TEST_ADMIN_TOKENS="<clerk-session-jwt>"
export LOAD_TEST_MEMBER_TOKENS="<clerk-session-jwt>"
export LOAD_TEST_SONG_ID="<song-uuid-with-a-document>"
```

**Clerk session tokens are short-lived.** Mint them immediately before a run.
If a run reports a scenario failing with "session token rejected (401/403)",
the token expired mid-run — re-mint it and re-run rather than trusting any
latency numbers from that run.

**Picking `LOAD_TEST_SONG_ID`.** Use any song `id` in the staging database
that has at least one row in `song_documents` attached to it (so
`GET /api/songs/:id/documents` returns a real presigned URL to time, not an
empty list). If no such song exists yet, upload one document to any staging
song first (Set Leader/Admin, `POST /api/songs/:id/documents/upload-url`
then `POST /api/songs/:id/documents`), or leave `LOAD_TEST_SONG_ID` unset —
the signed-URL scenario reports `skipped` and the run's exit code reflects
the incomplete pass (§5).

## 5. Running it

```bash
bun run test:load
bun run test:load --scenario api
bun run test:load --scenario signed-url --markdown
bun run test:load --scenario rate-limit
bun run test:load --scenario notifications
```

- `--scenario api|signed-url|rate-limit|notifications|all` — defaults to
  `all`. Scenarios always run sequentially, never in parallel (a parallel
  scenario would contend for the same rate-limit bucket and corrupt both
  measurements).
- `--markdown` — additionally prints the markdown results table (paste it
  into §7 below).

**Run this against staging, not local dev.** `LOAD_TEST_BASE_URL` must point
at the staging deployment — running it against `localhost` does not exercise
the real Vercel/Supabase/rate-limit deployment this pass is meant to
validate.

Exit codes:

| Code | Meaning |
| --- | --- |
| 0 | Env unconfigured (skip), or every executed scenario `pass` with none skipped/blocked |
| 1 | At least one scenario `fail` |
| 2 | Partial/invalid env, or preflight failure |
| 3 | No failures, but ≥1 scenario `skipped` or `blocked` (pass is incomplete) |

## 6. Known limitations

- **`GET /api/health` is excluded from the AC1 p95.** It's unauthenticated
  and exempt from rate limiting (`resolveTier`, `lib/api/rate-limit.ts`), so
  its latency and error-rate profile isn't representative of the
  authenticated API under load. It's still driven every run (round-robin
  with the other 11 endpoints) and still reported individually in the
  per-endpoint breakdown the CLI prints, but its samples/ok/rate-limited/
  error counts are excluded from `runApiLoad`'s pooled totals — the numbers
  that decide AC1 pass/fail and populate the `Measured (p95)` / `Notes`
  cells below.
- **Virtual users are paced, not saturating.** Each worker sleeps
  `LOAD_PROFILE.thinkTimeMs` (500ms) between iterations, so "100 concurrent
  users" means 100 workers each issuing roughly one request every
  ~500ms+RTT, not 100 tight loops firing as fast as the network allows. This
  keeps the harness from self-flooding (and self-inflicting a spurious
  error-rate failure) — see `tests/load/http.ts`'s `runConcurrent`.
- **Shared rate-limit bucket.** The limiter keys per Clerk user id
  (`getRequestIdentifier`, `lib/api/rate-limit.ts:101`), and staging seeds
  exactly two Clerk test users. 100 virtual users driven by one or two
  session tokens therefore share one or two buckets and will be throttled —
  which is itself what AC4 wants to see, but it means the API-load p95 figure
  is "latency under 100 concurrent in-flight requests sharing a small number
  of identity buckets," not "100 distinct users' sustained traffic." The
  harness accepts comma-separated *lists* of tokens (§4) so the identity pool
  can be widened later with zero code change.
- **In-memory, per-instance rate limiting.** The limiter's store is an
  in-memory `Map` (`lib/api/rate-limit.ts:123`), not a distributed/shared
  store. If staging is ever deployed across multiple instances, each
  instance enforces its own limit independently, so the effective limit
  under real multi-instance traffic is higher than the configured
  per-instance number.
- **Vercel cold starts.** The preflight pass (one warm-up request per
  endpoint before any timed scenario) mitigates but does not eliminate cold
  starts skewing the very first sampled request of a run.
- **Harness network is part of the measurement.** The harness runs from a
  single machine (an operator's laptop or a CI-adjacent box), so that
  machine's own network latency to staging is included in every measured
  duration — this is not a from-the-Vercel-edge or from-real-user-devices
  measurement.

## 7. Results — Phase 1 pre-launch run

Fill in this table when you run the pass. #83 (production deploy gate) reads
this table; a `Not run` or `Blocked` row means the pass is **not** complete.

| Target | Threshold | Measured (p95) | Status | Notes | Date / commit |
| --- | --- | --- | --- | --- | --- |
| API response time | p95 < 500ms @ 100 concurrent users | — | Not run | — | — |
| Signed URL generation | p95 < 200ms | — | Not run | — | — |
| SMS delivery | p95 < 30s @ 50 simultaneous sends | — | Blocked | — | — |
| Email delivery | p95 < 60s @ 50 simultaneous sends | — | Blocked | — | — |
| Rate limiting (AC4) | ≥1 429 w/ valid `Retry-After` + `code=RATE_LIMITED` | — | Not run | — | — |

Run `bun run test:load --markdown` and paste the resulting table here in
place of the placeholder rows above.

## 8. Blocked items

**Notification delivery latency (AC2) cannot be measured today.** There is
nothing to time:

- `sendSms` (`lib/pingram/client.ts:5`) and `sendEmail`
  (`lib/resend/client.ts:4`) are unimplemented stubs that always throw.
- The Pingram and Resend delivery webhooks are 501 stubs
  (`app/api/webhooks/pingram/route.ts`, `app/api/webhooks/resend/route.ts`).
- The `notifications` table has no dispatch/delivery timestamp columns
  (`supabase/migrations/20260702000005_cluster_5_partial.sql:59`).

`tests/load/scenarios.ts`'s `runNotificationLatency` reflects this
explicitly: it returns a `blocked` result naming these files, performs no
network calls, and never synthesizes, estimates, or fakes a latency number.
This is why the harness's exit code is non-zero (`3`, see §5) on an
otherwise-passing run — an incomplete pass must not be mistaken for a
complete one. This scenario becomes runnable once #58 (Pingram SMS dispatch)
and #59 (Resend email dispatch) ship and the notifications table gains
dispatch/delivery timestamps.
