// Pure, mocked-time-testable reminder logic for issue #45 (24-hour
// dual-party invitation reminder scheduler). Kept pure (no "server-only")
// like lib/scheduling/conflict-detection.ts's exports, so it can be
// unit-tested with fixed Date fixtures instead of real waiting.

export const REMINDER_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Mirrors the SQL selector in send_invitation_reminders()
// (supabase/migrations/20260713000001_invitation_reminder_scheduler.sql):
//   status = 'pending' AND coalesce(last_reminded_at, created_at) <= now() - interval '24 hours'
// Keep the two in sync if the threshold or pending check ever changes.
export function isReminderDue(
  invitation: { status: string; createdAt: string; lastRemindedAt: string | null },
  now: Date,
): boolean {
  if (invitation.status !== "pending") return false;

  const anchorMs = new Date(invitation.lastRemindedAt ?? invitation.createdAt).getTime();
  return anchorMs <= now.getTime() - REMINDER_INTERVAL_MS;
}

// Member SMS copy. Keep it short (SMS).
export function buildMemberReminderSms(memberName: string, weekLabel: string): string {
  return `Hi ${memberName}, you still have a pending invitation for ${weekLabel}. Please respond when you can.`;
}

// Week label used in both the SMS and (conceptually) the admin body.
export function formatWeekLabel(title: string | null, serviceDate: string): string {
  if (title) return title;

  const date = new Date(`${serviceDate}T00:00:00Z`);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
    timeZone: "UTC",
  });
}
