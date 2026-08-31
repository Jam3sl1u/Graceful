import { NextRequest } from "next/server";
import { ok, fail } from "@/lib/api/response";
import { ErrorCode } from "@/lib/api/errors";
import { getAnonSupabaseClient } from "@/lib/supabase/client";
import { practiceReminderSms } from "@/lib/notifications/sms-templates";
import { dispatchNotification, appNotificationUrl } from "@/lib/notifications/dispatch";
import { formatEventWhen } from "@/lib/notifications/event-email";

// GET /api/cron/practice-reminders (#69, OQ1) — GitHub Actions hits this hourly
// (.github/workflows/practice-reminders-cron.yml) to fire the practice
// reminder (PRD §14: "Practice reminder | Confirmed members | SMS + Email |
// Configurable lead time before each event"). No Clerk session exists for a
// cron trigger, so auth is the shared CRON_SECRET bearer token. All DB work —
// resolving due (event × confirmed member) pairs by each member's per-user
// reminder_hours_before (default 24) and marking them sent — happens
// atomically inside the send_practice_reminders SECURITY DEFINER RPC (mirrors
// the invitation-reminders cron). This route's only job is dispatching the
// SMS + Email for each reminder the RPC reports.
export async function GET(req: NextRequest): Promise<Response> {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }

  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${cronSecret}`) {
    return fail("Authentication required", ErrorCode.UNAUTHENTICATED, 401);
  }

  const supabase = getAnonSupabaseClient();
  const { data, error } = await supabase.rpc("send_practice_reminders");

  if (error) {
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }

  const reminders = data ?? [];
  let smsSent = 0;
  let smsSkipped = 0;
  let smsFailed = 0;
  let emailSent = 0;
  let emailSkipped = 0;
  let emailFailed = 0;

  for (const reminder of reminders) {
    const { dayDate, time } = formatEventWhen(reminder.start_time);
    const hoursUntil = Math.max(
      1,
      Math.round((new Date(reminder.start_time).getTime() - Date.now()) / 3_600_000),
    );
    const location = reminder.location ?? "TBD";
    const link = appNotificationUrl(`/week/${reminder.service_week_id}`);

    const counts = await dispatchNotification({
      recipients: [
        {
          userId: reminder.user_id,
          name: reminder.member_name,
          email: reminder.email,
          phone: reminder.phone,
          smsOptedIn: reminder.sms_opted_in,
        },
      ],
      sms: {
        body: practiceReminderSms({
          eventName: reminder.event_name,
          when: dayDate,
          time,
          location: reminder.location,
        }),
      },
      email: {
        template: "practice_reminder",
        data: { eventName: reminder.event_name, hoursUntil, dayDate, time, location, link },
      },
    });

    smsSent += counts.smsSent;
    smsSkipped += counts.smsSkipped;
    smsFailed += counts.smsFailed;
    emailSent += counts.emailSent;
    emailSkipped += counts.emailSkipped;
    emailFailed += counts.emailFailed;
  }

  return ok({
    processed: reminders.length,
    smsSent,
    smsSkipped,
    smsFailed,
    emailSent,
    emailSkipped,
    emailFailed,
  });
}
