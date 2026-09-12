import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { dispatchNotification, appNotificationUrl } from "@/lib/notifications/dispatch";

// Google Calendar event email — Email to confirmed members (PRD §14: "Google
// Calendar event | Confirmed members | Email + GCal"). The GCal half is
// already handled by lib/google-calendar/sync.ts; this is the email half,
// wired in #69.
//
// Per the OQ2 resolution recorded in .pipeline/spec.md (operator decision,
// 2026-08-31): fire ONLY on a material change — an event's start_time /
// end_time / location changing, or an attendee being assigned. Do NOT fire on
// bare create (no recipients yet) or on notes/description-only edits. Callers
// own that gating; this module just resolves recipients and sends.
//
// The `google_calendar_event` template subject/preview copy was approved in the
// same OQ2 resolution and added to PRD §30 (which had no row for this email
// before #69).

type Supabase = SupabaseClient<Database>;

// Pure, deterministic formatter (#69 owns notification formatting — the email
// templates must never parse a date). Anchored in UTC to stay testable with
// fixed fixtures, matching formatWeekLabel in lib/scheduling/reminder.ts.
export function formatEventWhen(startTime: string): { dayDate: string; time: string } {
  const date = new Date(startTime);
  if (Number.isNaN(date.getTime())) {
    return { dayDate: startTime, time: "" };
  }
  const dayDate = date.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "2-digit",
    year: "numeric",
    timeZone: "UTC",
  });
  const time = date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  });
  return { dayDate, time };
}

type EventEmailParams = {
  churchGroupId: string;
  serviceWeekId: string;
  eventId: string;
  event: { name: string; location: string | null; startTime: string };
  // When present (attendee assignment), email only these users. When omitted
  // (a material event edit), email the members ASSIGNED TO THIS EVENT
  // (event_attendees) — the same set the Google Calendar sync writes to, and
  // the only people for whom "Your Google Calendar has been updated" is true.
  recipientUserIds?: string[];
};

export async function dispatchGoogleCalendarEventEmail(
  supabase: Supabase,
  params: EventEmailParams,
): Promise<void> {
  try {
    await dispatchGoogleCalendarEventEmailInner(supabase, params);
  } catch (err) {
    console.error("dispatchGoogleCalendarEventEmail: failed", params.serviceWeekId, err);
  }
}

async function dispatchGoogleCalendarEventEmailInner(
  supabase: Supabase,
  params: EventEmailParams,
): Promise<void> {
  let recipientIds = params.recipientUserIds;

  if (!recipientIds) {
    const { data: attendees, error: attendeesError } = await supabase
      .from("event_attendees")
      .select("user_id")
      .eq("event_id", params.eventId);
    if (attendeesError) return;
    recipientIds = [...new Set((attendees ?? []).map((a) => a.user_id))];
  }

  recipientIds = [...new Set(recipientIds)];
  if (recipientIds.length === 0) return;

  const { data: contactRows, error: contactError } = await supabase
    .from("users")
    .select("id, name, email, phone, sms_opted_in")
    .eq("church_group_id", params.churchGroupId)
    .in("id", recipientIds);
  if (contactError) return;

  const { dayDate, time } = formatEventWhen(params.event.startTime);
  const link = appNotificationUrl(`/week/${params.serviceWeekId}`);

  await dispatchNotification({
    recipients: (contactRows ?? []).map((r) => ({
      userId: r.id,
      name: r.name,
      email: r.email,
      phone: r.phone,
      smsOptedIn: r.sms_opted_in,
    })),
    // Email only — PRD channel for this type is "Email + GCal", no SMS.
    email: {
      template: "google_calendar_event",
      data: {
        eventName: params.event.name,
        dayDate,
        time,
        location: params.event.location ?? "TBD",
        link,
      },
    },
  });
}
