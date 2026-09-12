// Tests for lib/notifications/inbox-links.ts (#73): the pure helpers behind
// the Notification Inbox screen — filter mapping, deep-link resolution
// (including the option-C "invitation" -> /invitations/:id decision), and
// relative-time formatting.

import {
  NOTIFICATION_FILTERS,
  filterForType,
  matchesFilter,
  resolveNotificationHref,
  formatRelativeTime,
} from "@/lib/notifications/inbox-links";
import type { NotificationType } from "@/types/domain";

describe("NOTIFICATION_FILTERS", () => {
  it("is exactly the five filters, in order, with the documented labels", () => {
    expect(NOTIFICATION_FILTERS).toEqual([
      { id: "all", label: "All" },
      { id: "invitations", label: "Invitations" },
      { id: "setlists", label: "Setlists" },
      { id: "events", label: "Events" },
      { id: "chat", label: "Chat" },
    ]);
  });
});

describe("filterForType", () => {
  const cases: [NotificationType, ReturnType<typeof filterForType>][] = [
    ["set_invitation", "invitations"],
    ["invitation_reminder", "invitations"],
    ["invitation_accepted", "invitations"],
    ["invitation_denied", "invitations"],
    ["invitation_withdrawn", "invitations"],
    ["setlist_released", "setlists"],
    ["practice_reminder", "events"],
    ["scheduling_conflict", "events"],
    ["google_calendar_event", "events"],
    ["service_week_cancelled", "events"],
    ["service_week_reactivated", "events"],
    ["chat_mention", "chat"],
    ["devotion_shared", null],
    ["new_church_document", null],
    ["google_calendar_reauth_required", null],
  ];

  it.each(cases)("maps %s to %s", (type, expected) => {
    expect(filterForType(type)).toBe(expected);
  });
});

describe("matchesFilter", () => {
  it("'all' always matches, including types with no filter category", () => {
    expect(matchesFilter("devotion_shared", "all")).toBe(true);
    expect(matchesFilter("chat_mention", "all")).toBe(true);
  });

  it("matches when filterForType agrees with the filter", () => {
    expect(matchesFilter("chat_mention", "chat")).toBe(true);
    expect(matchesFilter("setlist_released", "setlists")).toBe(true);
  });

  it("does not match a different filter", () => {
    expect(matchesFilter("chat_mention", "setlists")).toBe(false);
  });

  it("a type with no category never matches a non-'all' filter", () => {
    expect(matchesFilter("devotion_shared", "invitations")).toBe(false);
    expect(matchesFilter("devotion_shared", "chat")).toBe(false);
  });
});

describe("resolveNotificationHref", () => {
  it("resolves 'setlist' to /setlists/:id", () => {
    expect(resolveNotificationHref("setlist", "s1")).toBe("/setlists/s1");
  });

  it("resolves 'conflict' to /conflicts/:id", () => {
    expect(resolveNotificationHref("conflict", "c1")).toBe("/conflicts/c1");
  });

  it("resolves 'service_week' to /member-week/:id", () => {
    expect(resolveNotificationHref("service_week", "w1")).toBe("/member-week/w1");
  });

  it("resolves 'invitation' to /invitations/:id (option C)", () => {
    expect(resolveNotificationHref("invitation", "i1")).toBe("/invitations/i1");
  });

  it("returns null for 'google_calendar' (no link_entity_id) even with an id present", () => {
    expect(resolveNotificationHref("google_calendar", "anything")).toBeNull();
  });

  it("returns null when linkEntityId is null", () => {
    expect(resolveNotificationHref("setlist", null)).toBeNull();
  });

  it("returns null when linkEntityId is empty string", () => {
    expect(resolveNotificationHref("setlist", "")).toBeNull();
  });

  it("returns null when linkEntityType is null", () => {
    expect(resolveNotificationHref(null, "s1")).toBeNull();
  });

  it("returns null (never throws) for an unknown/future linkEntityType", () => {
    expect(resolveNotificationHref("some_future_type", "x1")).toBeNull();
  });
});

describe("formatRelativeTime", () => {
  const now = new Date("2026-01-10T12:00:00.000Z");

  it("< 60s -> 'just now'", () => {
    const iso = new Date(now.getTime() - 30 * 1000).toISOString();
    expect(formatRelativeTime(iso, now)).toBe("just now");
  });

  it("exactly at the 60s boundary rolls into minutes", () => {
    const iso = new Date(now.getTime() - 60 * 1000).toISOString();
    expect(formatRelativeTime(iso, now)).toBe("1m ago");
  });

  it("< 60m -> 'Nm ago'", () => {
    const iso = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
    expect(formatRelativeTime(iso, now)).toBe("5m ago");
  });

  it("exactly at the 60m boundary rolls into hours", () => {
    const iso = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    expect(formatRelativeTime(iso, now)).toBe("1h ago");
  });

  it("< 24h -> 'Nh ago'", () => {
    const iso = new Date(now.getTime() - 5 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeTime(iso, now)).toBe("5h ago");
  });

  it("exactly at the 24h boundary rolls into days", () => {
    const iso = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeTime(iso, now)).toBe("1d ago");
  });

  it("< 7d -> 'Nd ago'", () => {
    const iso = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeTime(iso, now)).toBe("3d ago");
  });

  it(">= 7d -> absolute date", () => {
    const iso = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeTime(iso, now)).toBe("Jan 2, 2026");
  });

  it("a future timestamp (clock skew) renders 'just now', never negative", () => {
    const iso = new Date(now.getTime() + 5 * 60 * 1000).toISOString();
    expect(formatRelativeTime(iso, now)).toBe("just now");
  });

  it("an unparseable iso string returns '' and does not throw", () => {
    expect(() => formatRelativeTime("not-a-date", now)).not.toThrow();
    expect(formatRelativeTime("not-a-date", now)).toBe("");
  });

  it("an empty string returns '' and does not throw", () => {
    expect(formatRelativeTime("", now)).toBe("");
  });
});
