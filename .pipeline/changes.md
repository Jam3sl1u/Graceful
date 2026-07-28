# Changes — Issue #66: Sprint 3 E2E tests for setlist & calendar flows

Implemented exactly per `.pipeline/spec.md`. Tests only — no `app/`, `lib/`,
`schemas/`, `components/`, or `supabase/migrations/` changes.

## Files changed

### `tests/e2e/support/fixtures.ts` (modified)
- Added `seedSong(svc, churchGroupId, opts?)` — inserts one `songs` row with a
  unique default title (`E2E Song ${randomSuffix}`), returns `{ id, title }`.
- Added `seedSyntheticUser(svc, churchGroupId, opts?)` — inserts a `users` row
  with no real Clerk identity (`clerk_id: e2e_synthetic_<uuid-no-dashes>`),
  used only as a notification recipient / invitation target; documented that
  it must never be signed in via `signInAs`.
- Extended `TeardownIds` with `invitationIds`, `songIds`,
  `googleTokenUserIds`, `userIds`.
- Extended `teardownFixtures` to delete, in FK-safe order (children first):
  each id in `invitationIds` (alongside the existing single `invitationId`),
  then `songs` (`in songIds`), `google_calendar_tokens` (`in
  googleTokenUserIds`), and finally `users` (`in userIds`) — commented that
  `userIds` must only ever contain ids from `seedSyntheticUser`, never the
  stable `FIXTURE.adminUserId`/`FIXTURE.memberUserId`.

### `tests/e2e/support/google.ts` (new)
Google-side helpers for the calendar sync spec. Does not import from `lib/`
or `app/` (those start with `import "server-only"`, which throws under the
plain-Node Playwright runner) — `toGoogleEventId` and the AES-256-GCM
`encryptE2EToken` are hand-duplicated from `lib/google-calendar/sync.ts` and
`lib/google-calendar/token-crypto.ts` respectively, each commented with its
source of truth. Also exports `GOOGLE_SYNC_VARS`/`googleSyncEnabled` (checked
via `checkEnv`, deliberately not added to `env.ts`'s `REQUIRED_VARS`),
`e2eCalendarId`, `seedGoogleCalendarToken` (upserts a
`google_calendar_tokens` row with `token_expiry` in the past so the app
always takes the refresh-token path), `getGoogleAccessToken` (test-side
refresh-token exchange), `getGoogleCalendarEvent`, and
`deleteGoogleCalendarEvent` (never throws — cleanup-only).

### `tests/e2e/setlist-publish.spec.ts` (new, AC #1/#2)
- Test A: admin builds a setlist in `/setlists/[id]` (search → Add → 1 song →
  Publish → confirm-modal Publish), asserts `setlists.status === "published"`
  and `published_at` truthy, asserts the confirmed member (`accepted`
  invitation) gets exactly one `setlist_released` notification with
  `body === null`, asserts a synthetic **pending**-invitation member gets
  **zero** notifications, then confirms the member sees the song + `Confirmed`
  badge on `/member-week/[id]`.
- Test B: same flow with zero songs — asserts the zero-song copy in both the
  publish confirm modal and the resulting notification `body` (exact string,
  em dash included), and that the member view shows `No songs added yet`
  (not `Setlist not yet released`).
- Both resolve the "two buttons named Publish" ambiguity (bottom bar + modal,
  `Modal` has no `role="dialog"`) by asserting `toHaveCount(2)` then clicking
  `.last()`, per spec edge case 3.
- Header comment documents OPEN QUESTION 1's resolution (published setlists
  are tenant-readable per RLS; the actual confirmed/pending distinction is in
  notification recipients, not read access).

### `tests/e2e/setlist-duplicate-song.spec.ts` (new, AC #3)
One test, driven by the member fixture temporarily elevated to `set_leader`
(restored in `finally`, first statement, mirroring
`conflict-detection.spec.ts`'s self-exclusion test). Adds a song via
`POST /api/setlists/:id/songs` (201), repeats the same request (409,
`error: "That song is already in the setlist.", code: "CONFLICT"`), asserts
exactly one `setlist_songs` row persisted, then confirms the builder UI shows
the catalog row's button as `Added` and disabled.

### `tests/e2e/calendar-sync.spec.ts` (new, AC #4)
Gated on `e2eAuthEnabled && googleSyncEnabled` (`calendarSyncReady`) — skips
without both the base E2E secrets and the five new Google secrets. Seeds an
accepted invitation + a Google Calendar token for the member, creates an
event as admin, assigns the member as attendee (the create-propagation
trigger — a brand-new event has no attendees, so creation alone syncs
nothing), polls the real Google Calendar API (`expect.poll`, 30s timeout)
until the event appears with the right `summary`/`location`/`start.dateTime`,
then `PUT`s an update and polls again until the summary/start reflect the
change (proving update propagation, not just create). `finally` is fully
failure-tolerant: best-effort `DELETE /api/events/:id` (app-side unsync),
then a direct Google delete as a belt-and-braces cleanup, then context close,
then `teardownFixtures`.

### `.github/workflows/ci.yml` (modified)
Appended the five new `E2E_GOOGLE_*`/`E2E_TOKEN_ENCRYPTION_KEY` secrets to
the `e2e` job's `env:` block (the `check-secrets` gate on `STAGING_APP_URL`
is unchanged — `calendar-sync.spec.ts` self-gates on top of that via
`googleSyncEnabled`). Updated the job's leading comment to mention the
setlist publish and Google Calendar sync coverage (issue #66).

### `documentation/staging-environment.md` (modified)
Added the five new secrets to §7's table (each marked "optional —
`calendar-sync.spec.ts` skips when absent"), a note that the setlist specs
need no secrets beyond the existing seven, and a new **§7.1 Google Calendar
E2E (issue #66)** subsection with the human setup steps (dedicated Google
test account + same OAuth client as staging, one-time consent flow for
`calendar.events` scope with `access_type=offline`/`prompt=consent`,
`E2E_TOKEN_ENCRYPTION_KEY` must equal staging's `TOKEN_ENCRYPTION_KEY`,
`E2E_GOOGLE_CALENDAR_ID` defaults to `primary`, and the "Testing" OAuth
publishing-status refresh-token-expiry caveat).

### `.pipeline/spec.md`
Overwritten by the Planning stage for this run (was previously issue #65's
spec still on disk, uncommitted before this run started); included in this
commit since it's the git-tracked handoff artifact for this run.

## Verification run (all passed)
- `bun run typecheck`
- `bun run lint`
- `bun run test` (1040 tests, 81 suites — Jest ignores `tests/e2e/`)
- `bun run check:workflows`
- `bun run test:e2e` locally (no staging/Google secrets set): all 4 new
  tests (calendar-sync ×1, setlist-publish ×2, setlist-duplicate-song ×1)
  skip cleanly with no import/collect-time errors; `health.spec.ts` still
  passes (1 passed, 10 skipped).

## For the Testing stage to focus on
- The spec explicitly assigns `tests/unit/e2e-support/google.test.ts`
  (verifying `toGoogleEventId`/`encryptE2EToken` agree with their `lib/`
  counterparts) to the Testing stage, not this one — it does not exist yet.
- No product bugs were found while writing these tests; OPEN QUESTION 1 in
  `.pipeline/spec.md` documents a pre-existing behavior/AC-wording mismatch
  that this issue intentionally does not fix (out of scope).
- `calendar-sync.spec.ts` cannot be exercised end-to-end without a human
  provisioning the five Google secrets (§7.1) — verify it skips cleanly
  rather than trying to make it pass.
