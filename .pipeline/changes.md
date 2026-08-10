# Changes — Issue #81: Run performance/load test pass against staging

Implemented exactly per `.pipeline/spec.md`: a committed, runnable Bun +
TypeScript load-test harness targeting staging, plus its documentation and a
pre-populated results table. No application code under `app/**`, `lib/**`,
`middleware.ts`, `schemas/**`, or `supabase/**` was touched, and
`.github/workflows/ci.yml` was not modified (both out of scope per spec §1).

## New files

- `tests/load/env.ts` — `readEnv()` gates `LOAD_TEST_BASE_URL` (falls back to
  `STAGING_APP_URL`), `LOAD_TEST_ADMIN_TOKENS`, `LOAD_TEST_MEMBER_TOKENS`
  (comma-separated token lists), and optional `LOAD_TEST_SONG_ID`, returning
  `"unconfigured" | "partial" | "configured"`. Mirrors the doc-comment /
  `requireEnv` shape of `tests/e2e/support/env.ts`. Never logs a token value.
- `tests/load/targets.ts` — `PERF_TARGETS` (api 500ms / signedUrl 200ms / sms
  30s / email 60s), `LOAD_PROFILE` (100 concurrent, 60s, 10s ramp, 30s
  timeout, 1% max error rate), `NOTIFICATION_PROFILE` (50 simultaneous),
  `API_ENDPOINTS` (the 12 spec'd GET routes with their persona), and
  `EXPECTED_RATE_LIMIT_POLICIES` — a hand-mirrored copy of
  `lib/api/rate-limit.ts`'s `RATE_LIMIT_POLICIES` (tests/load/** cannot import
  lib/**), kept in sync by `tests/unit/load/targets.test.ts`.
- `tests/load/stats.ts` — pure `percentile` (nearest-rank), `summarize`, and
  `evaluateThreshold` (fails on null/empty summary, p95 over threshold, or
  non-429 error rate over `maxErrorRate`; 429s excluded from both samples and
  the error-rate denominator).
- `tests/load/http.ts` — `timedRequest` (global `fetch` + `AbortController`
  timeout, classifies 2xx/3xx→ok, 429→rateLimited, 401/403→unauthorized,
  else/throws→error, best-effort `code` parse from the JSON error body) and
  `runConcurrent` (N independent worker loops, so at most `concurrency`
  requests are ever in flight; `durationMs` XOR `iterationsPerWorker`;
  injectable `now`/`sleep` for deterministic tests; ramp-up staggers worker
  start times evenly, skipping the zero-delay sleep for worker 0).
- `tests/load/scenarios.ts` — `preflight` (one warm-up request per endpoint,
  retries a single 429 after its `Retry-After`), `runApiLoad` (round-robin
  across `API_ENDPOINTS`, per-endpoint + overall aggregation, fails outright
  on any 401/403), `runSignedUrlLoad` (same profile against
  `GET /api/songs/:id/documents`, `skipped` when `songId` is null),
  `runRateLimitProbe` (AC4: fires `read.limit + 20` sequential requests to
  `/api/profile`, requires ≥1 well-formed 429, short-circuits once
  satisfiable, and also reports/gates on the 429 count `runApiLoad` produced
  in the same process — tracked via a module-level variable set by
  `runApiLoad`, since the scenario runs sequentially in one `bun run
  test:load` process and the spec pins both functions' signatures to take no
  extra param), and `runNotificationLatency` (always `blocked`, no network
  calls, names the blocking files per OPEN QUESTION 1 — never fabricates a
  latency number).
- `tests/load/report.ts` — `renderMarkdown` (pipe-table, host-only base URL
  via `new URL(...).host`, pipe/newline-escaped notes cells) and
  `resolveExitCode` (`1` if any `fail`, else `3` if any `skipped`/`blocked`,
  else `0`).
- `tests/load/run.ts` — CLI (`bun run test:load [--scenario ...]
  [--markdown]`). Unconfigured env → prints the skip line, exit `0`. Partial
  env → lists missing vars, exit `2`. Preflight failure → exit `2`. Otherwise
  runs the requested scenario(s) sequentially in a fixed order (`api`,
  `signed-url`, `rate-limit`, `notifications` so the rate-limit probe can see
  `runApiLoad`'s 429 count), prints a human summary always, prints the
  markdown table only with `--markdown`, exits via `resolveExitCode`. Never
  writes to a file.
- `tests/unit/load/stats.test.ts`, `tests/unit/load/targets.test.ts`,
  `tests/unit/load/http.test.ts`, `tests/unit/load/report.test.ts` — unit
  coverage for the four pure/testable modules, including the
  `EXPECTED_RATE_LIMIT_POLICIES` vs. `lib/api/rate-limit.ts`'s
  `RATE_LIMIT_POLICIES` sync check, `runConcurrent`'s concurrency-ceiling and
  ramp-up-stagger behavior, `timedRequest`'s classification matrix (mocking
  `global.fetch`), and `renderMarkdown`'s host-only/pipe-escaping behavior
  plus `resolveExitCode`'s precedence rules. `tests/load/scenarios.ts` itself
  has no unit test file (not listed in spec §2 — it makes real network calls
  and is exercised by an actual `bun run test:load` pass instead).
- `documentation/performance-testing.md` — purpose/targets/harness rationale
  (why Bun+TS not k6)/prerequisites/running instructions/known
  limitations/results table (pre-populated with `Not run`/`Blocked` rows,
  operator pastes the `--markdown` output over them)/blocked-items section,
  per spec §6.

## Modified files

- `package.json` — added `"test:load": "bun run tests/load/run.ts"` after
  `test:e2e`.
- `README.md` — one link to `documentation/performance-testing.md` alongside
  the existing `documentation/...` links.
- `documentation/staging-environment.md` — new `## 9. Load / performance
  testing (issue #81)` section (env var table + pointer to
  `documentation/performance-testing.md`); no existing section renumbered.

## Verification run

- `bun run typecheck` — clean.
- `bun run lint` — clean.
- `bun run format:check` — clean for every new/modified file in this change
  (verified explicitly via `grep -E "tests/load|tests/unit/load"` against
  the format:check output, which returned nothing). Note: `bun run
  format:check` fails on ~100 pre-existing files repo-wide in this
  environment (confirmed by `git stash`-ing this change and re-running — the
  failures are identical minus this change's 9 new source files); that is a
  pre-existing condition unrelated to and not touched by this issue.
- `bun run test` — 118 suites / 2817 tests, all green. Confirmed via
  `bunx jest --listTests | grep -i load` that only the four
  `tests/unit/load/*.test.ts` files are picked up — `tests/load/**` itself
  is not matched by `jest.config.js`'s `testMatch`, and no config change was
  made.
- `bun run test:load` with no env vars set — prints `SKIPPED: load harness
  not configured (see documentation/performance-testing.md)` and exits `0`.
- Additional manual smoke checks against a local mock HTTP server (not real
  staging — no credentials available in this environment) to exercise the
  live code paths beyond the "unconfigured" gate: partial-env → exit `2`;
  invalid `--scenario` value → exit `2`; unreachable base URL → preflight
  failure → exit `2` (fast, no hang); `--scenario notifications` against a
  reachable mock → preflight passes, `blocked` result, exit `3`;
  `--scenario signed-url` with no `LOAD_TEST_SONG_ID` → `skipped`, exit `3`;
  `--scenario rate-limit --markdown` against a mock that never 429s → `fail`
  with a clear reason, exit `1`, and the printed markdown table shows the
  base URL host-only with no tokens present anywhere in stdout.
- `bun run check:git-secrets` — clean (no secrets found in git history).

## What the Tester should focus on

1. **No real staging credentials exist in this environment** — the actual
   AC1–AC4 measurements against staging were never taken (by design; see
   spec's Verification §7, "do not attempt a real staging run"). The Tester
   should verify the harness's *logic* (unit tests, exit-code contract,
   env-gating, format/lint/typecheck), not claim a real performance number.
2. `tests/load/scenarios.ts`'s module-level `lastApiLoadRateLimitedTotal`
   hand-off between `runApiLoad` and `runRateLimitProbe` — this was the one
   genuinely ambiguous part of the interface (spec pins
   `runRateLimitProbe(config): Promise<ScenarioResult>` with no extra
   parameter, yet its behavior description requires it to know
   `runApiLoad`'s 429 count "under this same load test"). Worth
   double-checking this interpretation is reasonable, since it's implemented
   as process-lifetime shared state rather than a passed argument.
3. `tests/load/report.ts`'s `resolveExitCode` and the CLI's exit-code
   handling in `tests/load/run.ts` — cross-check against the §5 exit-code
   table (0/1/2/3) including the "unconfigured → 0" and "partial/preflight
   failure → 2" paths that live in `run.ts` rather than `report.ts`.
4. `tests/load/http.ts`'s `runConcurrent` — verify the concurrency-ceiling
   and ramp-up-stagger tests aren't flaky under a slower CI machine (they use
   real timers in one test and injected `now`/`sleep` in the others).
5. Confirm `tests/load/**` is genuinely excluded from `bun run test` (already
   checked here via `jest --listTests`) and that no `jest.config.js` /
   `jest.config.integration.js` change was needed or made.
