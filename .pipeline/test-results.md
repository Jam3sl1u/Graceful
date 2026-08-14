# Test results — Issue #81 fix pass (review NEEDS WORK → this pass)

**Overall: PASS.** All 7 findings from `.pipeline/review.md`'s NEEDS WORK
verdict (3 MUST FIX, 4 SHOULD FIX) were independently re-verified after the
fix pass described in `.pipeline/changes.md`.

## Automated checks

| Check | Result |
| --- | --- |
| `bun run typecheck` | Clean |
| `bun run lint` | Clean (1 pre-existing warning in generated `coverage/lcov-report/`, unrelated to this change) |
| `bun run test` | 120 suites / 2850 tests, all green (2839 original baseline + 6 from this fix pass + 5 from the independent-review addendum below) |
| `bun run format:check` | Clean for every file this fix pass touched; the ~100 other repo-wide warnings confirmed pre-existing on this branch via `git stash` (identical warning set before and after this fix pass's changes) |
| `bun run check:git-secrets` | Clean |
| `bun run check:workflows` | N/A — no `.claude/workflows/**` file touched |

## New regression tests (verifying the fix, not just re-running old coverage)

- `tests/unit/load/scenarios.test.ts` — `poolAggregates`: confirms a
  `persona: "none"` bucket (e.g. `/api/health`) is excluded from pooled
  totals but still reported per-endpoint (MUST FIX #1's exact regression
  case), and that normal all-authenticated pooling is unaffected.
- `tests/unit/load/http.test.ts` — `thinkTimeMs`: confirms `sleep` is called
  with the configured pacing delay between iterations, and never called when
  omitted (MUST FIX #2).
- `tests/unit/load/http.test.ts` — the two previously weak assertions now
  pin exact values (`maxInFlight` is `toBe(5)`, not `toBeLessThanOrEqual(5)`;
  the deadline test's `calls` array is pinned to the observed deterministic
  `[0, 1, 0, 1]` sequence rather than just `toBeGreaterThan(0)`) (SHOULD FIX
  #7).
- `tests/unit/load/env.test.ts` — only `STAGING_APP_URL` set (no
  `LOAD_TEST_*` vars) → `unconfigured`, not `partial` (SHOULD FIX #6).
- `tests/unit/load/report.test.ts` — `renderMarkdown` now requires and
  renders a `commit` field in the 6-column table (SHOULD FIX #4).

## Manual end-to-end verification (real network path, not unit-testable per spec §2)

Ran against local mock HTTP servers reproducing the real 240/60s read-tier
rate limiter shape (`lib/api/rate-limit.ts`'s `resolveTier`/
`checkRateLimit`) — no real staging credentials exist in this environment,
consistent with the original coding/testing stages' documented constraint.

1. **Happy path — `--scenario api --markdown` against a mock with the
   documented small shared-token-pool scenario (4 tokens, 100 workers):**
   `PASS`, measured p95 21ms, `1653 ok, 2005 rate-limited, 0 errors across 12
   endpoints`, exit 0.
   - Verified `totalOk` (1653) equals the exact sum of the 11 *authenticated*
     endpoints' individual `ok` counts (health's 332 `ok` samples correctly
     excluded from pooling) — direct confirmation MUST FIX #1 is fixed.
   - Verified 0 non-429 errors despite 2005 rate-limited responses (heavy
     429 volume is expected/documented under a small shared token pool,
     §6) — direct confirmation MUST FIX #2's self-inflicted-flood is fixed;
     total request volume (~3,700 over ~70s) is roughly 3 orders of
     magnitude below the review's reported 2.06M/60s.
   - Verified the `--markdown` output is the new 6-column
     `Target | Threshold | Measured (p95) | Status | Notes | Date / commit`
     shape with a populated commit cell (SHOULD FIX #4).
2. **Failure case — `--scenario api` against a mock injecting a ~5% non-429
   error rate on authenticated endpoints (no rate limiting simulated, to
   isolate the error-rate path):** `FAIL`, `non-429 error rate 4.8% exceeds
   max 1.0%`, exit 1. Confirms the fix pass didn't accidentally make the
   harness unable to report FAIL when a real >1% error rate exists — the
   original review's MUST FIX #2 concern was specifically that the harness
   might become *structurally unable to ever pass*; this checks the
   complementary risk (unable to ever fail) wasn't introduced by the pacing
   fix. Health's endpoint again correctly shows 0 errors and is excluded
   from the reported rate.
3. **`STAGING_APP_URL`-only environment** (`env -i` with only
   `STAGING_APP_URL` set, no `LOAD_TEST_*` vars): prints `SKIPPED: load
   harness not configured`, exit 0 — was exit 2 before the fix (SHOULD FIX
   #6).
4. **`--scenario notifications` against a deliberately unreachable base
   URL:** returns the expected `blocked` result, exit 3 — proves preflight
   was skipped (an unreachable URL would otherwise produce a preflight
   failure, exit 2) (SHOULD FIX #5).

## Issue found and fixed during this stage's own verification

While manually verifying MUST FIX #2's happy path (item 1 above), the first
run of the harness against the small-token-pool mock **did not complete
within a 150s window** (nearly double the ~70s the fixed `durationSeconds`
+ `rampUpSeconds` design implies). Root cause: the Retry-After-aware backoff
added for MUST FIX #2 honored the mock's full reported `Retry-After`, which
— like the real limiter under a small shared token pool — can be up to the
entire 60s rate-limit window early in that window. A worker rate-limited
near the start of its loop would sleep for most of a minute before checking
the deadline again, stalling `runConcurrent`'s `Promise.all` well past the
run's own fixed-duration contract. Fixed by capping the backoff at
`RATE_LIMIT_BACKOFF_CAP_MS = 2000`ms in `tests/load/scenarios.ts` (see
`.pipeline/changes.md` for detail); re-verified afterward (item 1 above)
completes in the expected ~70s window. This is called out explicitly for the
Reviewer since it's a design refinement made during this stage, not
something the original plan anticipated.

## Addendum — independent re-review round

An independent `reviewer` subagent (fresh context, own typecheck/lint/test/
git-secrets/prettier runs, own reading of every touched file — see
`.pipeline/review.md`) confirmed all 3 MUST FIX and 4 SHOULD FIX findings
genuinely fixed, including mutation-testing the two strengthened
`http.test.ts` assertions itself (serial `runConcurrent` kills the new
`toBe(5)`; a removed deadline check kills the new
`toEqual([0, 1, 0, 1])` — neither would have been caught by the original weak
assertions). It found and this stage fixed 5 new issues introduced by the
original fix-pass round — see `.pipeline/changes.md`'s "Addendum" section for
the detail on each:

1. `runApiLoad`'s detail string said "12 endpoints" when only 11 feed the
   pooled AC1 totals post-fix — now dynamically computed and reworded.
2. `documentation/performance-testing.md` §6 didn't disclose the health
   exclusion or the new pacing behavior — two new bullets added.
3. The `Date / commit` column's commit is the harness's local checkout, not
   the staging deployment's — now documented explicitly and suffixed
   `-dirty` when the working tree has uncommitted changes.
4. The rate-limit backoff had no test coverage — extracted to a pure
   `resolveBackoffMs` with 5 new unit tests.
5. The `poolAggregates` test's excluded fixture only exercised
   samples/ok — extended to nonzero `rateLimited`/`errors` too, so a
   regression leaking those into the pooled totals would be caught.

Re-verified after all 5 fixes: full suite (120 suites / 2850 tests),
typecheck, lint, `check:git-secrets`, and `prettier --check` on every touched
file all clean; the local-mock manual check was re-run and confirmed both
the corrected "11 authenticated endpoints" wording and the `-dirty` commit
suffix render correctly in real output.

## What the Reviewer should focus on

All items from the independent review's own list have been addressed above.
Nothing outstanding is being carried forward to human review beyond the
normal expectation of eyes on the diff before merge.
