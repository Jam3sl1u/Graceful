# Test Results — Issue #81: Run performance/load test pass against staging

**Overall: PASS.** All coder-claimed checks reproduced independently, plus
new tests added for two gaps in the coder's own coverage (`tests/load/env.ts`
had zero unit tests, and `tests/load/scenarios.ts` had none at all beyond a
real `bun run test:load` smoke pass). Everything is green.

## What was independently re-run

| Check | Result |
| --- | --- |
| `bun run typecheck` | Clean |
| `bun run lint` | Clean |
| `bun run format:check` (grep'd for `tests/load\|tests/unit/load`) | No output — no formatting issues in this change's files (repo-wide pre-existing ~100-file format:check failure, confirmed unrelated, unchanged) |
| `bun run test` (full suite) | **120 suites / 2839 tests, all green** (was 118/2817 before my 2 new files; +2 suites, +22 tests) |
| `bun run check:git-secrets` | Clean |
| `bun run check:workflows` | Clean (unaffected by this change, as expected) |
| `bunx jest --listTests \| grep -i load` | Confirms only `tests/unit/load/*.test.ts` (now 6 files) are Jest-visible; `tests/load/**` itself is not picked up, matching spec §2/§7 |
| `bun run tests/load/run.ts` with no env vars | `SKIPPED: load harness not configured...`, exit `0` |

## New tests added (this stage)

### `tests/unit/load/env.test.ts` (new — no test file existed for `env.ts`)

Spec's file table (§2) doesn't list an `env.test.ts`, but `readEnv` is pure,
security-sensitive (token handling / never-echo requirement), and drives the
CLI's exit-0/exit-2 branch — worth independent coverage. 10 tests:
happy-path `configured` (multi-token, trailing-slash-stripped base URL,
`STAGING_APP_URL` fallback, whitespace/empty-token trimming), `unconfigured`
when nothing is set, `partial` when some-but-not-all vars are set (incl. the
edge case of an env carrying *only* the optional `LOAD_TEST_SONG_ID`, and a
token-list-of-only-commas collapsing to empty ⇒ `partial`), and a check that
a real-looking token value never appears in the `partial` state's `missing`
list. All pass.

### `tests/unit/load/scenarios.test.ts` (new — this module had no unit test file at all)

Mocks `global.fetch` to independently verify the parts of `scenarios.ts` that
don't depend on `LOAD_PROFILE`'s real 60s-duration/10s-ramp-up load path
(see "Known limitation" below for why the load path itself isn't unit-tested
here — this matches, and confirms as reasonable, the coder's own rationale
for excluding this file from spec §2's test list). 12 tests covering:

- `preflight`: happy path (all 2xx), a named failure entry for a non-2xx
  endpoint (`"GET /api/instruments: HTTP 500"`), the single-retry-after-429
  path (verified via a real ~1s wait, not mocked away), and that the
  signed-URL endpoint is/isn't probed depending on `songId`.
- `runNotificationLatency`: always `blocked`, **zero** `fetch` calls (spec
  OPEN QUESTION 1's "never fabricate a number" contract), detail names both
  stub client files.
- `runSignedUrlLoad`: `skipped` with zero `fetch` calls when `songId` is
  null (edge case explicitly named in spec §4 item 9).
- `runRateLimitProbe`: happy-path pass (all-429/valid-`Retry-After`/
  `RATE_LIMITED` responses, confirms the short-circuit exactly at
  `policy.limit` calls, not `limit + 20`), a failure case (never 429s), plus
  two more failure cases (invalid `Retry-After`, wrong error `code`), and a
  check that a token value never leaks into `result.detail`/`result.measured`.

All 12 pass. **One bug was caught and fixed in my own test, not the
implementation**: my first draft used `jest.fn().mockResolvedValue(response)`
for scenarios that call `fetch` many times in a loop (`runRateLimitProbe` up
to 240+ times); since a `Response` body can only be read once, every call
after the first got a `""` body on `.text()`, which made `errorCode` parse to
`null` and the probe's `code === "RATE_LIMITED"` check fail spuriously.
Switched to `jest.fn(async () => jsonResponse(...))` so each call gets a
fresh `Response` instance — this is a Jest-mock/`fetch`-body-stream gotcha,
not a defect in `tests/load/scenarios.ts` itself (confirmed via a standalone
Bun script hitting `runRateLimitProbe` directly with a real per-call
`Response`, which passed before the test fix too).

## Manual smoke verification against a local mock HTTP server

No real staging credentials exist in this environment (by design, per spec
§7 — "do not attempt a real staging run"), so, like the coder, I exercised
the live CLI/scenario code paths against a throwaway `Bun.serve` mock
(`/private/tmp/.../scratchpad/mock-server.ts`, not part of the repo,
discarded after use):

- **Partial env** (`LOAD_TEST_BASE_URL` only) → lists the two missing vars,
  exit `2`. Matches.
- **Invalid `--scenario bogus`** → `Invalid --scenario value: bogus`, exit
  `2`. Matches.
- **Preflight failure** (mock returns 500 for `/api/instruments`) →
  `Preflight failed:\n  - GET /api/instruments: HTTP 500`, exit `2`, no hang.
  Matches spec §4 item 7 / §5.
- **`--scenario rate-limit`** against a mock that lets 2 requests through
  then 429s everything → `[PASS] Rate limit probe`, exit `0`, and the
  `--markdown` table's base-URL cell is host-only (`127.0.0.1:8934`) with no
  token anywhere in stdout. Matches.
- **`--scenario rate-limit`** against a mock that never 429s → `[FAIL]`,
  reason `no 429 observed`, exit `1`. Matches.
- **`--scenario notifications`** → `[BLOCKED]`, zero-network, exit `3`.
  Matches.
- **`--scenario signed-url`** with no `LOAD_TEST_SONG_ID` → `[SKIPPED]`,
  exit `3`. Matches.

## Spec cross-checks (source-of-truth verification, not just reading the diff)

- All 12 `API_ENDPOINTS` paths resolve to real, non-`notImplemented` `GET`
  handlers under `app/api/**` — confirmed by `find` + `grep` against the
  actual route/handler files, not just trusting `changes.md`.
- The four `admin`-persona endpoints (`/api/conflicts`,
  `/api/service-weeks/overview`, `/api/church-group/audit-log`,
  `/api/instruments`) each call `requireRole(ctx, ["admin", ...])` in their
  handler — confirmed by `grep`, so `persona: "admin"` is correct for all
  four.
- `EXPECTED_RATE_LIMIT_POLICIES` in `tests/load/targets.ts` textually matches
  `RATE_LIMIT_POLICIES` in `lib/api/rate-limit.ts` (also asserted by
  `tests/unit/load/targets.test.ts`'s `toEqual` check, which passes).
- `runNotificationLatency`'s cited blockers all check out: `sendSms`
  (`lib/pingram/client.ts:5`) and `sendEmail` (`lib/resend/client.ts:4`) are
  throwing stubs; both webhook routes call `notImplemented(...)`; the
  `notifications` table (migration `20260702000005_cluster_5_partial.sql`)
  has no dispatch/delivery timestamp columns near the cited line.
- `documentation/performance-testing.md` contains all 8 required §6 sections,
  the exact §5 exit-code table, and the §6 known-limitations bullets
  verbatim as spec'd; `README.md` and `documentation/staging-environment.md`
  §9 additions match spec §2 exactly, with no other section renumbered.

## Known limitation (not a defect — confirms the coder's own scoping)

`runApiLoad` and `runSignedUrlLoad` call `runConcurrent` with the real,
hardcoded `LOAD_PROFILE` (100 concurrency / 60s duration / 10s ramp-up) and
never pass `now`/`sleep` overrides, so even with a fully mocked `fetch` a
direct unit test of either function would take 70+ seconds of real
wall-clock time per test. This is why I did not attempt to unit-test them
directly (mirroring the coder's own documented rationale for leaving
`scenarios.ts` out of spec §2's test list) — `runApiLoad`/`runSignedUrlLoad`'s
actual load-generation behavior is only exercised by a real
`bun run test:load` pass, which requires staging credentials this
environment doesn't have. This is a pre-existing scope boundary from the
spec, not something this stage is flagging as a gap to fix.

## Items the Reviewer should specifically weigh in on

These are carried over from `.pipeline/changes.md`'s own "what the Tester
should focus on" list — I confirmed the logic behaves as documented, but the
underlying *design choices* are worth a second, independent judgment call:

1. `lastApiLoadRateLimitedTotal`'s module-level-variable hand-off between
   `runApiLoad` and `runRateLimitProbe` (confirmed working via manual CLI
   smoke test — `runRateLimitProbe` run alone correctly reports "not run
   this session"; the non-zero-count path via a real `runApiLoad` call
   wasn't exercised here since that requires the real 60s+10s load path
   above).
2. Whether a Bun+TS hand-rolled harness (vs. k6) is an acceptable reading of
   the AC's "k6 (or similar)" — this is a judgment call the spec already made
   as a non-blocking decision, not a code-behavior question testing can
   settle.

## Files touched by this stage

- Added `/Users/jamesliu/Documents/Graceful/.claude/worktrees/issue-81/tests/unit/load/env.test.ts`
- Added `/Users/jamesliu/Documents/Graceful/.claude/worktrees/issue-81/tests/unit/load/scenarios.test.ts`
- No other files modified. No application code (`app/**`, `lib/**`,
  `middleware.ts`, `schemas/**`, `supabase/**`) touched, consistent with
  spec scope.
