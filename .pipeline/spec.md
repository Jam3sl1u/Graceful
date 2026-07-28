# Spec — Issue #66: [Sprint 3] Write E2E tests for setlist & calendar flows

## OPEN QUESTIONS

**None blocking — do not stop the pipeline.** Two things a human should be aware
of are recorded here because they shape the assertions; both have a defensible
resolution already baked into this spec.

1. **AC #1 says "members who are still pending do not [see the setlist]" — the
   implemented behavior is different, and this spec tests the implemented
   behavior.** Verified in `supabase/migrations/20260704000001_rls_policies.sql`
   (`setlists_select_published_members`): once a setlist is `published`, **every**
   user in the church group can read it, regardless of invitation status. The
   real confirmed-vs-pending distinction lives in `publishSetlist`
   (`app/api/setlists/[id]/handler.ts`): only users with an `accepted` invitation
   for the parent service week get a `setlist_released` notification. So the test
   asserts *the confirmed member is notified and sees the songs in their week
   view; the pending member is NOT notified*. Writing the literal AC wording
   would produce a permanently-red test with no in-scope fix (this issue adds
   tests only, it does not change product behavior). If tenant-wide read of a
   published setlist is considered wrong, that is a separate product issue.

2. **AC #4 (Google Calendar) cannot execute in CI until a human provisions a
   Google test identity.** `tests/e2e/calendar-sync.spec.ts` is written to run
   for real against Google, and gates itself on five new secrets (listed under
   "Human setup required" below) exactly like the rest of the suite gates on
   `e2eAuthEnabled`. Until those secrets exist, that one spec skips (it does not
   fail). This mirrors the established precedent from issue #52 (the whole
   authenticated suite skipped until the human provisioned Clerk test users and
   staging Supabase secrets).

## Goal

Add Playwright E2E coverage, running against the deployed staging app, for the
Sprint 3 setlist publish flow and the Google Calendar event-sync flow. **Tests
only** — no changes to `app/`, `lib/`, `schemas/`, `components/`, or
`supabase/migrations/`. If a test appears to reveal a product bug, report it in
`.pipeline/changes.md`; do not fix it here.

PRD ref: Phase 1 PRD §16.2. Harness to reuse: issue #52's (`tests/e2e/support/`).

## Current state (verified by reading the code)

- Harness exists and is the pattern to copy:
  - `tests/e2e/support/env.ts` — `REQUIRED_VARS`, `e2eAuthEnabled`,
    `checkEnv(extra)`, `requireEnv(name)`.
  - `tests/e2e/support/db.ts` — `getE2EServiceClient()` (service role, seed/
    assert/teardown only).
  - `tests/e2e/support/auth.ts` — `signInAs(page, "admin" | "member")`.
  - `tests/e2e/support/fixtures.ts` — stable `FIXTURE`
    (`churchGroupId` / `adminUserId` / `memberUserId`), `futureDateString`,
    `seedServiceWeek`, `seedInvitation`, `setMemberRole`, `teardownFixtures`.
  - `tests/e2e/support/global-setup.ts` — `clerkSetup()` + `ensureChurchFixture`.
  - `playwright.config.ts` — `fullyParallel: false`, `workers: 1`,
    `baseURL = STAGING_APP_URL`, `globalSetup`.
- Existing specs to mirror in style: `tests/e2e/conflict-detection.spec.ts`
  (two browser contexts + `signInAs` + `page.request`), `invitation-accept.spec.ts`
  (UI click + service-role DB assertions + `finally` teardown),
  `invitation-reminder.spec.ts` (`checkEnv([...])` for spec-specific extras),
  `invitation-deny.spec.ts` (tracked always-skipped placeholder test).
- Jest ignores `tests/e2e/` (`jest.config.js` `testPathIgnorePatterns`), so new
  files there never run under `bun run test`. They **do** get typechecked by
  `bun run typecheck`.
- `app/api/setlists/[id]/handler.ts`:
  - `addSetlistSong` — BR-07 duplicate returns **409** with
    `{ error: "That song is already in the setlist.", code: "CONFLICT" }`.
  - `publishSetlist` — draft→published; inserts one `notifications` row per
    **accepted** invitation on the parent week, `type: "setlist_released"`,
    `title: "Setlist published"`, `link_entity_type: "setlist"`,
    `link_entity_id: <setlistId>`, and
    `body: songCount === 0 ? "The setlist has been published — songs are still being added." : null`.
    Zero songs is a valid publishable state (BR-01). Second publish → 409.
- `app/api/service-weeks/[id]/setlist/handler.ts` `createSetlist` — get-or-create,
  `POST /api/service-weeks/:id/setlist`, no body, 200 if one exists / 201 if
  created. A service week seeded directly via service role has **no** setlist
  row (auto-creation only happens inside `createServiceWeek`), so tests must
  call this endpoint to obtain a setlist id.
- `app/(app)/setlists/[id]/setlist-builder.tsx` (Set Leader builder UI):
  heading `Setlist Builder`; `Badge` text `Draft` / `Published`; catalog input
  `placeholder="Search songs…"`; each catalog row has a button reading `Add`,
  which becomes `Added` **and disabled** once that song is in the setlist;
  bottom bar shows `"1 song"` / `"N songs"` and a `Publish` button; the confirm
  `Modal` shows heading `Publish this setlist?`, body
  `This setlist has no songs yet. It will be published with no songs.` when
  empty else `Confirmed members will be notified once you publish.`, and its own
  `Publish` button. Published state shows
  `This setlist is published and locked for editing.` `Modal`
  (`components/ui/Modal.tsx`) has **no** `role="dialog"` — see edge cases.
- `app/(app)/member-week/[id]/member-week-view.tsx` + its `member-view` handler:
  a member sees `Setlist not yet released` (no/draft setlist),
  `No songs added yet` (published, zero songs), or the ordered song list.
  Confirmation `Badge` reads `Confirmed` for an accepted invitation, `Pending`
  for pending.
- Google Calendar sync (`lib/google-calendar/sync.ts`, `app/api/events/**`):
  - `POST /api/events` assigns `google_calendar_event_id = toGoogleEventId(uuid)`
    = `"gr" + uuid.replace(/-/g,"").toLowerCase()`, then best-effort syncs to
    **already-assigned attendees** (a brand-new event has none).
  - `POST /api/events/:id/attendees` (admin/set_leader; target must have an
    `accepted` invitation for the week) → `syncEventToUser` → PATCH-then-POST
    upsert onto that member's calendar. **This is the create-propagation trigger.**
  - `PUT /api/events/:id` → `syncEventToAttendees` → PATCH on every assigned
    attendee's calendar. **This is the update-propagation trigger.**
  - `DELETE /api/events/:id` unsyncs before deleting.
  - Sync targets come from the `get_event_sync_targets` RPC: rows in
    `event_attendees` joined to `google_calendar_tokens` where `is_valid = true`.
  - `resolveAccessToken` refreshes via the stored **refresh** token whenever
    `token_expiry` is within 60s of now (or already past); on that path the
    stored access token is never decrypted.
  - BR-10 (`schemas/events.ts` `validateEventTiming`): start/end must be within
    72h of `${serviceDate}T00:00:00.000Z`, end after start, else 422.
- Table shapes confirmed: `service_weeks` deletion **cascades** `setlists`,
  `setlist_songs`, `events`, `event_attendees`, `invitations`. `users` deletion
  cascades `invitations`, `notifications`, `google_calendar_tokens`. `songs` and
  `notifications` are NOT cascaded by a service-week delete. `users.clerk_id` is
  `varchar(50) UNIQUE`; `users.email` is `varchar(255) UNIQUE`.

## Files to create / modify

### 1. MODIFY `tests/e2e/support/fixtures.ts`

Add three helpers and extend teardown. Keep the existing exports and the file's
explanatory header comment intact; follow its existing style (throw
`new Error("<fn> failed: ${error.message}")` on any Supabase error).

```ts
export async function seedSong(
  svc: SupabaseClient,
  churchGroupId: string,
  opts?: { title?: string; artist?: string | null; defaultKey?: string | null },
): Promise<{ id: string; title: string }>;
```
Inserts one `songs` row with an app-generated `crypto.randomUUID()` id.
Default title MUST be unique per call:
`` `E2E Song ${crypto.randomUUID().slice(0, 8)}` ``. Columns:
`id, church_group_id, title, artist (default null), default_key (default null),
created_by: FIXTURE.adminUserId`. Returns the id and the resolved title.

```ts
export async function seedSyntheticUser(
  svc: SupabaseClient,
  churchGroupId: string,
  opts?: { role?: "member" | "set_leader" | "admin"; name?: string },
): Promise<string>; // returns users.id
```
Inserts a `users` row that has **no Clerk identity** — it exists only to be a
notification recipient / invitation target and must never be signed in as.
`id: crypto.randomUUID()`,
`clerk_id: \`e2e_synthetic_${crypto.randomUUID().replace(/-/g, "")}\`` (46 chars,
fits `varchar(50)`),
`email: \`e2e-synthetic-${<same suffix, first 8 chars>}@example.invalid\``,
`role: opts?.role ?? "member"`, `name: opts?.name ?? "E2E Synthetic Member"`,
`phone: null`, `sms_opted_in: false`, `anonymized_at: null`. Document in a
comment why the fixture is synthetic (only one real Clerk member persona exists,
and `clerk_id` is UNIQUE — same constraint the file header already explains).

Extend `TeardownIds` with four optional fields (leave existing ones unchanged):

```ts
export type TeardownIds = {
  serviceWeekId?: string;
  invitationId?: string;
  invitationIds?: string[];       // NEW — tests that seed more than one
  conflictId?: string;
  notificationLinkEntityIds?: string[];
  availability?: { userId: string; date: string };
  songIds?: string[];             // NEW
  googleTokenUserIds?: string[];  // NEW — google_calendar_tokens rows by user_id
  userIds?: string[];             // NEW — synthetic users only, never FIXTURE ids
};
```

`teardownFixtures` ordering (children first — extend the existing function, do
not reorder what is already there):
notifications → availability → conflicts → invitations (`invitationId` **and**
each of `invitationIds`) → `service_weeks` (cascades setlists/setlist_songs/
events/event_attendees) → `songs` (by `id in songIds`) →
`google_calendar_tokens` (by `user_id in googleTokenUserIds`) → `users`
(by `id in userIds`). Add a comment on the `userIds` branch that it must only
ever receive ids from `seedSyntheticUser`, never `FIXTURE.adminUserId` /
`FIXTURE.memberUserId`.

### 2. CREATE `tests/e2e/support/google.ts`

Google-side helpers for `calendar-sync.spec.ts`. **Must not import from `lib/`
or `app/`**: those modules start with `import "server-only"`, which throws when
imported by the plain-Node Playwright runner. The two small pure helpers below
are therefore deliberate duplicates — add a comment on each naming its source of
truth (`lib/google-calendar/sync.ts` `toGoogleEventId`,
`lib/google-calendar/token-crypto.ts` `encryptToken`) so they are kept in sync.

```ts
// Extra env vars, checked via checkEnv([...]) — NOT added to REQUIRED_VARS.
export const GOOGLE_SYNC_VARS = [
  "E2E_TOKEN_ENCRYPTION_KEY",
  "E2E_GOOGLE_CLIENT_ID",
  "E2E_GOOGLE_CLIENT_SECRET",
  "E2E_GOOGLE_REFRESH_TOKEN",
] as const;

export const googleSyncEnabled: boolean;      // checkEnv(GOOGLE_SYNC_VARS)
export function e2eCalendarId(): string;      // process.env.E2E_GOOGLE_CALENDAR_ID || "primary"

// AES-256-GCM, output "iv:authTag:ciphertext" (all base64), 12-byte IV,
// key = base64-decoded E2E_TOKEN_ENCRYPTION_KEY (must be exactly 32 bytes).
// Byte-for-byte compatible with lib/google-calendar/token-crypto.ts encryptToken.
export function encryptE2EToken(plaintext: string): string;

// "gr" + uuid without dashes, lowercased. Mirrors lib/google-calendar/sync.ts.
export function toGoogleEventId(eventUuid: string): string;

// Seeds/updates the member's google_calendar_tokens row so the app treats them
// as "Google Calendar connected". token_expiry is set in the PAST so the app's
// resolveAccessToken always takes the refresh path with the real refresh token
// (the access-token column is never decrypted on that path).
export async function seedGoogleCalendarToken(
  svc: SupabaseClient,
  userId: string,
): Promise<void>;

// Test-side refresh-token exchange (POST https://oauth2.googleapis.com/token,
// grant_type=refresh_token) so the test can read the calendar itself.
export async function getGoogleAccessToken(): Promise<string>;

export async function getGoogleCalendarEvent(
  accessToken: string,
  calendarId: string,
  googleEventId: string,
): Promise<{ status: number; body: Record<string, unknown> | null }>;

export async function deleteGoogleCalendarEvent(
  accessToken: string,
  calendarId: string,
  googleEventId: string,
): Promise<void>; // treats 404/410 as success; never throws (cleanup helper)
```

`seedGoogleCalendarToken` upserts (`onConflict: "user_id"`):
`user_id`, `access_token_encrypted: encryptE2EToken("e2e-placeholder-access-token")`,
`refresh_token_encrypted: encryptE2EToken(requireEnv("E2E_GOOGLE_REFRESH_TOKEN"))`,
`token_expiry: new Date(Date.now() - 60_000).toISOString()`,
`calendar_id: e2eCalendarId()`,
`scope: "https://www.googleapis.com/auth/calendar.events"`, `is_valid: true`.

Calendar REST base: `https://www.googleapis.com/calendar/v3`; event URL
`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(googleEventId)}`
with `Authorization: Bearer <accessToken>`.

Use `SupabaseClient` typed as in `tests/e2e/support/db.ts` (the loose
`SupabaseClient<any>` return type there is already eslint-suppressed; keep new
code free of new `any` or add the same narrowly-scoped suppression).

### 3. CREATE `tests/e2e/setlist-publish.spec.ts` (AC #1, AC #2)

Header comment: name the issue (#66), the ACs covered, and OPEN QUESTION 1's
resolution (published setlists are tenant-readable; the confirmed/pending
distinction that actually exists is notification recipients).

`test.describe("setlist publish", ...)` with
`test.skip(!e2eAuthEnabled, "requires staging E2E secrets — see tests/e2e/support/env.ts")`
as the first statement (same line as the existing specs).

**Test A — "a Set Leader/admin builds a setlist in the builder, publishes it,
and only confirmed members are notified"** (`async ({ browser })`):

1. `const svc = getE2EServiceClient()`; `serviceDate = futureDateString(8)`;
   `serviceWeekId = await seedServiceWeek(svc, FIXTURE.churchGroupId, serviceDate)`.
2. `const song = await seedSong(svc, FIXTURE.churchGroupId, { defaultKey: "G" })`.
3. `seedInvitation` for `FIXTURE.memberUserId`, `status: "accepted"`,
   `invitedBy: FIXTURE.adminUserId` → keep `id` as `confirmedInvitationId`.
4. `const pendingUserId = await seedSyntheticUser(svc, FIXTURE.churchGroupId)`;
   `seedInvitation` for `pendingUserId`, `status: "pending"` → `pendingInvitationId`.
5. In `try`: admin context → `adminPage.goto("/")` → `signInAs(adminPage, "admin")`.
6. `const createRes = await adminPage.request.post(\`/api/service-weeks/${serviceWeekId}/setlist\`)`;
   `expect(createRes.ok()).toBe(true)`; `setlistId = (await createRes.json()).data.setlist.id`.
7. `await adminPage.goto(\`/setlists/${setlistId}\`)`; expect heading
   `Setlist Builder` visible and text `Draft` visible.
8. `await adminPage.getByPlaceholder("Search songs").fill(song.title)`; click
   `adminPage.getByRole("button", { name: "Add", exact: true })` (unique because
   the title is unique — the client filters the catalog by substring); expect the
   bottom bar text `1 song` to be visible.
9. Click the bottom-bar `Publish`, then expect heading `Publish this setlist?`
   and text `Confirmed members will be notified once you publish.`; click the
   modal's Publish (see edge case 3 for disambiguation); expect text
   `This setlist is published and locked for editing.` and `Published`.
10. Service-role assertions:
    - `setlists` row `id = setlistId` → `status === "published"`,
      `published_at` truthy.
    - `notifications` where `user_id = FIXTURE.memberUserId`,
      `type = "setlist_released"`, `link_entity_id = setlistId` → length **1**,
      `title === "Setlist published"`, `body === null` (non-zero-song copy).
    - `notifications` where `user_id = pendingUserId`,
      `type = "setlist_released"`, `link_entity_id = setlistId` → length **0**
      (this is the AC's confirmed-vs-pending assertion).
11. Member context → `goto("/")` → `signInAs(memberPage, "member")` →
    `goto(\`/member-week/${serviceWeekId}\`)`; expect `song.title` visible and
    the `Confirmed` badge visible.
12. Close both contexts; `finally` → `teardownFixtures(svc, { serviceWeekId,
    invitationIds: [confirmedInvitationId, pendingInvitationId],
    notificationLinkEntityIds: [setlistId], songIds: [song.id],
    userIds: [pendingUserId] })`. `setlistId` is declared `let ... : string | undefined`
    outside the `try` so teardown works even if step 6 fails; guard the
    `notificationLinkEntityIds` entry accordingly.

**Test B — "a zero-song setlist publishes successfully with the zero-song
notification copy"** (`async ({ browser })`):

1. `serviceDate = futureDateString(9)`; seed week; seed an **accepted**
   invitation for `FIXTURE.memberUserId`.
2. Admin session; create the setlist via the same POST; open the builder.
3. Expect `No songs yet — add some from the catalog.` and `0 songs`.
4. Click the bottom-bar `Publish`; expect the modal heading and the zero-song
   copy `This setlist has no songs yet. It will be published with no songs.`;
   click the modal's Publish; expect `Published`.
5. Service-role assertions: `setlists.status === "published"`; exactly one
   `setlist_released` notification for `FIXTURE.memberUserId` with
   `link_entity_id = setlistId`, `title === "Setlist published"` and
   `body === "The setlist has been published — songs are still being added."`
   (exact string, em dash included — this is the AC's "correct notification copy").
6. Member session → `/member-week/${serviceWeekId}` → expect
   `No songs added yet` visible and `Setlist not yet released` **not** visible.
7. `finally` teardown: `{ serviceWeekId, invitationId,
   notificationLinkEntityIds: [setlistId] }`.

### 4. CREATE `tests/e2e/setlist-duplicate-song.spec.ts` (AC #3)

Same gate. One test, driven by the **member fixture temporarily elevated to
`set_leader`** so the suite has genuine Set Leader coverage of the builder —
copy the pattern and the safety comment from `conflict-detection.spec.ts`'s
self-exclusion test (`setMemberRole(svc, "set_leader")` inside `try`, restored to
`"member"` as the **first** statement of `finally`; safe only because
`playwright.config.ts` serializes this suite).

**Test — "adding the same song twice is rejected (BR-07) and the builder
disables Add for a song already in the setlist"** (`async ({ browser })`):

1. `serviceDate = futureDateString(10)`; seed week; `seedSong`.
2. `await setMemberRole(svc, "set_leader")`.
3. Member context → `goto("/")` → `signInAs(leaderPage, "member")`.
4. `POST /api/service-weeks/${serviceWeekId}/setlist` → `setlistId`.
5. First add: `leaderPage.request.post(\`/api/setlists/${setlistId}/songs\`,
   { data: { songId: song.id } })` → `expect(res.status()).toBe(201)`, response
   `data.songs` length 1.
6. Duplicate add: identical request → `expect(res.status()).toBe(409)`; body
   `error === "That song is already in the setlist."` and `code === "CONFLICT"`.
7. Service-role assertion: `setlist_songs` where `setlist_id = setlistId` and
   `song_id = song.id` → exactly **1** row (no duplicate persisted).
8. UI guard: `goto(\`/setlists/${setlistId}\`)`, fill the search box with
   `song.title`, expect the catalog row's button to read `Added` and be
   `disabled` (`toBeDisabled()`).
9. `finally`: restore the role, close the context, `teardownFixtures(svc,
   { serviceWeekId, songIds: [song.id] })`.

### 5. CREATE `tests/e2e/calendar-sync.spec.ts` (AC #4)

```ts
const calendarSyncReady = e2eAuthEnabled && googleSyncEnabled;
test.describe("google calendar event sync", () => {
  test.skip(
    !calendarSyncReady,
    "requires staging E2E secrets plus the Google Calendar E2E secrets (E2E_TOKEN_ENCRYPTION_KEY, E2E_GOOGLE_CLIENT_ID, E2E_GOOGLE_CLIENT_SECRET, E2E_GOOGLE_REFRESH_TOKEN) — see documentation/staging-environment.md §7.1",
  );
  ...
});
```

**Test — "an event created by an admin lands on a connected member's Google
Calendar, and an update to it propagates"** (`async ({ browser })`):

1. `serviceDate = futureDateString(11)`; `seedServiceWeek`; `seedInvitation` for
   `FIXTURE.memberUserId` with `status: "accepted"` (required — `assignAttendee`
   422s without an accepted invitation).
2. `await seedGoogleCalendarToken(svc, FIXTURE.memberUserId)`.
3. Admin context, signed in as `"admin"`.
4. `POST /api/events` with
   `{ serviceWeekId, type: "rehearsal", name: \`E2E Event ${suffix}\`,
   location: "E2E Hall", startTime: \`${serviceDate}T15:00:00.000Z\`,
   endTime: \`${serviceDate}T16:00:00.000Z\` }` (BR-10-safe) → expect 201;
   `eventId = body.data.event.id`.
5. `POST /api/events/${eventId}/attendees` with `{ userId: FIXTURE.memberUserId }`
   → expect 201. This is what pushes the event to the member's calendar.
6. `const googleEventId = toGoogleEventId(eventId)`;
   `const accessToken = await getGoogleAccessToken()`;
   `const calendarId = e2eCalendarId()`.
   ```ts
   await expect
     .poll(async () => (await getGoogleCalendarEvent(accessToken, calendarId, googleEventId)).status,
           { timeout: 30_000, intervals: [1_000, 2_000, 5_000] })
     .toBe(200);
   ```
   Then read the event once more and assert `summary === <name>`,
   `location === "E2E Hall"`, and
   `new Date(body.start.dateTime).toISOString() === "<startTime>"`.
7. `PUT /api/events/${eventId}` with
   `{ name: \`${name} (updated)\`, startTime: \`${serviceDate}T17:00:00.000Z\`,
   endTime: \`${serviceDate}T18:00:00.000Z\` }` → expect ok.
8. `expect.poll` the Google read until `summary === \`${name} (updated)\``
   (same timeout/intervals), then assert the start `dateTime` equals the new
   start — proving the update propagated, not just the create.
9. `finally`: best-effort `DELETE /api/events/${eventId}` via the admin session
   (this also unsyncs from Google), then
   `deleteGoogleCalendarEvent(accessToken, calendarId, googleEventId)` as a
   belt-and-braces cleanup (never throws), close the context, then
   `teardownFixtures(svc, { serviceWeekId, invitationId,
   googleTokenUserIds: [FIXTURE.memberUserId] })`. Every step in `finally` must
   be individually failure-tolerant so one cleanup error doesn't mask the test
   result.

### 6. MODIFY `.github/workflows/ci.yml`

In the **`e2e` job's `env:` block only**, append (keep everything else, including
the `check-secrets` gate keyed on `STAGING_APP_URL`, unchanged):

```yaml
      E2E_TOKEN_ENCRYPTION_KEY: ${{ secrets.E2E_TOKEN_ENCRYPTION_KEY }}
      E2E_GOOGLE_CLIENT_ID: ${{ secrets.E2E_GOOGLE_CLIENT_ID }}
      E2E_GOOGLE_CLIENT_SECRET: ${{ secrets.E2E_GOOGLE_CLIENT_SECRET }}
      E2E_GOOGLE_REFRESH_TOKEN: ${{ secrets.E2E_GOOGLE_REFRESH_TOKEN }}
      E2E_GOOGLE_CALENDAR_ID: ${{ secrets.E2E_GOOGLE_CALENDAR_ID }}
```

Update the `e2e` job's leading comment to mention that it now also covers the
setlist publish and Google Calendar sync flows (issue #66).

### 7. MODIFY `documentation/staging-environment.md`

- In §7's secrets table, add the five secrets above with one-line purposes, each
  marked "optional — `calendar-sync.spec.ts` skips when absent".
- Add a short **§7.1 Google Calendar E2E (issue #66)** subsection with the human
  setup steps: (a) use a dedicated Google test account and the **same** OAuth
  client the staging deployment uses (`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`)
  — a refresh token is only redeemable by the client that issued it;
  (b) complete the consent flow once for scope
  `https://www.googleapis.com/auth/calendar.events` with `access_type=offline`
  and `prompt=consent`, and store the resulting refresh token as
  `E2E_GOOGLE_REFRESH_TOKEN`; (c) `E2E_TOKEN_ENCRYPTION_KEY` must be **the same
  value** as staging's `TOKEN_ENCRYPTION_KEY`, otherwise the seeded token cannot
  be decrypted by the app; (d) `E2E_GOOGLE_CALENDAR_ID` defaults to `primary`;
  (e) note that if the Google OAuth app is left in "Testing" publishing status,
  Google expires refresh tokens after ~7 days, which will make the spec fail
  rather than skip — publish the app or re-mint the token.
- Also note in §7 that the setlist specs need no secrets beyond the existing
  seven.

## Edge cases the implementation MUST handle

1. **Skip, never fail, without secrets.** Every new spec's first statement inside
   `test.describe` is a `test.skip(...)` on the relevant readiness flag. Do not
   add any of the new Google vars to `REQUIRED_VARS` in
   `tests/e2e/support/env.ts` — that would silently disable the entire existing
   suite and break `tests/unit/e2e-support/env.test.ts`. Use `checkEnv([...])`.
2. **Serialized suite.** `workers: 1` / `fullyParallel: false` is load-bearing.
   Never add `test.describe.parallel`, never change `playwright.config.ts`. Any
   mutation of the shared fixture (`setMemberRole`) must be restored in `finally`.
3. **Two buttons named "Publish".** The bottom bar and the confirm modal both
   render one, and `components/ui/Modal.tsx` has no `role="dialog"` to scope by.
   Resolve deterministically: assert
   `await expect(page.getByRole("button", { name: "Publish", exact: true })).toHaveCount(2)`
   after opening the modal, then click `.last()` (the modal renders after the
   bottom bar in DOM order). Add a comment explaining why.
4. **Unique song titles.** Staging is a long-lived DB; a fixed title would
   accumulate rows and make both the catalog search and the `Add` button locator
   ambiguous. `seedSong`'s default title must include a fresh random suffix, and
   the tests must search by that exact title.
5. **Teardown always runs**, in `finally`, even when an assertion throws
   mid-test — including the browser `context.close()` calls. Ids that are only
   known after a request (setlist id, event id) must be declared `let` before the
   `try` and guarded in teardown.
6. **Never teardown the stable fixture.** `teardownFixtures`'s new `userIds`
   branch must only receive ids from `seedSyntheticUser`.
7. **The synthetic pending user has no Clerk identity** — never call `signInAs`
   for them; assert their (non-)notification via the service-role client only.
8. **Zero-song vs non-zero notification body.** `body` is `null` when the setlist
   has songs and the exact zero-song sentence when it doesn't. Assert both
   (they're two different ACs) and match the em dash exactly.
9. **BR-10 event timing.** `startTime`/`endTime` must be within 72h of
   `${serviceDate}T00:00:00.000Z` or `POST /api/events` returns 422. The times
   in this spec (15:00/16:00Z, updated to 17:00/18:00Z on the service date) are
   safe; keep them anchored to the service date.
10. **Sync trigger order matters.** A freshly created event has no attendees, so
    creation alone syncs nothing. The attendee POST is the create trigger, and it
    422s unless the member's invitation is `accepted` first. Seed in that order.
11. **`token_expiry` must be in the past** in the seeded
    `google_calendar_tokens` row, so the app takes the refresh path with the real
    refresh token; the placeholder access-token ciphertext is never decrypted
    there. `is_valid` must be `true` or `get_event_sync_targets` returns no rows.
12. **No `lib/`/`app/` imports in `tests/e2e/`.** Those modules
    `import "server-only"`, which throws in the Playwright (plain Node) runner.
    Duplicate `toGoogleEventId` and the AES-GCM encryption in
    `tests/e2e/support/google.ts` and comment the source of truth on each.
13. **Google eventual consistency.** Use `expect.poll` with a bounded timeout for
    both the create and the update read; never a bare `waitForTimeout`.
14. **Cleanup of remote Google state.** The test must remove the event from the
    real calendar in `finally` (via the app's DELETE plus a direct delete
    fallback) so repeat CI runs don't accumulate events.
15. **`POST /api/service-weeks/:id/setlist` returns 200 or 201** (get-or-create).
    Assert `res.ok()`, not a specific status.

## Patterns to copy (name the file, don't invent)

- Spec skeleton, imports, `finally` teardown: `tests/e2e/invitation-accept.spec.ts`.
- Multi-persona browser contexts + `signInAs` + `page.request.*`:
  `tests/e2e/conflict-detection.spec.ts`.
- Spec-specific extra env gating (`checkEnv([...])`):
  `tests/e2e/invitation-reminder.spec.ts`.
- Temporarily elevating the member fixture's role and restoring it:
  `tests/e2e/conflict-detection.spec.ts` (second test) + `setMemberRole` in
  `tests/e2e/support/fixtures.ts`.
- Seed-helper style (uuid generation, error messages, return shapes):
  `seedServiceWeek` / `seedInvitation` in `tests/e2e/support/fixtures.ts`.
- Service-role client construction: `tests/e2e/support/db.ts` (do not create a
  second client factory).

## For the Testing stage (not the Coder's job)

`tests/e2e/support/google.ts` contains two hand-duplicated pure functions whose
drift from `lib/` would silently break the calendar spec. A Jest unit test at
`tests/unit/e2e-support/google.test.ts` (mirroring
`tests/unit/e2e-support/env.test.ts`) can verify them without any staging
secrets: Jest maps `server-only` to a mock (`jest.config.js` `moduleNameMapper`),
so it can import both the real `lib/google-calendar/sync.ts` `toGoogleEventId`
and the duplicate and assert they agree, and it can round-trip
`encryptE2EToken` through `lib/google-calendar/token-crypto.ts` `decryptToken`
with a fixed 32-byte key.

## Out of scope (do not do)

- Any change to `app/`, `lib/`, `schemas/`, `components/`, or
  `supabase/migrations/` — including "fixing" the OPEN QUESTION 1 visibility
  behavior.
- Notification/inbox E2E tests (Sprint 4).
- Changing `playwright.config.ts`, `jest.config.js`, or
  `tests/e2e/support/env.ts`'s `REQUIRED_VARS`.
- Adding a deploy step to CI (`documentation/staging-environment.md` §3: Vercel's
  Git integration owns staging deploys).

## Verification before finishing (Coding stage)

Run `bun run lint`, `bun run typecheck`, `bun run test`, and
`bun run check:workflows` — all must pass. Also run `bun run test:e2e` locally
and confirm the new specs **skip cleanly** (no unhandled errors at import/collect
time) when the staging secrets are absent; the local run must still pass
`tests/e2e/health.spec.ts`.
