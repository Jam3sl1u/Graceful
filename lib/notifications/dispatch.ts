import "server-only";
import { sendSms } from "@/lib/pingram/client";
import { sendEmail } from "@/lib/resend/client";
import type { EmailTemplateKey, EmailTemplateDataMap } from "@/lib/resend/templates";

// Server-only fan-out helper for issue #69 (wire notification triggers for all
// Phase 1 event types). Wraps the side-effecting sendSms / sendEmail calls the
// same way lib/scheduling/conflict-detection.ts wraps record_availability_conflict:
// a single module every trigger path calls, with the RLS / consent constraints
// documented here.
//
// RLS / consent constraints:
//   - Recipient contact details (name/email/phone/sms_opted_in) must be looked
//     up by the caller. Authenticated handlers can read every `users` row in
//     their own church group (20260704000001_rls_policies.sql:
//     users_select_tenant); the anon / no-session paths cannot and must get the
//     data out of a SECURITY DEFINER RPC instead.
//   - sms_opted_in is enforced inside sendSms itself — this module just forwards
//     the caller-supplied value.
//
// PII rule (PRD §25.6, mirrors lib/resend/client.ts): console.error on a failed
// send logs the recipient's userId and the error only — never a phone number,
// email address, message body, or subject.

export type NotificationRecipient = {
  userId: string;
  name: string;
  email: string | null;
  phone: string | null;
  smsOptedIn: boolean;
};

export type DispatchCounts = {
  smsSent: number;
  smsSkipped: number;
  smsFailed: number;
  emailSent: number;
  emailSkipped: number;
  emailFailed: number;
};

// Absolute app URL for a notification deep link. Mirrors the `appUrl` helper in
// app/api/invitations/handler.ts: NEXT_PUBLIC_APP_URL with trailing slashes
// stripped, or a site-relative path when it is unset. A site-relative path is
// rejected by renderEmailTemplate (email link must be absolute HTTPS) but is
// accepted by the SMS templates — dispatchNotification handles that asymmetry
// by counting the email as emailFailed while still sending the SMS.
export function appNotificationUrl(path: string): string {
  const base = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/+$/, "");
  return `${base}${path}`;
}

// Fan out one notification to a set of recipients over the requested channels.
// NEVER throws: every call site awaits it and must still return its normal
// success response even when every individual send fails.
export async function dispatchNotification<K extends EmailTemplateKey>(params: {
  recipients: NotificationRecipient[];
  sms?: { body: string };
  email?: { template: K; data: EmailTemplateDataMap[K] };
}): Promise<DispatchCounts> {
  const counts: DispatchCounts = {
    smsSent: 0,
    smsSkipped: 0,
    smsFailed: 0,
    emailSent: 0,
    emailSkipped: 0,
    emailFailed: 0,
  };

  // Dedupe by userId, first occurrence wins.
  const seen = new Set<string>();
  const recipients = params.recipients.filter((r) => {
    if (seen.has(r.userId)) return false;
    seen.add(r.userId);
    return true;
  });

  // Sequential sends, matching the loop in
  // app/api/cron/invitation-reminders/route.ts.
  for (const recipient of recipients) {
    if (params.sms) {
      try {
        const result = await sendSms({
          to: recipient.phone,
          body: params.sms.body,
          smsOptedIn: recipient.smsOptedIn,
        });
        if (result.status === "sent") {
          counts.smsSent += 1;
        } else {
          counts.smsSkipped += 1;
        }
      } catch (err) {
        counts.smsFailed += 1;
        console.error("dispatchNotification: sendSms failed", recipient.userId, err);
      }
    }

    if (params.email) {
      if (!recipient.email || !recipient.email.trim()) {
        counts.emailSkipped += 1;
      } else {
        try {
          await sendEmail(recipient.email, params.email.template, params.email.data);
          counts.emailSent += 1;
        } catch (err) {
          counts.emailFailed += 1;
          console.error("dispatchNotification: sendEmail failed", recipient.userId, err);
        }
      }
    }
  }

  return counts;
}
