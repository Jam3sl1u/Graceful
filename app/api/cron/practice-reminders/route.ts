import { NextRequest } from "next/server";
import { ok, fail } from "@/lib/api/response";
import { ErrorCode } from "@/lib/api/errors";
import { getAnonSupabaseClient } from "@/lib/supabase/client";
import { practiceReminderSms } from "@/lib/notifications/sms-templates";
import { dispatchNotification, appNotificationUrl } from "@/lib/notifications/dispatch";
import { formatEventWhen } from "@/lib/notifications/event-email";

// The route dispatches sequentially (SMS + email + confirm per pair). The RPC
// caps a run at 100 pairs; a larger backlog drains across subsequent hourly
// runs. maxDuration is set explicitly so a big batch is not cut off mid-loop
// (a cut-off leaves the tail claimed with attempts bumped — recoverable, but
// wasteful).
export const maxDuration = 300;

// GET /api/cron/practice-reminders (#69, OQ1) — GitHub Actions hits this hourly
// (.github/workflows/practice-reminders-cron.yml) to fire the practice reminder
// (PRD §14: "Practice reminder | Confirmed members | SMS + Email | Configurable
// lead time before each event"). No Clerk session exists for a cron trigger, so
// auth is the shared CRON_SECRET bearer token — and the same secret is passed
// through to the two SECURITY DEFINER RPCs, which are gated on it (an
// unauthenticated caller must not be able to mark reminders sent — see the
// migration header, review B2).
//
// Flow: send_practice_reminders(secret) CLAIMS each due (event × confirmed
// member) pair (per-user reminder_hours_before lead time, per-user
// reminder_sms / reminder_email channel choice) and returns it with the
// per-channel sms_done / email_done flags. This route dispatches only the
// channels that are enabled AND not yet done, then calls
// confirm_practice_reminder_sent() with each channel's outcome. A channel that
// hard-fails is left un-done and retried next run (bounded to 3 attempts) —
// without re-sending the channel that already succeeded.
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
  const { data, error } = await supabase.rpc("send_practice_reminders", {
    p_cron_secret: cronSecret,
  });

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
  let confirmed = 0;

  for (const reminder of reminders) {
    const { dayDate, time } = formatEventWhen(reminder.start_time);
    const hoursUntil = Math.max(
      1,
      Math.round((new Date(reminder.start_time).getTime() - Date.now()) / 3_600_000),
    );
    const location = reminder.location ?? "TBD";
    const link = appNotificationUrl(`/week/${reminder.service_week_id}`);

    // Send only channels that are enabled for this user AND not already done
    // on a prior attempt (notification_preferences.reminder_sms /
    // reminder_email — the latter defaults false). SMS is additionally gated by
    // users.sms_opted_in inside sendSms.
    const needSms = reminder.reminder_sms && !reminder.sms_done;
    const needEmail = reminder.reminder_email && !reminder.email_done;

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
      sms: needSms
        ? {
            body: practiceReminderSms({
              eventName: reminder.event_name,
              when: dayDate,
              time,
              location: reminder.location,
            }),
          }
        : undefined,
      email: needEmail
        ? {
            template: "practice_reminder",
            data: { eventName: reminder.event_name, hoursUntil, dayDate, time, location, link },
          }
        : undefined,
    });

    smsSent += counts.smsSent;
    smsSkipped += counts.smsSkipped;
    smsFailed += counts.smsFailed;
    emailSent += counts.emailSent;
    emailSkipped += counts.emailSkipped;
    emailFailed += counts.emailFailed;

    // Record each channel's outcome. A channel that did not hard-fail (sent,
    // skipped, or not needed) is marked done; a hard failure is left un-done so
    // only THAT channel is retried next run — the succeeded channel is not
    // re-sent (review MED-1).
    const smsChannelDone = counts.smsFailed === 0;
    const emailChannelDone = counts.emailFailed === 0;
    const { data: didConfirm, error: confirmError } = await supabase.rpc(
      "confirm_practice_reminder_sent",
      {
        p_cron_secret: cronSecret,
        p_event_id: reminder.event_id,
        p_user_id: reminder.user_id,
        p_sms_done: smsChannelDone,
        p_email_done: emailChannelDone,
      },
    );
    if (!confirmError && didConfirm === true) {
      confirmed += 1;
    }
  }

  return ok({
    processed: reminders.length,
    smsSent,
    smsSkipped,
    smsFailed,
    emailSent,
    emailSkipped,
    emailFailed,
    confirmed,
  });
}
