"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { NotificationType } from "@/types/domain";
import {
  NOTIFICATION_FILTERS,
  matchesFilter,
  resolveNotificationHref,
  formatRelativeTime,
  type NotificationFilter,
} from "@/lib/notifications/inbox-links";
import { notifyUnreadChanged } from "@/components/layout/NotificationBell";
import styles from "./notification-inbox.module.css";

// Data shape returned by GET /api/notifications, wrapped in { data }
// (types/api.ts). Mirrors NotificationItem (app/api/notifications/handler.ts)
// — declared locally rather than imported, mirroring conflicts-list.tsx's
// Conflict type (client components never import from app/api/**).
type NotificationRow = {
  id: string;
  type: NotificationType;
  title: string;
  body: string | null;
  linkEntityType: string | null;
  linkEntityId: string | null;
  isRead: boolean;
  createdAt: string;
};

type ViewState = "loading" | "ready" | "error";

const ICON_BY_TYPE: Record<NotificationType, string> = {
  set_invitation: "📩",
  invitation_reminder: "⏰",
  invitation_accepted: "✅",
  invitation_denied: "❌",
  invitation_withdrawn: "↩️",
  practice_reminder: "⏰",
  setlist_released: "🎵",
  scheduling_conflict: "⚠️",
  chat_mention: "💬",
  devotion_shared: "📖",
  new_church_document: "📄",
  google_calendar_event: "📅",
  service_week_cancelled: "🚫",
  service_week_reactivated: "🔁",
  google_calendar_reauth_required: "🔒",
};

function iconForType(type: NotificationType): string {
  return ICON_BY_TYPE[type] ?? "🔔";
}

export default function NotificationInbox() {
  const [view, setView] = useState<ViewState>("loading");
  const [notifications, setNotifications] = useState<NotificationRow[]>([]);
  const [total, setTotal] = useState(0);
  const [filter, setFilter] = useState<NotificationFilter>("all");
  const [markingAll, setMarkingAll] = useState(false);
  const [markAllError, setMarkAllError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch("/api/notifications?page=1&pageSize=50");
        if (cancelled) return;

        if (!res.ok) {
          setView("error");
          return;
        }

        const body = await res.json();
        if (cancelled) return;

        setNotifications(body.data.notifications);
        setTotal(body.data.pagination.total);
        setView("ready");
      } catch {
        if (!cancelled) setView("error");
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const hasUnread = notifications.some((n) => !n.isRead);

  async function handleMarkAllRead() {
    if (markingAll || !hasUnread) return;
    setMarkingAll(true);
    setMarkAllError(null);

    try {
      const res = await fetch("/api/notifications/mark-all-read", { method: "POST" });
      if (!res.ok) {
        setMarkAllError("Something went wrong. Please try again.");
        return;
      }
      setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })));
      notifyUnreadChanged();
    } catch {
      setMarkAllError("Something went wrong. Please try again.");
    } finally {
      setMarkingAll(false);
    }
  }

  function handleRowActivate(row: NotificationRow) {
    if (!row.isRead) {
      setNotifications((prev) =>
        prev.map((n) => (n.id === row.id ? { ...n, isRead: true } : n)),
      );
      // Fire-and-forget: never await before navigating, never block on failure.
      fetch(`/api/notifications/${row.id}/read`, { method: "PATCH" }).catch(() => {});
      notifyUnreadChanged();
    }
  }

  if (view === "loading") {
    return (
      <main className={styles.container}>
        <p>Loading…</p>
      </main>
    );
  }

  if (view === "error") {
    return (
      <main className={styles.container}>
        <h1>Something went wrong</h1>
        <p>Please try again later.</p>
      </main>
    );
  }

  const visible = notifications.filter((n) => matchesFilter(n.type, filter));
  const activeFilterLabel =
    NOTIFICATION_FILTERS.find((f) => f.id === filter)?.label ?? "All";

  return (
    <main className={styles.container}>
      <div className={styles.header}>
        <h1>Notifications</h1>
        <button
          type="button"
          onClick={handleMarkAllRead}
          disabled={markingAll || !hasUnread}
        >
          {markingAll ? "Marking…" : "Mark all read"}
        </button>
      </div>
      {markAllError ? (
        <p role="alert" className={styles.error}>
          {markAllError}
        </p>
      ) : null}

      <nav className={styles.filters}>
        {NOTIFICATION_FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            className={`${styles.filterButton} ${
              filter === f.id ? styles.filterButtonActive : ""
            }`}
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
      </nav>

      {total === 0 ? (
        <p className={styles.empty}>No notifications yet.</p>
      ) : visible.length === 0 ? (
        <p className={styles.empty}>No {activeFilterLabel} notifications.</p>
      ) : (
        <ul className={styles.list}>
          {visible.map((row) => {
            const href = resolveNotificationHref(row.linkEntityType, row.linkEntityId);
            const rowClassName = `${styles.card} ${row.isRead ? "" : styles.unread}`;
            const content = (
              <>
                <span className={styles.icon} aria-hidden="true">
                  {iconForType(row.type)}
                </span>
                <span>
                  <span>{row.title}</span>
                  {!row.isRead ? (
                    <span className={styles.srOnly}>Unread</span>
                  ) : null}
                  {row.body !== null ? <p>{row.body}</p> : null}
                  <time className={styles.timestamp} dateTime={row.createdAt}>
                    {formatRelativeTime(row.createdAt)}
                  </time>
                </span>
              </>
            );

            return (
              <li key={row.id}>
                {href ? (
                  <Link
                    href={href}
                    className={rowClassName}
                    onClick={() => handleRowActivate(row)}
                  >
                    {content}
                  </Link>
                ) : (
                  <button
                    type="button"
                    className={rowClassName}
                    onClick={() => handleRowActivate(row)}
                  >
                    {content}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {total > notifications.length ? (
        <p className={styles.footnote}>
          Showing the {notifications.length} most recent of {total} notifications.
        </p>
      ) : null}
    </main>
  );
}
