# Test Results — Issue #66: Sprint 3 E2E tests for setlist & calendar flows

## Summary: ALL PASS

Independently re-ran every verification the Coding stage claimed, and added
the Jest unit coverage the spec explicitly assigned to the Testing stage
(`.pipeline/spec.md` "For the Testing stage (not the Coder's job)" and
`.pipeline/changes.md` "For the Testing stage to focus on").

## New test file added by this stage

### `tests/unit/e2e-support/google.test.ts` (new)

Covers `tests/e2e/support/google.ts`'s two hand-duplicated pure functions
(`toGoogleEventId`, `encryptE2EToken`) plus its env-gating (`googleSyncEnabled`,
`e2eCalendarId`) — per the spec's explicit assignment of this file to the
Testing stage, since Jest (unlike Playwright) maps `server-only` to a mock and
can therefore import both the real `lib/google-calendar/` implementations and
the `tests/e2e/support/` duplicates side by side.

- **Happy path**: `toGoogleEventId` agrees with `lib/google-calendar/sync.ts`'s
  version for a representative uuid; `encryptE2EToken` round-trips through
  `lib/google-calendar/token-crypto.ts`'s `decryptToken`; `googleSyncEnabled`
  is `true` when all base E2E vars + the four Google vars are set;
  `e2eCalendarId()` returns the env var when set.
- **Edge cases (named/implied by the spec)**:
  - `toGoogleEventId` agreement holds for a uuid with uppercase hex digits
    (both sides lowercase).
  - `encryptE2EToken` produces a distinct ciphertext (distinct IV) for two
    encryptions of the same plaintext (mirrors the analogous test in
    `tests/unit/lib/google-calendar/token-crypto.test.ts`).
  - `googleSyncEnabled` is `false` when any one of the four Google-specific
    vars is missing.
  - `googleSyncEnabled` is `false` when the Google vars are all set but a base
    `REQUIRED_VARS` var (e.g. `STAGING_APP_URL`) is missing — verifies
    `checkEnv(GOOGLE_SYNC_VARS)`'s actual AND semantics with the base vars
    (discovered by writing the test — see "Note" below).
  - `e2eCalendarId()` defaults to `"primary"` when unset.
- **Failure cases**:
  - `encryptE2EToken` throws `"E2E_TOKEN_ENCRYPTION_KEY must decode to exactly
    32 bytes"` for a malformed key.
  - `encryptE2EToken` throws `"Missing required env var for E2E tests:
    E2E_TOKEN_ENCRYPTION_KEY"` when the key env var is unset.

Result: **11/11 passed** (`bun run test -- tests/unit/e2e-support/google.test.ts`).

**Note (not a bug):** my first draft assumed `googleSyncEnabled` only depended
on the four `GOOGLE_SYNC_VARS`. It also requires the base `REQUIRED_VARS` from
`tests/e2e/support/env.ts`, because `checkEnv(extra)` always ANDs
`REQUIRED_VARS` with whatever `extra` array is passed — `google.ts` calls
`checkEnv(GOOGLE_SYNC_VARS)`, so both sets are required together. This matches
the spec's description ("checked via `checkEnv`") and `calendar-sync.spec.ts`'s
own `calendarSyncReady = e2eAuthEnabled && googleSyncEnabled` (redundant-looking
but consistent with this semantics). I corrected the test to assert the actual
(correct) behavior rather than my initial wrong assumption.

## Independent re-verification of the Coding stage's claims

All run fresh in this worktree (`/Users/jamesliu/Documents/Graceful/.claude/worktrees/issue-66`):

| Check | Command | Result |
|---|---|---|
| Typecheck | `bun run typecheck` | PASS — no errors |
| Lint | `bun run lint` | PASS — no errors/warnings |
| Unit tests | `bun run test` | PASS — **82 suites, 1051 tests** (1040 baseline + 11 new in `google.test.ts`; confirms the new file is collected and green, and nothing else regressed) |
| Workflow-script check | `bun run check:workflows` | PASS — "1 workflow script(s) checked — syntax valid, all agent() calls pinned." |
| E2E local run (no staging/Google secrets) | `bun run test:e2e` | PASS — **1 passed, 10 skipped**: `health.spec.ts` passes; all 4 new specs (`calendar-sync.spec.ts` ×1, `setlist-publish.spec.ts` ×2, `setlist-duplicate-song.spec.ts` ×1) skip cleanly via `test.skip`, no import/collect-time errors; pre-existing specs skip as before |

Confirmed no `env` vars for staging/Google were present in this shell
(`env | grep -iE "STAGING|E2E_|CLERK"` returned nothing), so the skip behavior
above is a genuine "secrets absent" run, not an accidental pass.

## Manual code review (spot-checked against spec.md, not just trusted changes.md)

- `tests/e2e/support/fixtures.ts`: `seedSong`, `seedSyntheticUser`,
  `TeardownIds` extensions, and `teardownFixtures` ordering all match the
  spec's field-by-field description (unique song title generator, synthetic
  user's `clerk_id`/`email` shape, FK-safe teardown order, and the guarding
  comment on `userIds` never receiving `FIXTURE` ids).
- `tests/e2e/support/google.ts`: no `lib/`/`app/` imports (confirmed via
  read); `toGoogleEventId` and `encryptE2EToken` are byte-for-byte consistent
  with `lib/google-calendar/sync.ts` / `lib/google-calendar/token-crypto.ts`
  (now also machine-verified by the new unit test, not just read-verified).
- `tests/e2e/setlist-publish.spec.ts`: both tests match the spec's numbered
  steps, including the two-buttons-named-Publish disambiguation
  (`toHaveCount(2)` then `.last()`), the exact zero-song notification body
  string (em dash), and `notificationLinkEntityIds` guarded by
  `setlistId ? [setlistId] : []` so teardown is safe even if setlist creation
  fails.
- `tests/e2e/setlist-duplicate-song.spec.ts`: matches spec — 201 then 409 with
  the exact error/code, `setlist_songs` row-count assertion, UI `Added`+
  disabled assertion, role restore as the first `finally` statement.
- `tests/e2e/calendar-sync.spec.ts`: matches spec — invitation seeded
  `accepted` before the event (BR-10-safe timestamps), attendee-POST as the
  create-propagation trigger, `expect.poll` (not `waitForTimeout`) for both
  create and update propagation, fully failure-tolerant `finally` (each step
  independently try/caught) with both app-side DELETE and a direct Google
  delete fallback, `googleTokenUserIds` teardown.
- `.github/workflows/ci.yml`: the five new secrets are appended to the `e2e`
  job's existing `env:` block only; `check-secrets` gate on `STAGING_APP_URL`
  is unchanged.
- `documentation/staging-environment.md`: five new secrets documented in the
  §7 table (each marked optional/skips-when-absent) plus a new §7.1 with the
  human setup steps (shared OAuth client, one-time consent flow,
  `E2E_TOKEN_ENCRYPTION_KEY` must equal staging's, `E2E_GOOGLE_CALENDAR_ID`
  default, "Testing" publishing-status refresh-token-expiry caveat).
- Confirmed no changes touch `app/`, `lib/`, `schemas/`, `components/`, or
  `supabase/migrations/` (`git status`/`git diff --stat` show only `tests/`,
  `.github/workflows/ci.yml`, `documentation/staging-environment.md`, and
  `.pipeline/` changed — scope matches the spec's "tests only" constraint).

## Not independently exercised (as the spec anticipated)

- `calendar-sync.spec.ts`'s actual assertions against a real Google Calendar
  were not exercised — no `E2E_GOOGLE_*` secrets exist in this environment
  (by design; §7.1 requires human provisioning). Verified instead that it
  skips cleanly, which is the correct behavior in this state, per spec OPEN
  QUESTION 2.
- `setlist-publish.spec.ts` / `setlist-duplicate-song.spec.ts` against real
  staging (no `E2E_ADMIN_EMAIL`/staging secrets in this environment either) —
  same treatment: verified clean skip, matching the established issue #52
  precedent this repo already relies on for the rest of the authenticated E2E
  suite.

## Verdict

No product bugs found. No failing tests. All checks the spec and changes.md
called for are green, including the one new test file this stage was
responsible for adding. Ready for Review.
