# Changes — Issue #81 fix pass: address review NEEDS WORK verdict

This run addresses every finding in the prior `.pipeline/review.md` (NEEDS
WORK: 3 MUST FIX, 4 SHOULD FIX) against the load/performance-test harness
built for issue #81. No application code under `app/**`, `lib/**`,
`middleware.ts`, `schemas/**`, or `supabase/**` was touched, and
`.github/workflows/ci.yml` was not modified — same scope boundary as the
original implementation.

## MUST FIX #1 — Invalid AC1 measurement (health polluting the pooled p95)

`GET /api/health` is `persona: "none"` — unauthenticated and exempt from rate
limiting (`resolveTier`, `lib/api/rate-limit.ts`) — so pooling its samples
into `overallSamples` alongside the 11 authenticated endpoints produced an
AC1 p95 that was over 99% health traffic.

- `tests/load/scenarios.ts` — extracted the pooling step out of
  `runLoadAgainstEndpoints`'s inline `forEach` into a new exported pure
  function, `poolAggregates(endpoints, aggregates)`. It now excludes any
  endpoint with `persona === "none"` from `overallSamples` /
  `totalOk`/`totalRateLimited`/`totalErrors`, while still including every
  endpoint (health included) in the returned `perEndpoint` breakdown for
  visibility.
- `tests/unit/load/scenarios.test.ts` — new `describe("poolAggregates", ...)`
  block: two tests, one asserting a `persona: "none"` bucket's
  samples/counters are excluded from the pooled totals but still present in
  `perEndpoint`, one asserting normal pooling across all-authenticated
  endpoints is unaffected. This is the regression test that would have
  caught the original bug — `runApiLoad`'s real network path still has no
  unit test (by design, per spec §2), so this exercises the pooling logic in
  isolation instead.

## MUST FIX #2 — No pacing/backoff (self-inflicted flood)

100 workers looping with zero think-time produced ~2.06M requests in 60s
against review's mock, and the resulting connection-drop error rate failed
the run before p95 was even meaningful.

- `tests/load/targets.ts` — added `LOAD_PROFILE.thinkTimeMs = 500`.
- `tests/load/http.ts` — `ConcurrentOptions` gained an optional
  `thinkTimeMs?: number` (default `0`, so existing callers/tests are
  unaffected). In `runConcurrent`'s duration-loop branch, after each
  iteration the worker now `await sleep(thinkTimeMs)`s (using the
  already-injectable `sleep`) before re-checking the deadline.
- `tests/load/scenarios.ts` — `runLoadAgainstEndpoints`'s `runConcurrent`
  call now passes `thinkTimeMs: LOAD_PROFILE.thinkTimeMs`. Also added
  Retry-After-aware backoff on `rateLimited` outcomes, **capped** at
  `RATE_LIMIT_BACKOFF_CAP_MS = 2000`ms — honoring the server's full
  `Retry-After` (which can be up to the entire 60s rate-limit window under
  the harness's documented small shared-token-pool scenario, §6) would let
  one throttled worker stall the whole run for tens of seconds past its own
  fixed-duration deadline. This cap was added after manual verification
  against a mock rate limiter (below) showed the uncapped version hanging
  well past the intended ~70s run time.
- `tests/unit/load/http.test.ts` — two new tests: `sleep` is invoked with
  `thinkTimeMs` between iterations when the option is set (using the
  existing injected-clock/sleep pattern), and is never invoked when the
  option is omitted.

Net effect verified manually (see below): total request volume against a
local mock dropped from ~2.06M/60s to ~3,700/70s, with 0 non-429 errors.

## MUST FIX #3 — Testing-stage commit gap

Already resolved on this branch (commit `7b42387`). No code change; verified
`git status --short` stays empty after this fix pass's own changes, before
committing.

## SHOULD FIX #4 — `renderMarkdown` / doc §7 column mismatch

- `tests/load/report.ts` — `renderMarkdown`'s `meta` param gained a required
  `commit: string`; the table now renders 6 columns:
  `Target | Threshold | Measured (p95) | Status | Notes | Date / commit`.
- `tests/load/run.ts` — new `resolveCommit()` (via `node:child_process`
  `spawnSync("git", ["rev-parse", "--short", "HEAD"])`, falling back to
  `"unknown"` on any failure) is now passed into the `renderMarkdown(...,
  { commit })` call site.
- `documentation/performance-testing.md` §7 — header and all 5 placeholder
  rows updated to the same 6-column shape so the CLI's `--markdown` output
  pastes in directly.
- `tests/unit/load/report.test.ts` — existing tests updated for the new
  required `commit` field; one new test asserts the `Date / commit` cell
  content.

## SHOULD FIX #5 — Preflight firing for the zero-network `notifications` scenario

- `tests/load/run.ts` — preflight is now skipped when the resolved
  `--scenario` is exactly `notifications` (the single-scenario case;
  `--scenario all` still runs preflight, since the other 3 scenarios need it
  and `notifications` runs last in that mode regardless).
- Verified manually (below) rather than via a new unit test — `run.ts` has
  no dedicated unit test file (it's the CLI entry point; `preflight()` itself
  is already covered in `scenarios.test.ts`), consistent with the existing
  test layout.

## SHOULD FIX #6 — `STAGING_APP_URL`-only → wrong exit code

- `tests/load/env.ts` — `readEnv`'s "is the harness even being configured"
  gate (`anySet`, renamed `explicitlySet`) no longer folds in the
  `STAGING_APP_URL` fallback — it's computed from `LOAD_TEST_*` vars only.
  An environment where only `STAGING_APP_URL` is set (common — it's a
  general-purpose var, not load-test-specific) now correctly resolves to
  `{ kind: "unconfigured" }` (exit 0) instead of `{ kind: "partial" }`
  (exit 2). `baseUrlRaw`'s `STAGING_APP_URL` fallback is unchanged for the
  subsequent `missing`/`configured` resolution once at least one
  `LOAD_TEST_*` var is genuinely set.
- `tests/unit/load/env.test.ts` — new test: only `STAGING_APP_URL` set →
  `unconfigured`.

## SHOULD FIX #7 — Two weak `http.test.ts` assertions

- `tests/unit/load/http.test.ts`:
  - "never exceeds the concurrency ceiling" — `toBeLessThanOrEqual(5)` →
    `toBe(5)`. With `concurrency: 5` and no ramp-up stagger, all 5 workers'
    first iteration increments `inFlight` synchronously before any 1ms timer
    fires, so 5 is deterministic; this now proves real concurrency, not just
    an upper bound.
  - "stops issuing new iterations..." — `toBeGreaterThan(0)` → a pinned
    `toEqual([0, 1, 0, 1])`. The exact sequence was **observed by running the
    test** (temporarily logging the `calls` array), not hand-derived, per the
    review's own caution about re-deriving the math; the trace is documented
    inline in the test.

## Addendum — independent re-review round

Before writing a final verdict, this fix pass was independently re-reviewed
(fresh `reviewer` subagent, no access to this session's reasoning — see
`.pipeline/review.md`). It confirmed all 7 original findings were genuinely
fixed (not cosmetically), including running its own mutation checks on the
two strengthened `http.test.ts` assertions, and found 5 new issues
introduced by this fix pass itself. All 5 were fixed:

1. **`runApiLoad`'s pass-detail string said "across 12 endpoints"** but only
   11 (the authenticated ones) feed the pooled totals after MUST FIX #1 —
   factually wrong in the exact artifact #83's gate reads. Now computed as
   `API_ENDPOINTS.filter((e) => e.persona !== "none").length` and reworded to
   "authenticated endpoints" (`tests/load/scenarios.ts`).
2. **`documentation/performance-testing.md` §6 never disclosed either
   behavioral change** (health exclusion from AC1 pooling, 500ms think-time
   pacing) — added two new "Known limitations" bullets.
3. **The new `Date / commit` column reports the harness's local checkout,
   not the staging deployment's commit** — those routinely differ and the
   local tree may be dirty. `resolveCommit()` (`tests/load/run.ts`) now
   appends a `-dirty` suffix when `git status --porcelain` is non-empty, and
   `renderMarkdown`'s doc comment (`tests/load/report.ts`) now states
   explicitly what the commit represents.
4. **The rate-limit backoff had zero test coverage** and used a raw
   `setTimeout` rather than the module's own injectable pattern — extracted
   as a pure, exported `resolveBackoffMs(retryAfter)` function with 5 new
   unit tests (missing/non-numeric/zero-or-negative/below-cap/above-cap).
5. **The `poolAggregates` test fixture's `persona: "none"` bucket had
   `rateLimited: 0, errors: 0`**, so a regression that pooled only
   `samples`/`ok` (but still leaked `rateLimited`/`errors` from excluded
   endpoints into the totals feeding `evaluateThreshold`'s error-rate gate)
   would have survived. Fixture now uses nonzero values for both.

Re-verified after these fixes: `bun run typecheck`/`lint`/`test` (120 suites
/ 2850 tests) / `check:git-secrets` all clean; `bunx prettier --check` clean
on every touched file; re-ran the local-mock manual check and confirmed the
corrected detail string (`"...across 11 authenticated endpoints..."`) and
the `-dirty` commit suffix both render correctly.

## Verification run (original fix-pass round)

- `bun run typecheck` — clean.
- `bun run lint` — clean (1 pre-existing warning in generated
  `coverage/lcov-report/`, unrelated).
- `bun run test` — 120 suites / 2845 tests, all green (2839 baseline + 6 new
  tests from this fix pass).
- `bun run format:check` — this fix pass's files are clean; confirmed via
  `git stash` that the ~100 other files it flags repo-wide are a pre-existing
  condition on this branch, not introduced here. One file this fix pass
  touched (`tests/unit/load/report.test.ts`) needed `prettier --write`
  (applied, scoped to only the files this fix pass touched).
- `bun run check:git-secrets` — clean.
- Manual end-to-end run against a local mock server reproducing the real
  240/60s read-tier limiter (`resolveTier`/`checkRateLimit` shape from
  `lib/api/rate-limit.ts`), 4 shared tokens across 100 workers (deliberately
  small, matching the documented §6 "Shared rate-limit bucket" scenario):
  `--scenario api --markdown` → `PASS`, measured p95 21ms, `1653 ok, 2005
  rate-limited, 0 errors across 12 endpoints`, exit 0. `totalOk` (1653)
  verified to equal the sum of the 11 authenticated endpoints' individual
  `ok` counts exactly (health's 332 `ok` samples correctly excluded from
  pooling). Markdown output confirmed 6-column with a populated
  `Date / commit` cell.
- Manual check: `STAGING_APP_URL` set alone (no `LOAD_TEST_*` vars) → prints
  the `SKIPPED` message, exit 0 (previously exit 2).
- Manual check: `--scenario notifications` against a deliberately
  **unreachable** base URL → returns the expected `blocked` result / exit 3
  rather than a preflight failure (exit 2), proving preflight was skipped.

## What the Reviewer should focus on

1. The `RATE_LIMIT_BACKOFF_CAP_MS = 2000` cap on rate-limited backoff — this
   wasn't in the original review's stated fix, but was discovered as a
   necessary consequence of adding Retry-After-aware backoff (item 4 of MUST
   FIX #2's design) during this fix pass's own manual verification. Worth
   confirming the reasoning (bounding backoff so the fixed-duration test
   loop can't be stalled by one throttled worker) holds up.
2. `poolAggregates`'s exclusion is keyed on `persona === "none"` specifically
   (matching today's only such endpoint, `/api/health`) rather than a more
   general "is this endpoint rate-limit-exempt" check — reasonable today
   since persona and rate-limit-exemption happen to coincide for every
   current `API_ENDPOINTS` entry, but worth flagging as an assumption if a
   future rate-limit-exempt-but-authenticated endpoint is ever added.
3. `resolveCommit()`'s `spawnSync("git", ...)` in `tests/load/run.ts` — a new
   `node:child_process` dependency in a module whose doc comment previously
   only disclaimed server-only/Next/Clerk/Supabase imports; confirm this is
   an acceptable addition (it mirrors the existing pattern in
   `scripts/check-git-secrets.mjs`).
