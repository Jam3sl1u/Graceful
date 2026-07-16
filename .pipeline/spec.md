# Spec — Issue #62: Google Calendar event sync (create/update/delete + graceful degradation)

## OPEN QUESTIONS (pipeline stops here until a human resolves these)

These are genuine blocking decisions, not implementation details. Each downstream
stage should stop until they are answered.

### OQ-1 (BLOCKING) — How does an admin/set_leader-triggered sync read *other members'* Google tokens?

This is the crux of the whole issue and there is no way to guess it safely.

Facts from the current codebase:

- Event create/update/delete (`app/api/events/**`) and attendee add/remove
  (`app/api/events/[id]/attendees/**`) are **admin/set_leader-only** actions
  (`requireRole(ctx, ["admin", "set_leader"])`). The Supabase client in those
  handlers runs under the **acting user's** Clerk JWT.
- `google_calendar_tokens` is **strictly user-scoped** by RLS — policy
  `google_calendar_tokens_select_own`
  (`supabase/migrations/20260704000001_rls_policies.sql`) only lets a user
  read/update **their own** row.
- There is **no service-role Supabase client** in app code, and adding one is
  explicitly forbidden: `lib/supabase/client.ts` documents "SUPABASE_SERVICE_ROLE_KEY
  is never used in user-callable code (PRD §19.3 / issue #23)."

Therefore an admin's request **cannot** read the assigned members' encrypted
tokens to push to their calendars. The repo's established pattern for
cross-user privileged DB work is a `SECURITY DEFINER` RPC called via the
user's client (see `record_availability_conflict` in
`20260713000001_conflict_notification.sql`) or via `getAnonSupabaseClient()`
for no-session cron (`send_invitation_reminders` in
`app/api/cron/invitation-reminders/route.ts`).

Applying that pattern here means a `SECURITY DEFINER` RPC that **returns other
members' encrypted OAuth tokens** into an admin-triggered request path (the
server would then decrypt them with `TOKEN_ENCRYPTION_KEY` and call Google).
That is a real security-posture change (member OAuth credentials become
reachable from an admin's request) and must be signed off by a human, not
assumed.

**Decision needed — pick one:**
- **(A) Inline sync via a `SECURITY DEFINER` token-fetch RPC** (recommended;
  most consistent with `record_availability_conflict` / `send_invitation_reminders`).
  Simplest; adds outbound Google latency to event/attendee mutations. Details
  fully specced below under "Recommended design (pending OQ-1 = A)".
- **(B) Deferred/async sync** via a job row + a cron route using
  `getAnonSupabaseClient()` + a `SECURITY DEFINER` RPC (mirrors invitation
  reminders). No generic job-queue infra exists today, so this is materially
  larger scope than #62 implies.
- **(C) Restrict #62 to member-owned-calendar sync only** (reconnect path, where
  the acting user reads their *own* token — no RLS wall), and move
  admin-triggered cross-member sync to a follow-up issue.

### OQ-2 — Confirm the single shared Google event ID design.

`events.google_calendar_event_id` is a single `varchar(100)` column
(`20260702000003_cluster_3_scheduling_core.sql`), but each connected member has
their own calendar/token, so a naive "one Google event per member" would need N
IDs. The only design that fits the single column: generate **one caller-assigned
Google event ID** (Google supports client-supplied event IDs) and reuse the same
ID when inserting/patching/deleting on **every** assigned member's calendar.
Confirm this is intended (it is assumed by the design below). If per-member IDs
are wanted instead, a schema change (per-attendee mapping) is required and this
issue's scope changes.

### OQ-3 — Trigger scope.

This spec covers only the triggers named in the issue: event **create/update/delete**
(#59) and attendee **add/remove** (#60), plus **retroactive sync on reconnect**
(acceptance criterion). PRD also mentions sync on **invitation accept** (line 158)
and **service-week cancel** (line 1195, removes synced events). Those belong to
#59/#57 respectively and are treated as **out of scope** here unless a human says
otherwise.

---

Everything below is the concrete plan to implement **once OQ-1 is answered (A)**.
If the answer is B or C, the plan changes and this spec must be revised.

## Recommended design (pending OQ-1 = A)

A service layer `lib/google-calendar/sync.ts` that the event and attendee
handlers call into. It:
1. Uses a `SECURITY DEFINER` RPC to fetch the encrypted tokens of an event's
   assigned attendees who have a *connected, valid* calendar.
2. Refreshes each access token if expired, calls Google Calendar REST, and on a
   revoked/`invalid_grant` refresh, calls a second `SECURITY DEFINER` RPC to flag
   the token invalid + insert a re-auth notification (graceful degradation).
3. Never throws to the caller — a sync failure must not fail the event/attendee
   HTTP request (the DB write is the source of truth; sync is best-effort).

### Files to CREATE

1. **`supabase/migrations/20260716000001_google_calendar_sync.sql`**
   (DOWN block commented out, per repo convention — see
   `20260713000001_conflict_notification.sql`)
   - `ALTER TABLE google_calendar_tokens ADD COLUMN is_valid boolean NOT NULL DEFAULT true;`
     (PRD §10: "Token flagged as invalid in DB"). Reset to `true` on reconnect
     upsert.
   - `ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'google_calendar_reauth_required';`
     (mirror `20260711000002_service_week_notification_types.sql`).
   - RPC `public.get_event_sync_targets(p_event_id uuid)` — `SECURITY DEFINER`,
     `SET search_path = ''`, `GRANT EXECUTE ... TO authenticated`. Derives the
     caller's user + group from `auth.jwt()->>'sub'` exactly like
     `record_availability_conflict`. Asserts the event belongs to the caller's
     group and the caller is admin/set_leader (else `RAISE EXCEPTION`). Returns
     one row per assigned attendee **who has a `google_calendar_tokens` row with
     `is_valid = true`**: `(user_id uuid, access_token_encrypted text,
     refresh_token_encrypted text, token_expiry timestamptz, calendar_id text)`.
   - RPC `public.get_user_sync_targets()` — `SECURITY DEFINER` — same row shape
     but for the **caller's own** connected+valid token only (used by the
     reconnect retroactive path; keeps one code path). Returns 0 or 1 row.
   - RPC `public.flag_calendar_token_invalid(p_user_id uuid)` — `SECURITY DEFINER`.
     Sets `is_valid = false, updated_at = now()` on that user's token row and
     inserts one `notifications` row for that user
     (`type = 'google_calendar_reauth_required'`, title "Reconnect Google Calendar",
     body per PRD §10 message "Your Google Calendar connection needs to be
     refreshed. Tap here to reconnect.", `link_entity_type = 'google_calendar'`,
     `link_entity_id = NULL`). Caller must be admin/set_leader in the same group
     OR `p_user_id` = the caller themselves (covers member reconnect/self path).
     Idempotent: only insert + flag when currently `is_valid = true`.

2. **`lib/google-calendar/sync.ts`** (`import "server-only";`) — the service layer.
   Signatures:
   ```ts
   import type { SupabaseClient } from "@supabase/supabase-js";
   import type { Database } from "@/lib/supabase/types";

   type Supabase = SupabaseClient<Database>;

   // Event fields Google needs. Map from EventsRow at the call site.
   export type CalendarEventInput = {
     googleEventId: string;      // caller-assigned, reused across calendars
     name: string;
     location: string | null;
     notes: string | null;
     startTime: string;          // ISO tz
     endTime: string;            // ISO tz
   };

   // Create/update the event on every assigned attendee's calendar. Best-effort:
   // never throws. Per attendee, on invalid_grant flags token invalid + notifies.
   export async function syncEventToAttendees(
     supabase: Supabase, eventId: string, event: CalendarEventInput,
   ): Promise<void>;

   // Delete the event from every assigned attendee's calendar (event delete).
   export async function unsyncEventFromAttendees(
     supabase: Supabase, eventId: string, googleEventId: string,
   ): Promise<void>;

   // Single-attendee variants for attendee add/remove.
   export async function syncEventToUser(
     supabase: Supabase, userId: string, event: CalendarEventInput,
   ): Promise<void>;
   export async function unsyncEventFromUser(
     supabase: Supabase, userId: string, googleEventId: string,
   ): Promise<void>;

   // Reconnect retroactive sync: push every event the caller is currently an
   // attendee of onto their (own) calendar. Uses get_user_sync_targets + the
   // caller's own attendee rows.
   export async function syncAllEventsForUser(
     supabase: Supabase, userId: string,
   ): Promise<void>;

   // Deterministic caller-assigned Google event id. Google requires base32hex
   // (chars a-v + 0-9), length 5-1024. Derive from the event uuid: strip dashes,
   // lowercase (hex is already a valid base32hex subset). Prefix "gr".
   export function toGoogleEventId(eventUuid: string): string;
   ```
   - Token refresh: add
     `refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; expiryDate: string }>`
     to `lib/google-calendar/oauth.ts` (grant_type=refresh_token against
     `TOKEN_ENDPOINT`, same env-var guard as `exchangeCode`). If the response is
     4xx with `error === "invalid_grant"` (revoked/expired), throw a
     distinguishable error (e.g. a named `GoogleTokenInvalidError`) the sync
     layer catches to trigger `flag_calendar_token_invalid`.
   - Decrypt tokens with `decryptToken` (`lib/google-calendar/token-crypto.ts`).
     Only refresh when `token_expiry` is within ~60s of now; else reuse the
     stored access token.
   - Google REST calls (write-only `calendar.events` scope, no SDK — use `fetch`,
     mirroring `oauth.ts`):
     - Upsert one calendar: try `PATCH https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events/{googleEventId}`;
       on **404** (event not yet on that calendar) fall back to
       `POST https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events`
       with `"id": googleEventId` in the body. Reusing the same id keeps create
       idempotent. Body: `{ id?, summary: name, location, description: notes,
       start: { dateTime: startTime }, end: { dateTime: endTime } }`.
     - Delete: `DELETE .../calendars/{calendarId}/events/{googleEventId}`; treat
       404/410 (already gone) as success.
     - `calendarId` comes from the token row (`"primary"` in current data).
     - Authorization: `Bearer <decrypted access token>` (refreshed if expired).
   - Per-attendee isolation: wrap each attendee's sync in try/catch so one bad
     token never blocks the others (PRD §10 graceful degradation).

### Files to MODIFY

3. **`lib/google-calendar/client.ts`** — remove the three throwing stubs
   (`createEvent`/`updateEvent`/`deleteEvent`, all `TODO(Sprint 3 #62)`). Nothing
   imports this file (confirmed via grep). Delete the file and put all logic in
   `sync.ts`.

4. **`app/api/events/handler.ts` → `createEvent`** — generate the Google event id
   up front and store it: generate the row id app-side (or run a follow-up
   `update` to set `google_calendar_event_id = toGoogleEventId(event.id)`) so the
   mapping is never null. A brand-new event has no attendees, so a create-time
   push is typically a no-op — still call `syncEventToAttendees` inside a
   try/catch for the create-then-immediately-assign ordering. Key requirement:
   **persist `google_calendar_event_id`** so update/delete/attendee paths have it.

5. **`app/api/events/[id]/handler.ts`**
   - `updateEvent` — after a successful update, if `google_calendar_event_id` is
     set, `await syncEventToAttendees(...)` with the merged fields (try/catch,
     best-effort). If null (legacy row), backfill via `toGoogleEventId(id)` and
     persist it.
   - `deleteEvent` — **before** deleting the DB row, capture
     `google_calendar_event_id` and the sync targets (the DB delete cascades
     `event_attendees`, so the target list must be read first). After the
     successful DB delete, delete the event from each captured calendar
     (try/catch).

6. **`app/api/events/[id]/attendees/handler.ts`**
   - `assignAttendee` — widen the event select to include
     `google_calendar_event_id, name, location, notes, start_time, end_time`.
     After the successful attendee insert, if the event has a
     `google_calendar_event_id`, `await syncEventToUser(supabase, parsed.userId,
     {...})` (try/catch).
   - `removeAttendee` — widen the event select to include
     `google_calendar_event_id`. After the successful delete,
     `await unsyncEventFromUser(supabase, targetUserId, google_calendar_event_id)`
     (try/catch).

7. **`app/api/google-calendar/callback/handler.ts` → `callback`** — the upsert
   represents connect **or reconnect**. (a) add `is_valid: true` to the upsert
   payload so reconnect clears a prior invalid flag; (b) after a successful
   upsert, `await syncAllEventsForUser(supabase, ctx.userId)` inside try/catch
   before `redirectConnected()` (a sync failure still reports "connected"). The
   acting user is the token owner, so RLS permits reading their own token here.
   Satisfies "On reconnection, missed events sync retroactively."

8. **`lib/supabase/types.ts`**
   - Add `is_valid: boolean;` to `GoogleCalendarTokensRow`, and
     `is_valid?: boolean` to the `google_calendar_tokens` Insert omit-with-default
     list.
   - Add the three new RPCs to `Database["public"]["Functions"]`
     (`get_event_sync_targets`, `get_user_sync_targets`,
     `flag_calendar_token_invalid`) with `Args`/`Returns` matching the SQL.

9. **`types/domain.ts`** — add `"google_calendar_reauth_required"` to the
   `NotificationType` union (keep in sync with the enum migration).

### Patterns to copy

- SECURITY DEFINER RPC skeleton (JWT→user/group derivation, `RAISE EXCEPTION
  'UNAUTHENTICATED'`, `SET search_path = ''`, `GRANT EXECUTE ... TO authenticated`,
  commented-out DOWN): copy from
  `supabase/migrations/20260713000001_conflict_notification.sql`.
- Notification insert columns/shape: copy the `INSERT INTO public.notifications`
  in that same file.
- `fetch`-based Google HTTP + env-var guards + never-throw revoke style: copy
  from `lib/google-calendar/oauth.ts`.
- Handler try/catch + `ApiException` mapping: keep the existing shape in each
  handler; the new sync calls go *inside* the existing `try` but each wrapped in
  its own inner try/catch so sync failure never changes the HTTP result.

## Edge cases the implementation MUST handle

1. **Attendee with no connected calendar** — `get_event_sync_targets` omits them;
   sync is a no-op for that user. Not an error.
2. **Token invalid/expired (revoked)** — refresh returns `invalid_grant`; catch,
   call `flag_calendar_token_invalid(userId)` (sets `is_valid=false` + one
   re-auth notification), skip that user, continue others. The request still
   succeeds (graceful degradation, PRD §10). Already-invalid tokens are excluded
   by the RPC filter, so no repeat notifications.
3. **Access token expired but refresh token valid** — refresh, use new access
   token for the call. Persisting the refreshed access token back is optional;
   correctness does not require it.
4. **PATCH 404 (event not yet on that calendar) / DELETE 404 or 410 (already
   gone)** — PATCH 404 → fall back to POST insert with the id; DELETE 404/410 →
   treat as success. Reusing the client-assigned id makes create idempotent.
5. **Google outage / non-auth error (5xx, network)** — caught per-attendee,
   logged, swallowed; never fails the HTTP request and never flags the token
   invalid (only `invalid_grant` does that).
6. **Legacy event row with null `google_calendar_event_id`** — backfill via
   `toGoogleEventId(event.id)` on the next update/delete and persist it.
7. **Delete ordering** — capture sync targets + `google_calendar_event_id`
   before the DB delete cascades `event_attendees`.
8. **Reconnect after revoke** — callback upsert resets `is_valid=true`, then
   retroactively syncs all of the user's assigned events.
9. **Empty attendee set** — all sync functions no-op cleanly.
10. **Missing `TOKEN_ENCRYPTION_KEY` / Google env vars** — existing helpers throw;
    the per-attendee try/catch swallows it (logged), request still succeeds.
    Never log token plaintext or the key.

## Verification (Coder must run before finishing)

- `bun run lint`
- `bun run typecheck`
- `bun run test`
- Do not run migrations against a real DB; SQL correctness is verified by review
  + keeping `lib/supabase/types.ts` hand-updated to match the migration.

## Explicitly OUT OF SCOPE

- Read access / conflict detection against personal calendar events (PRD open
  question — write-only only).
- SMS/email dispatch of the re-auth notification (Sprint 4 #58); in-app
  notification only, matching every shipped notify path.
- Invitation-accept sync and service-week-cancel unsync (see OQ-3; belong to
  #59/#57).
- Any general async job-queue infrastructure (unless OQ-1 = B).
