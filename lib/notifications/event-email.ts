import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { dispatchNotification, appNotificationUrl } from "@/lib/notifications/dispatch";

// Google Calendar event email — Email to confirmed members (PRD §14: "Google
// Calendar event | Confirmed members | Email + GCal"). The GCal half is
// already handled by lib/google-calendar/sync.ts; this is the email half,
// wired in #69.
//
// Per the human OQ2 resolution (.pipeline/spec.md): fire ONLY on a material
// change — an event's start_time / end_time / location changing, or an
// attendee being assigned. Do NOT fire on bare create (no recipients yet) or
// on notes/description-only edits. Callers own that gating; this module just
// resolves recipients and sends.
//
// PROPOSED COPY — the `google_calendar_event` template subject/preview require
// human approval (PRD §30 had no row for this email before #69).

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

export async function dispatchGoogleCalendarEventEmail(
  supabase: Supabase,
  params: {
    churchGroupId: string;
    serviceWeekId: string;
    event: { name: string; location: string | null; startTime: string };
    // When present (attendee assignment), email only these users. When
    // omitted (a material event edit), email every confirmed member of the
    // service week.
    recipientUserIds?: string[];
  },
): Promise<void> {
  try {
    await dispatchGoogleCalendarEventEmailInner(supabase, params);
  } catch (err) {
    console.error("dispatchGoogleCalendarEventEmail: failed", params.serviceWeekId, err);
  }
}

async function dispatchGoogleCalendarEventEmailInner(
  supabase: Supabase,
  params: {
    churchGroupId: string;
    serviceWeekId: string;
    event: { name: string; location: string | null; startTime: string };
    recipientUserIds?: string[];
  },
): Promise<void> {
  let recipientIds = params.recipientUserIds;

  if (!recipientIds) {
    const { data: invitations, error: invitationsError } = await supabase
      .from("invitations")
      .select("user_id")
      .eq("service_week_id", params.serviceWeekId)
      .eq("status", "accepted");
    if (invitationsError) return;
    recipientIds = [...new Set((invitations ?? []).map((i) => i.user_id))];
  }

  recipientIds = [...new Set(recipientIds)];
  if (recipientIds.length === 0) return;

  const { data: contactRows, error: contactError } = await supabase
    .from("users")
    .select("id, name, email, phone, sms_opted_in")
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
