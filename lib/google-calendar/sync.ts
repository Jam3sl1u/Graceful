import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { decryptToken } from "@/lib/google-calendar/token-crypto";
import { refreshAccessToken, GoogleTokenInvalidError } from "@/lib/google-calendar/oauth";

// Service layer for #62 (Google Calendar event sync). Event/attendee route
// handlers call into this module; every exported function here is
// best-effort and NEVER throws — a sync failure must not fail the
// event/attendee HTTP request (the DB write is the source of truth, per
// PRD §10 graceful degradation).
//
// Cross-user token reads (an admin/set_leader pushing to OTHER members'
// calendars) go through the SECURITY DEFINER RPCs added in
// 20260716000001_google_calendar_sync.sql (get_event_sync_targets,
// get_user_sync_targets, flag_calendar_token_invalid) — google_calendar_tokens
// is strictly user-scoped by RLS (20260704000001_rls_policies.sql), so the
// acting user's own Supabase client cannot read another member's row directly.

type Supabase = SupabaseClient<Database>;

type SyncTarget = {
  user_id: string;
  access_token_encrypted: string;
  refresh_token_encrypted: string;
  token_expiry: string;
  calendar_id: string;
};

// Event fields Google needs. Map from EventsRow at the call site.
export type CalendarEventInput = {
  googleEventId: string; // caller-assigned, reused across every attendee's calendar
  name: string;
  location: string | null;
  notes: string | null;
  startTime: string; // ISO tz
  endTime: string; // ISO tz
};

const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";
// Refresh proactively when the stored access token is within this many
// milliseconds of expiring, rather than waiting for Google to reject it.
const EXPIRY_SKEW_MS = 60_000;

// Deterministic caller-assigned Google event id. Google requires base32hex
// (chars a-v + 0-9), length 5-1024. A uuid's hex digits (0-9a-f) are already
// a valid base32hex subset once dashes are stripped and it's lowercased.
// Prefixed "gr" so it reads as ours in the Google UI/API.
export function toGoogleEventId(eventUuid: string): string {
  return `gr${eventUuid.replace(/-/g, "").toLowerCase()}`;
}

// Resolves a usable (possibly refreshed) access token for `target`. Only
// refreshes when the stored access token is within EXPIRY_SKEW_MS of
// expiring; otherwise reuses the stored one. Throws GoogleTokenInvalidError
// when the refresh token itself is revoked/expired (invalid_grant) — callers
// must catch this specifically to flag the token invalid. Any other failure
// (decrypt error, missing env vars, network) propagates as a plain Error.
async function resolveAccessToken(target: SyncTarget): Promise<string> {
  const expiryMs = new Date(target.token_expiry).getTime();
  const isExpired = !Number.isFinite(expiryMs) || expiryMs - Date.now() <= EXPIRY_SKEW_MS;

  if (!isExpired) {
    return decryptToken(target.access_token_encrypted);
  }

  const refreshToken = decryptToken(target.refresh_token_encrypted);
  const refreshed = await refreshAccessToken(refreshToken);
  return refreshed.accessToken;
}

// Upserts one calendar event on a single member's calendar: PATCH first
// (update in place); on 404 (event not yet on that calendar) fall back to
// POST with the client-assigned id, which keeps create idempotent across
// every assigned member.
async function upsertCalendarEvent(
  accessToken: string,
  calendarId: string,
  event: CalendarEventInput,
): Promise<void> {
  const body = {
    summary: event.name,
    location: event.location,
    description: event.notes,
    start: { dateTime: event.startTime },
    end: { dateTime: event.endTime },
  };

  const patchRes = await fetch(
    `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(
      event.googleEventId,
    )}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );

  if (patchRes.ok) {
    return;
  }

  if (patchRes.status !== 404) {
    throw new Error(`Google Calendar PATCH failed with status ${patchRes.status}`);
  }

  const createRes = await fetch(
    `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ id: event.googleEventId, ...body }),
    },
  );

  if (!createRes.ok) {
    throw new Error(`Google Calendar POST failed with status ${createRes.status}`);
  }
}

// Deletes one calendar event from a single member's calendar. 404/410
// (already gone) are treated as success.
async function deleteCalendarEvent(
  accessToken: string,
  calendarId: string,
  googleEventId: string,
): Promise<void> {
  const res = await fetch(
    `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(
      googleEventId,
    )}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );

  if (!res.ok && res.status !== 404 && res.status !== 410) {
    throw new Error(`Google Calendar DELETE failed with status ${res.status}`);
  }
}

// Runs `action` for one target, isolating failures so one bad token never
// blocks another attendee's sync (PRD §10). A revoked/expired refresh token
// (GoogleTokenInvalidError) flags the token invalid + notifies the member;
// any other failure (Google outage, network, missing env vars) is logged and
// swallowed without touching is_valid.
async function syncTargetSafely(
  supabase: Supabase,
  target: SyncTarget,
  action: (accessToken: string) => Promise<void>,
): Promise<void> {
  try {
    const accessToken = await resolveAccessToken(target);
    await action(accessToken);
  } catch (err) {
    if (err instanceof GoogleTokenInvalidError) {
      try {
        await supabase.rpc("flag_calendar_token_invalid", { p_user_id: target.user_id });
      } catch (flagErr) {
        console.error("google-calendar sync: failed to flag invalid token", flagErr);
      }
      return;
    }
    // Google outage / non-auth error — never fails the caller's request and
    // never flags the token invalid.
    console.error("google-calendar sync: failed for user", target.user_id, err);
  }
}

async function fetchEventSyncTargets(supabase: Supabase, eventId: string): Promise<SyncTarget[]> {
  try {
    const { data, error } = await supabase.rpc("get_event_sync_targets", { p_event_id: eventId });
    if (error) throw error;
    return data ?? [];
  } catch (err) {
    console.error("google-calendar sync: failed to fetch sync targets for event", eventId, err);
    return [];
  }
}

// Create/update the event on every currently-assigned attendee's calendar.
// Best-effort: never throws.
export async function syncEventToAttendees(
  supabase: Supabase,
  eventId: string,
  event: CalendarEventInput,
): Promise<void> {
  const targets = await fetchEventSyncTargets(supabase, eventId);
  for (const target of targets) {
    await syncTargetSafely(supabase, target, (accessToken) =>
      upsertCalendarEvent(accessToken, target.calendar_id, event),
    );
  }
}

// Delete the event from every currently-assigned attendee's calendar.
// Best-effort: never throws. Must be called BEFORE the event row is deleted
// from the DB — the DB delete cascades event_attendees, so the target list
// (read via get_event_sync_targets, joined on event_attendees) would
// otherwise come back empty.
export async function unsyncEventFromAttendees(
  supabase: Supabase,
  eventId: string,
  googleEventId: string,
): Promise<void> {
  const targets = await fetchEventSyncTargets(supabase, eventId);
  for (const target of targets) {
    await syncTargetSafely(supabase, target, (accessToken) =>
      deleteCalendarEvent(accessToken, target.calendar_id, googleEventId),
    );
  }
}

// Single-attendee variant for attendee add (assignAttendee). Must be called
// AFTER the attendee row is inserted, so get_event_sync_targets(eventId)
// (joined on event_attendees) includes them; filters that result down to
// `userId` since get_event_sync_targets has no per-user argument.
export async function syncEventToUser(
  supabase: Supabase,
  eventId: string,
  userId: string,
  event: CalendarEventInput,
): Promise<void> {
  const targets = await fetchEventSyncTargets(supabase, eventId);
  const target = targets.find((t) => t.user_id === userId);
  if (!target) return; // not connected / invalid token — no-op, not an error

  await syncTargetSafely(supabase, target, (accessToken) =>
    upsertCalendarEvent(accessToken, target.calendar_id, event),
  );
}

// Single-attendee variant for attendee remove (removeAttendee). Must be
// called BEFORE the attendee row is deleted, for the same reason as
// unsyncEventFromAttendees — once the row is gone,
// get_event_sync_targets(eventId) can no longer see this user as a target.
export async function unsyncEventFromUser(
  supabase: Supabase,
  eventId: string,
  userId: string,
  googleEventId: string,
): Promise<void> {
  const targets = await fetchEventSyncTargets(supabase, eventId);
  const target = targets.find((t) => t.user_id === userId);
  if (!target) return;

  await syncTargetSafely(supabase, target, (accessToken) =>
    deleteCalendarEvent(accessToken, target.calendar_id, googleEventId),
  );
}

// Reconnect retroactive sync: push every event the caller (userId) is
// currently an attendee of onto their OWN calendar. Uses
// get_user_sync_targets (the caller's own connected+valid token — no RLS
// wall) plus the caller's own event_attendees rows, both read via the
// caller's own RLS-scoped `supabase` client.
export async function syncAllEventsForUser(supabase: Supabase, userId: string): Promise<void> {
  let ownTargets: SyncTarget[] = [];
  try {
    const { data, error } = await supabase.rpc("get_user_sync_targets");
    if (error) throw error;
    ownTargets = data ?? [];
  } catch (err) {
    console.error("google-calendar sync: failed to fetch own sync target", userId, err);
    return;
  }

  const target = ownTargets[0];
  if (!target) return; // not connected / invalid token — nothing to retroactively sync

  const { data: attendeeRows, error: attendeeError } = await supabase
    .from("event_attendees")
    .select("event_id")
    .eq("user_id", userId);

  if (attendeeError) {
    console.error("google-calendar sync: failed to list attendee rows", userId, attendeeError);
    return;
  }

  const eventIds = [...new Set((attendeeRows ?? []).map((r) => r.event_id))];
  if (eventIds.length === 0) return;

  const { data: events, error: eventsError } = await supabase
    .from("events")
    .select("id, google_calendar_event_id, name, location, notes, start_time, end_time")
    .in("id", eventIds);

  if (eventsError) {
    console.error("google-calendar sync: failed to list events", userId, eventsError);
    return;
  }

  for (const row of events ?? []) {
    if (!row.google_calendar_event_id) continue; // legacy row — backfilled on next update/delete

    await syncTargetSafely(supabase, target, (accessToken) =>
      upsertCalendarEvent(accessToken, target.calendar_id, {
        googleEventId: row.google_calendar_event_id as string,
        name: row.name,
        location: row.location,
        notes: row.notes,
        startTime: row.start_time,
        endTime: row.end_time,
      }),
    );
  }
}
