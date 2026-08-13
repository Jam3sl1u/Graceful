# Review — Issue #81 fix pass (review NEEDS WORK → this pass)

## Verdict: SHIP

The prior NEEDS WORK verdict's 3 MUST FIX and 4 SHOULD FIX findings are all
genuinely fixed, verified two ways: (1) this fix pass's own re-verification
(`.pipeline/test-results.md`), and (2) an independent `reviewer` subagent
with no access to this session's reasoning, which read the real diff and
code cold, ran its own typecheck/lint/test/git-secrets/prettier, and
mutation-tested the two strengthened test assertions itself rather than
trusting the test names. That independent pass returned NEEDS WORK against
this branch's first-round state — it found 5 new issues the fix pass had
itself introduced while fixing the original 7. All 5 were fixed in a second
round, re-verified, and are reflected in the current `tests/load/**` /
`documentation/performance-testing.md` / `.pipeline/*.md` state. This
verdict (SHIP) reflects that second, corrected state.

## Original 7 findings — final disposition

| # | Finding | Status |
| --- | --- | --- |
| MUST FIX 1 | `/api/health` pooled into the AC1 p95, invalidating it | **Fixed** — `poolAggregates` (`tests/load/scenarios.ts`) excludes `persona: "none"` from pooled totals, keeps it in `perEndpoint`. Verified by extraction into a unit-testable pure function, 2 new unit tests, and a manual mock run confirming pooled `totalOk` equals the exact sum of the 11 authenticated endpoints. |
| MUST FIX 2 | No pacing/backoff → self-inflicted flood/error rate | **Fixed** — `LOAD_PROFILE.thinkTimeMs = 500` + `runConcurrent`'s new think-time sleep + capped Retry-After backoff (`RATE_LIMIT_BACKOFF_CAP_MS = 2000`, extracted as pure `resolveBackoffMs`, 5 unit tests). Verified by a manual mock run: total volume dropped from the original review's 2.06M/60s to ~3,700/70s with 0 non-429 errors. A second manual run with an injected 5% error rate confirmed the harness still correctly reports FAIL — the fix didn't overcorrect into "always passes." |
| MUST FIX 3 | Testing-stage work left uncommitted | Already resolved on this branch (`7b42387`) before this fix pass began; reverified `git status --short` stays clean. |
| SHOULD FIX 4 | `renderMarkdown`/doc §7 column mismatch | **Fixed** — 6-column table (`Target \| Threshold \| Measured (p95) \| Status \| Notes \| Date / commit`) in both `report.ts` and the doc. Commit column clarified as the harness's own checkout (not the staging deployment's) with a `-dirty` suffix when uncommitted. |
| SHOULD FIX 5 | Preflight fires for zero-network `notifications` scenario | **Fixed** — `run.ts` skips preflight when `--scenario notifications` is the sole scenario. Verified manually: an unreachable base URL with `--scenario notifications` returns the scenario's normal `blocked`/exit 3, not a preflight failure/exit 2. |
| SHOULD FIX 6 | `STAGING_APP_URL`-only → wrong exit code | **Fixed** — `readEnv`'s configuration-attempt gate now excludes the `STAGING_APP_URL` fallback. Verified manually: `STAGING_APP_URL` alone now exits 0 with the SKIPPED message (was exit 2). |
| SHOULD FIX 7 | Two weak `http.test.ts` assertions | **Fixed** — `toBe(5)` (was `toBeLessThanOrEqual`) and a pinned `toEqual([0, 1, 0, 1])` (was `toBeGreaterThan(0)`), the exact sequence observed by running the test rather than hand-derived. Independently mutation-tested by the reviewer subagent: a serial implementation kills the first, a broken deadline check kills the second. |

## Issues found by the independent review round and fixed

1. `runApiLoad`'s pass-detail string said "across 12 endpoints" after MUST
   FIX #1 made only 11 feed the pooled totals — a factual error in the exact
   string pasted into the table issue #83's deploy gate reads. Now computed
   dynamically and reworded to "authenticated endpoints."
2. `documentation/performance-testing.md` §6 never disclosed either
   behavioral change (health exclusion, pacing) to an operator reading the
   doc. Two new bullets added.
3. The new commit column reports the harness's local checkout, which
   routinely differs from (and may be ahead of/behind, or dirty relative to)
   the staging deployment actually being measured — could read as false
   provenance. Now documented explicitly, with a `-dirty` suffix.
4. The rate-limit backoff logic had no test coverage and didn't use the
   module's injectable-time pattern. Extracted to a pure, exported,
   unit-tested `resolveBackoffMs`.
5. The `poolAggregates` regression test's excluded (`persona: "none"`)
   fixture only had nonzero `samples`/`ok`, so a partial regression (pooling
   samples/ok correctly but still leaking `rateLimited`/`errors` into the
   error-rate gate) would have gone undetected. Fixture strengthened.

## Verification (this stage, on the final state)

- `bun run typecheck` — clean.
- `bun run lint` — clean (1 pre-existing warning in generated
  `coverage/lcov-report/`, unrelated to this branch's changes).
- `bun run test` — 120 suites / 2850 tests, all green.
- `bunx prettier --check` on every file this fix pass touched — clean (the
  ~100 other repo-wide warnings `bun run format:check` reports are confirmed
  pre-existing on this branch via `git stash`, not introduced here).
- `bun run check:git-secrets` — clean.
- Scope: `git diff --stat` confirms nothing under `app/**`, `lib/**`,
  `middleware.ts`, `schemas/**`, `supabase/**`, or `.github/workflows/ci.yml`
  was touched — only `tests/load/**`, `tests/unit/load/**`,
  `documentation/performance-testing.md`, and `.pipeline/*.md`.
- `git status --short` — clean tree of exactly the expected modified files,
  no untracked stragglers (MUST FIX #3's regression check).

## Positives

- `poolAggregates` and `resolveBackoffMs` were both extracted specifically
  to make previously network-path-only logic unit-testable — the right
  instinct given `tests/load/scenarios.ts`'s real load path is otherwise
  untested by design (70s+ wall-clock cost per spec §2).
- The backoff cap (`RATE_LIMIT_BACKOFF_CAP_MS`) was discovered by this fix
  pass's own end-to-end verification catching a real stall, and disclosed
  prominently in `.pipeline/test-results.md` rather than silently patched —
  exactly the behavior wanted from a stage reporting on itself.
- Both the PASS path (mock reproducing the real limiter) and the FAIL path
  (mock injecting a real error rate) were manually exercised, confirming the
  fix pass didn't overcorrect MUST FIX #2 into "the harness can never fail."
- An independent reviewer pass was used deliberately rather than
  self-review only, consistent with this repo's prior experience (issues
  #64, #66) that self-review after a fix pass can miss regressions the fix
  itself introduces — and it did find 5 real issues here, all now resolved.
- Token hygiene holds throughout: no token value appears in stdout, the
  markdown table, or any error string in either the original implementation
  or this fix pass; `check:git-secrets` stays clean.

## For the human sign-off

No real staging credentials exist in this environment, so AC1–AC4's actual
measurements against staging were never taken — this was true of the
original implementation and remains true here (by design; see
`.pipeline/spec.md`'s Verification section). `documentation/performance-testing.md`
§7 still has placeholder rows; an operator with real
`LOAD_TEST_ADMIN_TOKENS`/`LOAD_TEST_MEMBER_TOKENS` needs to run
`bun run test:load --markdown` against actual staging and paste the result
over the placeholders before issue #83's deploy gate has a real pass to
read.
