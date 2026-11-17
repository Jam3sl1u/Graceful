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
import { Button } from "@/components/ui/Button";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Page, PageHeader } from "@/components/ui/Page";
import { EmptyState, ErrorAlert, ErrorState, LoadingState } from "@/components/ui/States";
import { useToast } from "@/components/ui/Toast";
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

type Tone = "info" | "success" | "warning" | "danger";

const ICON_BY_TYPE: Record<NotificationType, { icon: IconName; tone: Tone }> = {
  set_invitation: { icon: "mail", tone: "warning" },
  invitation_reminder: { icon: "clock", tone: "warning" },
  invitation_accepted: { icon: "checkCircle", tone: "success" },
  invitation_denied: { icon: "x", tone: "danger" },
  invitation_withdrawn: { icon: "undo", tone: "info" },
  practice_reminder: { icon: "clock", tone: "info" },
  setlist_released: { icon: "music", tone: "info" },
  scheduling_conflict: { icon: "alert", tone: "danger" },
  chat_mention: { icon: "chat", tone: "info" },
  devotion_shared: { icon: "book", tone: "info" },
  new_church_document: { icon: "file", tone: "info" },
  google_calendar_event: { icon: "calendar", tone: "info" },
  service_week_cancelled: { icon: "ban", tone: "danger" },
  service_week_reactivated: { icon: "refresh", tone: "success" },
  google_calendar_reauth_required: { icon: "lock", tone: "warning" },
};

function iconForType(type: NotificationType): { icon: IconName; tone: Tone } {
  return ICON_BY_TYPE[type] ?? { icon: "bell", tone: "info" };
}

export default function NotificationInbox() {
  const [view, setView] = useState<ViewState>("loading");
  const [notifications, setNotifications] = useState<NotificationRow[]>([]);
  const [total, setTotal] = useState(0);
  const [filter, setFilter] = useState<NotificationFilter>("all");
  const [markingAll, setMarkingAll] = useState(false);
  const [markAllError, setMarkAllError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const { toast } = useToast();

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
  }, [reloadKey]);

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
      toast("All notifications marked as read");
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
      <Page>
        <LoadingState cards={3} />
      </Page>
    );
  }

  if (view === "error") {
    return (
      <Page>
        <ErrorState
          onRetry={() => {
            setView("loading");
            setReloadKey((k) => k + 1);
          }}
        />
      </Page>
    );
  }

  const visible = notifications.filter((n) => matchesFilter(n.type, filter));
  const activeFilterLabel =
    NOTIFICATION_FILTERS.find((f) => f.id === filter)?.label ?? "All";
  const unreadCount = notifications.filter((n) => !n.isRead).length;

  return (
    <Page>
      <PageHeader
        title="Notifications"
        subtitle={unreadCount > 0 ? `${unreadCount} unread` : "You're all caught up"}
      >
        <Button
          variant="secondary"
          onClick={handleMarkAllRead}
          disabled={markingAll || !hasUnread}
          loading={markingAll}
        >
          {markingAll ? "Marking…" : "Mark all read"}
        </Button>
      </PageHeader>
      {markAllError ? <ErrorAlert>{markAllError}</ErrorAlert> : null}

      <div className={styles.filters} role="group" aria-label="Filter notifications">
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
      </div>

      {total === 0 ? (
        <EmptyState icon="bell" compact={false} title="No notifications yet.">
          Invitations, setlists and schedule changes will show up here.
        </EmptyState>
      ) : visible.length === 0 ? (
        <EmptyState icon="bell" title={`No ${activeFilterLabel} notifications.`} />
      ) : (
        <ul className={styles.list}>
          {visible.map((row) => {
            const href = resolveNotificationHref(row.linkEntityType, row.linkEntityId);
            const rowClassName = `${styles.card} ${row.isRead ? "" : styles.unread}`;
            const { icon, tone } = iconForType(row.type);
            const content = (
              <>
                <span className={`${styles.icon} ${styles[tone]}`}>
                  <Icon name={icon} />
                </span>
                <span className={styles.text}>
                  <span className={styles.title}>{row.title}</span>
                  {!row.isRead ? <span className="sr-only">Unread</span> : null}
                  {row.body !== null ? <span className={styles.body}>{row.body}</span> : null}
                  <time className={styles.timestamp} dateTime={row.createdAt}>
                    {formatRelativeTime(row.createdAt)}
                  </time>
                </span>
                {!row.isRead ? <span className={styles.dot} aria-hidden="true" /> : null}
                {href ? <Icon name="chevronRight" className={styles.chevron} /> : null}
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
    </Page>
  );
}
