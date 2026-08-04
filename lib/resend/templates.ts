// Pure email-template rendering for issue #68 (Resend email dispatch).
// Kept pure (no "server-only") like lib/scheduling/reminder.ts, so it can be
// unit-tested without a live Resend client. Copy exactly (PRD §30
// "Notification Content Templates") — do not add styling, images, or layout
// beyond the plain subject/preview/link shape below; visual polish is out of
// scope for this issue.

export type EmailTemplateKey =
  | "set_invitation"
  | "invitation_reminder_member"
  | "invitation_reminder_admin"
  | "invitation_denied"
  | "scheduling_conflict"
  | "setlist_released"
  | "practice_reminder";

export const EMAIL_TEMPLATE_KEYS: readonly EmailTemplateKey[] = [
  "set_invitation",
  "invitation_reminder_member",
  "invitation_reminder_admin",
  "invitation_denied",
  "scheduling_conflict",
  "setlist_released",
  "practice_reminder",
];

export type EmailTemplateDataMap = {
  set_invitation: { date: string; adminName: string; link: string };
  invitation_reminder_member: { date: string; link: string };
  invitation_reminder_admin: { count: number; date: string; memberNames: string[]; link: string };
  invitation_denied: { memberName: string; date: string; reason: string | null; link: string };
  scheduling_conflict: { memberName: string; date: string; link: string };
  setlist_released: { date: string; songCount: number; link: string };
  practice_reminder: {
    eventName: string;
    hoursUntil: number;
    dayDate: string;
    time: string;
    location: string;
    link?: string;
  };
};

export type RenderedEmail = { subject: string; preview: string; html: string; text: string };

// All date / dayDate / time fields are already-formatted display strings
// supplied by the caller (#69 owns formatting — see formatWeekLabel in
// lib/scheduling/reminder.ts). This module must never parse or format a
// date, and must not import from that file.

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildContent(key: EmailTemplateKey, data: EmailTemplateDataMap[EmailTemplateKey]): {
  subject: string;
  preview: string;
  link?: string;
} {
  switch (key) {
    case "set_invitation": {
      const d = data as EmailTemplateDataMap["set_invitation"];
      return {
        subject: `You're invited to lead worship on ${d.date}`,
        preview: `${d.adminName} has selected you for ${d.date}. Tap to accept or decline.`,
        link: d.link,
      };
    }
    case "invitation_reminder_member": {
      const d = data as EmailTemplateDataMap["invitation_reminder_member"];
      return {
        subject: `Your invitation for ${d.date} needs a response`,
        preview: `You haven't responded yet. Please accept or decline.`,
        link: d.link,
      };
    }
    case "invitation_reminder_admin": {
      const d = data as EmailTemplateDataMap["invitation_reminder_admin"];
      if (d.memberNames.length === 0) {
        throw new Error("invitation_reminder_admin requires at least one member name");
      }
      return {
        subject: `${d.count} unanswered invitations for ${d.date}`,
        preview: `The following members haven't responded: ${d.memberNames.join(", ")}`,
        link: d.link,
      };
    }
    case "invitation_denied": {
      const d = data as EmailTemplateDataMap["invitation_denied"];
      const hasReason = d.reason !== null && d.reason.trim().length > 0;
      return {
        subject: `${d.memberName} declined for ${d.date}`,
        preview: hasReason
          ? `Reason: ${d.reason}. Open Graceful to find a replacement.`
          : `Open Graceful to find a replacement.`,
        link: d.link,
      };
    }
    case "scheduling_conflict": {
      const d = data as EmailTemplateDataMap["scheduling_conflict"];
      return {
        subject: `Scheduling conflict for ${d.date}`,
        preview: `${d.memberName} changed their availability after confirming. Action may be needed.`,
        link: d.link,
      };
    }
    case "setlist_released": {
      const d = data as EmailTemplateDataMap["setlist_released"];
      return {
        subject: `Setlist for ${d.date} is ready`,
        preview: `${d.songCount} songs planned. Open Graceful to see the full setlist and your chord charts.`,
        link: d.link,
      };
    }
    case "practice_reminder": {
      const d = data as EmailTemplateDataMap["practice_reminder"];
      return {
        subject: `Reminder: ${d.eventName} in ${d.hoursUntil} hours`,
        preview: `${d.dayDate} at ${d.time} — ${d.location}. See you there.`,
        link: d.link,
      };
    }
    default: {
      const _exhaustive: never = key;
      throw new Error(`Unknown email template: ${_exhaustive}`);
    }
  }
}

export function renderEmailTemplate<K extends EmailTemplateKey>(
  key: K,
  data: EmailTemplateDataMap[K],
): RenderedEmail {
  if (!EMAIL_TEMPLATE_KEYS.includes(key)) {
    throw new Error(`Unknown email template: ${key}`);
  }

  const { subject, preview, link } = buildContent(key, data);

  const linkHtml = link
    ? `<p><a href="${escapeHtml(link)}">Open Graceful</a></p>`
    : "";
  const html =
    `<!doctype html><html><body>` +
    `<div style="display:none;max-height:0;overflow:hidden;">${escapeHtml(preview)}</div>` +
    `<h1>${escapeHtml(subject)}</h1>` +
    `<p>${escapeHtml(preview)}</p>` +
    linkHtml +
    `</body></html>`;

  const text = `${subject}\n\n${preview}` + (link ? `\n\n${link}` : "");

  return { subject, preview, html, text };
}
