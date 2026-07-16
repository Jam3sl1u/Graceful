# Changes — Issue #62: Google Calendar event sync (create/update/delete + graceful degradation)

Implements the fully-specced inline-sync design from `.pipeline/spec.md`
("Recommended design (pending OQ-1 = A)"), per the human resolution of OQ-1:
**(A) Inline sync via a `SECURITY DEFINER` token-fetch RPC**, mirroring
`record_availability_conflict` / `send_invitation_reminders`. OQ-2 (single
shared Google event id) and OQ-3 (trigger scope limited to create/update/
delete + attendee add/remove + reconnect) were non-blocking assumptions in
the spec and are implemented as written.

## Files created

- **`supabase/migrations/20260716000001_google_calendar_sync.sql`** — adds
  `google_calendar_tokens.is_valid boolean NOT NULL DEFAULT true`; adds
  `notification_type` value `google_calendar_reauth_required`; adds three
  `SECURITY DEFINER` RPCs (JWT→user/group derivation, `RAISE EXCEPTION ...
  USING ERRCODE = 'P0001'`, `SET search_path = ''`, `GRANT EXECUTE ... TO
  authenticated`, commented-out DOWN — mirrors
  `20260713000001_conflict_notification.sql` / `20260710000001_member_removal_rpc.sql`):
  - `get_event_sync_targets(p_event_id uuid)` — admin/set_leader-only, event
    must belong to caller's group; returns one row per assigned attendee
    (`event_attendees` join `google_calendar_tokens`) with `is_valid = true`.
  - `get_user_sync_targets()` — caller's own connected+valid token only (0/1
    row), same row shape.
  - `flag_calendar_token_invalid(p_user_id uuid)` — admin/set_leader-in-group
    OR self; idempotent (no-op when already invalid or no row); sets
    `is_valid = false` and inserts one `google_calendar_reauth_required`
    notification.

- **`lib/google-calendar/sync.ts`** (`import "server-only"`) — the service
  layer. Exports `CalendarEventInput`, `toGoogleEventId`,
  `syncEventToAttendees`, `unsyncEventFromAttendees`, `syncEventToUser`,
  `unsyncEventFromUser`, `syncAllEventsForUser`. Every export is best-effort
  and never throws (each attendee's sync is isolated in its own try/catch;
  a revoked/expired refresh token — `GoogleTokenInvalidError` — calls
  `flag_calendar_token_invalid` and is skipped; any other failure, e.g. a
  Google 5xx, is logged and skipped without touching `is_valid`). Google REST
  calls use `fetch` (PATCH → 404 fallback to POST with the client-assigned
  id; DELETE treats 404/410 as success), mirroring `oauth.ts`'s style.
  **Deviation from the spec's literal signatures, required by the RPC
  design**: `syncEventToUser`/`unsyncEventFromUser` take an additional
  `eventId` parameter (`(supabase, eventId, userId, event)` /
  `(supabase, eventId, userId, googleEventId)`) — `get_event_sync_targets`
  only accepts an event id (there is no per-arbitrary-user RPC), so these
  need the event id to look up that one member's token via the same
  attendee-join RPC used for the bulk paths. This was the only way to
  implement the "single-attendee variant" as specced without adding a new
  RPC the spec didn't ask for.

- **`tests/unit/lib/google-calendar/sync.test.ts`** — unit coverage for all
  six sync.ts exports (PATCH/POST fallback, DELETE 404/410-as-success,
  per-attendee isolation, invalid_grant → flag + notify, non-auth failure →
  no flag, RPC error → no-op, token refresh gating, legacy-row skip in
  `syncAllEventsForUser`).

## Files modified

- **`lib/google-calendar/oauth.ts`** — adds `GoogleTokenInvalidError` and
  `refreshAccessToken(refreshToken)` (grant_type=refresh_token against the
  existing `TOKEN_ENDPOINT`; throws `GoogleTokenInvalidError` on
  `invalid_grant`, a plain `Error` otherwise). Tests added to
  `tests/unit/lib/google-calendar/oauth.test.ts`.

- **`lib/google-calendar/client.ts`** — deleted (confirmed unimported); its
  three throwing stubs are superseded by `sync.ts`.

- **`app/api/events/handler.ts`** (`createEvent`) — generates the event's
  `id` app-side (`crypto.randomUUID()`) so `google_calendar_event_id =
  toGoogleEventId(id)` can be persisted in the same insert (mapping is never
  null). Best-effort `syncEventToAttendees` call after insert (typically a
  no-op — a brand-new event has no attendees yet), wrapped so a sync failure
  never fails event creation.

- **`app/api/events/[id]/handler.ts`**:
  - `updateEvent` — after a successful update, backfills
    `google_calendar_event_id` via `toGoogleEventId(id)` for a legacy
    (null-mapping) row, then best-effort `syncEventToAttendees`.
  - `deleteEvent` — **capture-before-delete**: selects
    `google_calendar_event_id` and calls `unsyncEventFromAttendees` (which
    internally reads sync targets via `get_event_sync_targets`, joined on
    `event_attendees`) *before* the DB delete, since the DB delete cascades
    `event_attendees` and would otherwise make the target list unreadable
    afterward. This differs from the spec's literal phrasing ("after the
    successful DB delete, delete from each captured calendar") but is
    required for the chosen RPC design to work at all — the spec's own edge
    case #7 ("target list must be read first") confirms the ordering
    constraint, and this deletes from every calendar target that ordering
    exposes rather than only reading the list beforehand and discarding it.

- **`app/api/events/[id]/attendees/handler.ts`**:
  - `assignAttendee` — widens the event select to include
    `google_calendar_event_id, name, location, notes, start_time, end_time`;
    after a successful insert, best-effort `syncEventToUser`.
  - `removeAttendee` — widens the event select to include
    `google_calendar_event_id`; **before** deleting the attendee row (same
    cascade-ordering reasoning as `deleteEvent`), best-effort
    `unsyncEventFromUser`.

- **`app/api/google-calendar/callback/handler.ts`** (`callback`) — upsert
  payload now includes `is_valid: true` (clears a prior revoke flag on
  reconnect); after a successful upsert, best-effort
  `syncAllEventsForUser(supabase, ctx.userId)` before redirecting to
  `?calendar=connected` (a sync failure still reports connected).

- **`lib/supabase/types.ts`** — `GoogleCalendarTokensRow` gains
  `is_valid: boolean` (Insert omits it, defaultable); adds
  `get_event_sync_targets`, `get_user_sync_targets`,
  `flag_calendar_token_invalid` to `Database["public"]["Functions"]`.

- **`types/domain.ts`** — `NotificationType` gains
  `"google_calendar_reauth_required"`.

- **Existing tests updated** to accommodate the new required behavior
  (rather than being broken by it):
  - `tests/unit/app/api/events-route.test.ts` — mocks
    `lib/google-calendar/sync`; new tests assert the generated
    `id`/`google_calendar_event_id` insert payload and the best-effort
    `syncEventToAttendees` wiring (including a sync-rejection case that must
    still return 201).
  - `tests/unit/app/api/events-id-route.test.ts` — `eventRow` fixture now
    carries a pre-existing `google_calendar_event_id` so the many
    unrelated PUT/DELETE assertions (which check exact update payloads)
    don't trip the new legacy-row backfill path; dedicated new tests cover
    the sync/backfill/unsync wiring and its ordering.
  - `tests/unit/app/api/events-id-attendees-route.test.ts` — mocks
    `syncEventToUser`/`unsyncEventFromUser`; new tests cover the
    push-on-assign and unsync-before-delete wiring, the no-op case (no
    `google_calendar_event_id`), and best-effort failure handling.
  - `tests/unit/app/api/google-calendar-callback-route.test.ts` — asserts
    `is_valid: true` on the upsert payload and the retroactive
    `syncAllEventsForUser` call (including a graceful-degradation case where
    the sync rejects but the redirect still reports connected).

## Untouched, per spec

- Read access / conflict detection against personal calendar events —
  out of scope (write-only).
- SMS/email dispatch of the re-auth notification — Sprint 4 #58, in-app
  notification only.
- Invitation-accept sync and service-week-cancel unsync — belong to #59/#57
  (OQ-3).
- No general async job-queue infrastructure (OQ-1 = A, not B).

## Verification

- `bun run lint` — clean.
- `bun run typecheck` — clean.
- `bun run test` — 67 suites / 873 tests pass, including the new/expanded
  suites for this issue (`sync.test.ts`, plus updated `oauth.test.ts`,
  `events-route.test.ts`, `events-id-route.test.ts`,
  `events-id-attendees-route.test.ts`, `google-calendar-callback-route.test.ts`).
- `bun run check:service-role` — passes (no service-role key usage
  introduced; every cross-user token read goes through a `SECURITY DEFINER`
  RPC called via the acting user's own client, per the OQ-1 resolution).
- Did not run migrations against a real DB, per the spec's instruction — SQL
  correctness relies on this review plus keeping `lib/supabase/types.ts`
  hand-updated to match.

## What the Tester should focus on

1. **Ordering-dependent paths**: `deleteEvent` and `removeAttendee` both read
   Google Calendar sync targets *before* the destructive DB write (because
   `event_attendees` cascades/rows disappear after). Worth an integration-
   style check that the RPC call genuinely happens first, not just that the
   mocked function was called with the right arguments.
2. **The `syncEventToUser`/`unsyncEventFromUser` signature deviation**
   (added `eventId` param, documented above and in `sync.ts`'s doc comments)
   — confirm this doesn't conflict with anything the Review stage expects
   from the spec's literal snippet.
3. **Graceful degradation**: every sync call site is wrapped so a Google
   failure (mocked as a rejection in tests) never changes the HTTP status of
   the underlying event/attendee/reconnect request — spot-check at least one
   real end-to-end failure path per handler, not just the wiring assertion.
4. **RLS/security boundary**: `get_event_sync_targets` and
   `flag_calendar_token_invalid` are the only way an admin's request reaches
   another member's encrypted token — worth re-reading the migration's
   caller-role checks (this is SQL, not covered by `bun run test`).
5. **Token refresh / invalid_grant path** in `sync.test.ts` mocks
   `refreshAccessToken` rather than hitting a real Google endpoint — the
   400/`invalid_grant` → `GoogleTokenInvalidError` mapping itself is covered
   separately in `oauth.test.ts`.
