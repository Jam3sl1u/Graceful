// SMS copy builders for issue #67 (Pingram dispatch), transcribed verbatim
// from PRD section 30 (Notification Content Templates, doc lines 1698-1707), with
// placeholders substituted. Pure module; no "server-only" (same rationale as
// lib/scheduling/reminder.ts: unit-testable, reusable). Not yet wired to any
// caller except lib/scheduling/reminder.ts's own (different) copy; rewiring
// live triggers to these templates is #69; see .pipeline/spec.md decision 3/4
// for issue #67.

// Pingram's free tier caps a single-segment SMS at 160 chars; never send a
// multi-segment message silently (lib/pingram/client.ts enforces this on the
// dispatch side; every builder here also self-clamps as a second line of
// defense).
export const SMS_MAX_LENGTH = 160;

// Per-field truncation limits for free-text inputs (DB columns allow far
// longer text: role_note 500, reason 200, name 100, so these must be
// clamped before substitution). Truncated values get a GSM-7-safe "...".
const MEMBER_NAME_MAX = 40;
const ROLE_NOTE_MAX = 40;
const REASON_MAX = 60;
const EVENT_NAME_MAX = 40;
const LOCATION_MAX = 40;

export function truncateField(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
}

// Final safety net for copy without a link.
function clamp(value: string): string {
  if (value.length <= SMS_MAX_LENGTH) return value;
  return value.slice(0, SMS_MAX_LENGTH);
}

// Preserve the complete terminal link, truncating only the prose when needed.
// Callers pass prose with its intended link separator already included.
function fitWithLink(prose: string, link: string): string {
  if (prose.length + link.length <= SMS_MAX_LENGTH) return prose + link;
  const proseBudget = SMS_MAX_LENGTH - link.length;
  if (proseBudget <= 0) return link;
  if (proseBudget < 3) return link;
  return `${prose.slice(0, proseBudget - 3)}...${link}`;
}

export function setInvitationSms(p: { date: string; roleNote: string | null; link: string }): string {
  let text = `Graceful: You're invited to lead worship on ${p.date}.`;
  if (p.roleNote) {
    text += ` Role: ${truncateField(p.roleNote, ROLE_NOTE_MAX)}.`;
  }
  return fitWithLink(`${text} Respond here: `, p.link);
}

export function memberReminderSms(p: { date: string; link: string }): string {
  return fitWithLink(
    `Graceful: Reminder - your invitation for ${p.date} is still pending. Respond: `,
    p.link,
  );
}

export function adminReminderSms(p: { count: number; date: string; link: string }): string {
  return fitWithLink(
    `Graceful: ${p.count} invitation(s) for ${p.date} still awaiting response. View roster: `,
    p.link,
  );
}

export function invitationDeniedSms(p: {
  memberName: string;
  date: string;
  reason: string | null;
  link: string;
}): string {
  let text = `Graceful: ${truncateField(p.memberName, MEMBER_NAME_MAX)} can't make ${p.date}.`;
  if (p.reason) {
    text += ` Reason: ${truncateField(p.reason, REASON_MAX)}.`;
  }
  return fitWithLink(`${text} View roster: `, p.link);
}

export function schedulingConflictSms(p: { memberName: string; date: string; link: string }): string {
  return fitWithLink(
    `Graceful: CONFLICT - ${truncateField(p.memberName, MEMBER_NAME_MAX)} is now unavailable for ${p.date}. View: `,
    p.link,
  );
}

export function setlistPublishedSms(p: { date: string; link: string }): string {
  return fitWithLink(`Graceful: The setlist for ${p.date} is live. View it here: `, p.link);
}

export function practiceReminderSms(p: {
  eventName: string;
  when: string;
  time: string;
  location: string | null;
}): string {
  let text = `Graceful: ${truncateField(p.eventName, EVENT_NAME_MAX)} is ${p.when} at ${p.time}`;
  if (p.location) {
    text += ` - ${truncateField(p.location, LOCATION_MAX)}`;
  }
  return clamp(text);
}
