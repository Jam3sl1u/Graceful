import type { NotificationType } from "@/types/domain";

// Pure helpers for the Notification Inbox screen (PRD Screen 6 / issue #73).
// No React, no "server-only" — imported directly by the client component.

export type NotificationFilter = "all" | "invitations" | "setlists" | "events" | "chat";

export const NOTIFICATION_FILTERS: { id: NotificationFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "invitations", label: "Invitations" },
  { id: "setlists", label: "Setlists" },
  { id: "events", label: "Events" },
  { id: "chat", label: "Chat" },
];

const FILTER_BY_TYPE: Record<NotificationType, NotificationFilter | null> = {
  set_invitation: "invitations",
  invitation_reminder: "invitations",
  invitation_accepted: "invitations",
  invitation_denied: "invitations",
  invitation_withdrawn: "invitations",
  setlist_released: "setlists",
  practice_reminder: "events",
  scheduling_conflict: "events",
  google_calendar_event: "events",
  service_week_cancelled: "events",
  service_week_reactivated: "events",
  chat_mention: "chat",
  devotion_shared: null,
  new_church_document: null,
  google_calendar_reauth_required: null,
};

export function filterForType(type: NotificationType): NotificationFilter | null {
  return FILTER_BY_TYPE[type] ?? null;
}

export function matchesFilter(type: NotificationType, filter: NotificationFilter): boolean {
  if (filter === "all") return true;
  return filterForType(type) === filter;
}

// Deep-link resolution (OPEN QUESTION, resolved by human operator, 2026-09):
// invitation rows link to the in-app accept/deny screen at
// /invitations/:id, backed by GET/POST /api/invitations/:id (and the
// existing /accept, /deny endpoints), all member-scoped — no response_token
// involved. Anything unresolvable (null id/type, unknown type) is
// non-clickable (returns null) — rows still mark read on tap.
export function resolveNotificationHref(
  linkEntityType: string | null,
  linkEntityId: string | null,
): string | null {
  if (!linkEntityId || !linkEntityType) return null;

  switch (linkEntityType) {
    case "setlist":
      return `/setlists/${linkEntityId}`;
    case "conflict":
      return `/conflicts/${linkEntityId}`;
    case "service_week":
      return `/member-week/${linkEntityId}`;
    case "invitation":
      return `/invitations/${linkEntityId}`;
    default:
      return null;
  }
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";

  const diffMs = now.getTime() - then.getTime();
  // Future timestamps (clock skew) and anything under a minute both read as
  // "just now" — never a negative duration.
  if (diffMs < MINUTE_MS) return "just now";

  if (diffMs < HOUR_MS) {
    const minutes = Math.floor(diffMs / MINUTE_MS);
    return `${minutes}m ago`;
  }

  if (diffMs < DAY_MS) {
    const hours = Math.floor(diffMs / HOUR_MS);
    return `${hours}h ago`;
  }

  if (diffMs < 7 * DAY_MS) {
    const days = Math.floor(diffMs / DAY_MS);
    return `${days}d ago`;
  }

  return then.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
