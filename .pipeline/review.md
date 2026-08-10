# Review — Issue #81: Run performance/load test pass against staging

VERDICT: NEEDS WORK

Reviewed: `.pipeline/spec.md`, `.pipeline/changes.md`, `.pipeline/test-results.md`,
`git diff main...HEAD`, plus every file under `tests/load/**` and
`tests/unit/load/**` read in full. Independently re-ran `bun run typecheck`
(clean), `bun run lint` (clean), `bun run test` (120 suites / 2839 tests, all
green), `bun run check:git-secrets` (clean), `bunx prettier --check` on this
change's files (clean), and the CLI end-to-end against a local mock staging
server that mimics the real `read` 240/60s limiter and the real 429 body/header
shape.

The code matches the spec closely, the scope discipline is good (no `app/**`,
`lib/**`, `middleware.ts`, `schemas/**`, `supabase/**`, or `ci.yml` changes), the
token-never-logged requirement holds, and the `blocked` (not faked) handling of
AC2 is exactly right. The unit tests are mostly meaningful rather than
superficial. But an actual end-to-end run of the `api` scenario — the one code
path nobody in the pipeline exercised, because it needs 70s of wall clock —
shows the headline AC1 number this harness produces is not the number AC1 asks
for. Green tests, wrong behavior. That has to be fixed before a human runs this
pass and pastes the result into the table that gates #83.

## Must fix

### 1. `/api/health` dominates the overall AC1 p95 (measurement is invalid)

`tests/load/scenarios.ts` `runApiLoad` → `runLoadAgainstEndpoints` concatenates
every endpoint's samples into `overallSamples` and evaluates that pooled set
against `PERF_TARGETS.api`. But `/api/health` is explicitly exempt from rate
limiting (`lib/api/rate-limit.ts` `resolveTier`: `if (path === "/api/health")
return null`), while all 11 other endpoints fall in the `read` tier and stop
producing `ok` samples after ~240 responses per token bucket. So health keeps
emitting samples for the full 60s and everything else stops within the first
second.

Measured, running `--scenario api` against a mock with the real limiter policy:

```
GET /api/health:            ok=171585   rateLimited=0
GET /api/profile:           ok=58       rateLimited=171546
GET /api/songs:             ok=71       rateLimited=171507
... (9 more, all ok=64..122)
```

>99% of the pooled sample set is `/api/health` — an unauthenticated,
no-database, no-rate-limit endpoint. The reported "API response time p95 @ 100
concurrent users" is therefore essentially the health endpoint's p95, and it
will look excellent no matter how slow the real API is. #83's deploy gate reads
that number.

Fix in `tests/load/scenarios.ts` (and reflect it in
`documentation/performance-testing.md` §2/§6): exclude `persona: "none"` /
`/api/health` entries from `overallSamples`, or evaluate AC1 against the worst
per-endpoint p95 rather than a pooled set that is weighted by how often each
endpoint happened to be allowed through. Keep `/api/health` in the preflight
warm-up and in `perEndpoint` reporting if you want it — just not in the number
that decides pass/fail.

### 2. No pacing or 429 backoff: the run self-invalidates and floods the target

`runConcurrent` gives each of the 100 workers a tight `while (now() < deadline)`
loop with no think-time and no reaction to a 429. Two consequences, both
observed in the mock run above:

- **Volume.** ~2.06M requests in 60s against a local mock; against staging over
  a real RTT it is still tens of thousands, of which ~99% are 429s that
  contribute nothing to any measurement. That is gratuitous load/cost on the
  staging deployment and a plausible trigger for platform-level abuse
  protection, which would then corrupt the run.
- **Self-invalidation.** Under that self-inflicted saturation the transport
  started dropping connections; `timedRequest` classified those as `error`, and
  the run came back `[FAIL] non-429 error rate 14.3% exceeds max 1.0%` with a
  4ms p95. `evaluateThreshold` (`tests/load/stats.ts:79`) invalidates the run on
  error rate before it ever looks at latency, so as written the harness has a
  real chance of never being able to report `pass` for AC1 — the deliverable
  this issue exists to produce.

Fix: have the worker loop honor `Retry-After` (sleep, or stop that worker for
the remainder of the window) once it sees a 429, and/or add a per-iteration
think-time to `LOAD_PROFILE` so "100 concurrent users" means 100 users rather
than 100 spin loops. Either change also makes the §6 "shared rate-limit bucket"
limitation honest instead of merely disclosed.

### 3. The testing stage's work is not committed

`git status` on this branch:

```
 M .pipeline/test-results.md
?? tests/unit/load/env.test.ts
?? tests/unit/load/scenarios.test.ts
```

Commit `f5ead67` contains only the coding stage. If this branch is pushed as-is,
the PR ships without the two test files the testing stage added (22 of the 2839
green tests) and without `test-results.md`. Commit them before opening/updating
the PR.

## Should fix

4. **Results table cannot actually be pasted.** `renderMarkdown`
   (`tests/load/report.ts:46`) emits `| Target | Threshold | Measured (p95) |
   Status | Notes |`, but `documentation/performance-testing.md` §7's table is
   `| ... | Status | Date / commit |` and instructs the operator to "paste the
   resulting table here in place of the placeholder rows". The columns don't
   line up. Pick one shape (the spec itself is inconsistent between §3.6 and
   §6.7 — §7 losing the date/commit provenance is the worse option, so prefer
   adding a date/commit column to `renderMarkdown`).

5. **`preflight` runs for `--scenario notifications`.** `tests/load/run.ts:115`
   always preflights all 12 endpoints, so a scenario whose entire contract is
   "makes no network calls" still fires 13 requests and can exit `2` on a
   connectivity problem that is irrelevant to it. Skip preflight when the
   selected scenario set needs no network.

6. **`STAGING_APP_URL` fallback turns "unconfigured" into exit 2.**
   `tests/load/env.ts:54,60` counts the `STAGING_APP_URL` fallback toward
   `anySet`, so an operator or script with `STAGING_APP_URL` exported (it is a
   documented staging var) but no `LOAD_TEST_*` vars gets `partial` + exit `2`
   instead of the documented skip + exit `0` (spec §4 item 7). Consider only
   counting the `LOAD_TEST_*` vars toward `anySet`.

7. **Two superficial unit tests** in `tests/unit/load/http.test.ts`:
   - "never exceeds the concurrency ceiling" asserts only `maxInFlight <= 5`; a
     fully serial implementation passes it. Also assert `maxInFlight === 5`.
   - "stops issuing new iterations once the injected clock passes the duration
     deadline" asserts only `calls.length > 0`. The injected clock makes this
     fully deterministic (3 calls) — assert the exact count, otherwise the test
     proves nothing about the deadline.

## Noted, no change required

- `lastApiLoadRateLimitedTotal` (module-level handoff between `runApiLoad` and
  `runRateLimitProbe`, `tests/load/scenarios.ts:119`) is an acceptable reading
  of a spec that pinned both signatures. Verified it degrades cleanly to
  "not run this session" when the probe runs standalone.
- Bun+TS instead of k6 is a reasonable reading of "k6 (or similar)", and the
  rationale is documented in `documentation/performance-testing.md` §3.
- `EXPECTED_RATE_LIMIT_POLICIES` matches `lib/api/rate-limit.ts`'s
  `RATE_LIMIT_POLICIES`, and the sync test enforces it. The 429 assertions in
  `runRateLimitProbe` match what `rateLimitResponse` actually emits
  (`code: ErrorCode.RATE_LIMITED`, `Retry-After` integer >= 1) — verified
  against the source, not just the diff.
- Token hygiene holds: no token reaches stdout, the markdown report, or any
  error string; `hostOnly` strips userinfo and query. Confirmed by reading the
  code and by the mock CLI runs.
- AC2 handled as `blocked` with no fabricated number and no network calls —
  exactly right, and the exit-code-3 consequence is correctly wired.
- Unverifiable here, flag for the operator's first real run: the harness assumes
  the API accepts `Authorization: Bearer <clerk session jwt>`. If Clerk on
  staging is cookie-only for these routes, preflight will fail with a wall of
  `HTTP 401` and exit `2`. The doc's "re-mint the token" guidance would be
  misleading in that case.
