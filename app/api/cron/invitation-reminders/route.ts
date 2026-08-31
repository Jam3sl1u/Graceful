import { NextRequest } from "next/server";
import { ok, fail } from "@/lib/api/response";
import { ErrorCode } from "@/lib/api/errors";
import { getAnonSupabaseClient } from "@/lib/supabase/client";
import { sendSms } from "@/lib/pingram/client";
import { buildMemberReminderSms, formatWeekLabel } from "@/lib/scheduling/reminder";
import { adminReminderSms } from "@/lib/notifications/sms-templates";
import { dispatchNotification, appNotificationUrl } from "@/lib/notifications/dispatch";

// GET /api/cron/invitation-reminders (#45) — GitHub Actions hits this hourly
// (.github/workflows/invitation-reminders-cron.yml) to fire the 24-hour
// dual-party invitation reminder. No Clerk session exists for a cron
// trigger, so auth is a shared
// CRON_SECRET bearer token instead. All DB work — selecting due
// invitations, stamping last_reminded_at, and inserting admin
// notifications — happens atomically inside the send_invitation_reminders
// SECURITY DEFINER RPC (mirrors the no-session accept_invitation path via
// getAnonSupabaseClient()). This route's only remaining job is dispatching
// the member SMS (#67) and, as of #69, the admin SMS (PRD §14:
// "Invitation reminder | Member + Admin | SMS" — SMS only, no email).
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
  const { data, error } = await supabase.rpc("send_invitation_reminders");

  if (error) {
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }

  const payload = data ?? { member_reminders: [], admin_reminders: [] };
  const reminders = payload.member_reminders ?? [];
  const adminReminders = payload.admin_reminders ?? [];

  let smsSent = 0;
  let smsSkipped = 0;
  let smsFailed = 0;

  for (const reminder of reminders) {
    if (!reminder.phone || reminder.sms_opted_in !== true) {
      smsSkipped += 1;
      continue;
    }

    try {
      const result = await sendSms({
        to: reminder.phone,
        body: buildMemberReminderSms(
          reminder.member_name,
          formatWeekLabel(reminder.week_title, reminder.service_date),
        ),
        smsOptedIn: reminder.sms_opted_in === true,
      });
      if (result.status === "sent") {
        smsSent += 1;
      } else {
        smsSkipped += 1;
      }
    } catch (err) {
      // A dispatch failure (Pingram outage, bad config, invalid body, etc.)
      // must not fail the whole job (each invitation was already stamped +
      // listed to admins by the RPC).
      smsFailed += 1;
      console.error("invitation-reminders: sendSms failed", err);
    }
  }

  // Admin SMS reminders (PRD §14: SMS only — no email key). Each entry is one
  // (service week × admin/set_leader) pair already resolved by the RPC. Fold
  // the returned counters into the same three totals.
  for (const admin of adminReminders) {
    const counts = await dispatchNotification({
      recipients: [
        {
          userId: admin.user_id,
          name: admin.name,
          email: null,
          phone: admin.phone,
          smsOptedIn: admin.sms_opted_in,
        },
      ],
      sms: {
        body: adminReminderSms({
          count: admin.pending_count,
          date: formatWeekLabel(admin.week_title, admin.service_date),
          link: appNotificationUrl(`/week/${admin.service_week_id}`),
        }),
      },
    });
    smsSent += counts.smsSent;
    smsSkipped += counts.smsSkipped;
    smsFailed += counts.smsFailed;
  }

  return ok({
    processed: reminders.length,
    smsSent,
    smsSkipped,
    smsFailed,
    adminNotified: adminReminders.length,
  });
}
