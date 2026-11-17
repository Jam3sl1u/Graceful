"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Icon } from "@/components/ui/Icon";
import styles from "./NotificationBell.module.css";

// Custom event dispatched whenever a caller changes the unread notification
// count (mark-all-read, per-row read) so this bell can refresh without
// polling. Exported here — notification-inbox.tsx imports both.
export const UNREAD_CHANGED_EVENT = "notifications:unread-changed";

export function notifyUnreadChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(UNREAD_CHANGED_EVENT));
}

type NotificationBellProps = {
  /** Show the word "Notifications" next to the icon (nav usage). */
  showLabel?: boolean;
  /** Replaces the default 44px icon-button styling (nav usage). */
  className?: string;
};

export function NotificationBell({
  showLabel = false,
  className,
}: NotificationBellProps = {}): React.JSX.Element {
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch("/api/notifications/unread-count");
        if (cancelled) return;
        if (!res.ok) {
          setUnreadCount(0);
          return;
        }
        const body = await res.json();
        if (cancelled) return;
        setUnreadCount(body.data.unreadCount);
      } catch {
        if (!cancelled) setUnreadCount(0);
      }
    }

    load();

    window.addEventListener(UNREAD_CHANGED_EVENT, load);
    return () => {
      cancelled = true;
      window.removeEventListener(UNREAD_CHANGED_EVENT, load);
    };
  }, []);

  const badgeText = unreadCount > 99 ? "99+" : String(unreadCount);

  return (
    <Link
      href="/notifications"
      aria-label="Notifications"
      aria-describedby={unreadCount > 0 ? "notification-bell-count" : undefined}
      className={className ?? styles.link}
    >
      <span className={styles.iconWrap}>
        <Icon name="bell" size={22} />
        {unreadCount > 0 ? (
          <span
            id="notification-bell-count"
            className={styles.badge}
            aria-label={`${unreadCount} unread notifications`}
          >
            {badgeText}
          </span>
        ) : null}
      </span>
      {showLabel ? <span aria-hidden="true">Notifications</span> : null}
      {/* Announces changes to the count without moving focus. */}
      <span className="sr-only" role="status">
        {unreadCount > 0 ? `${unreadCount} unread` : ""}
      </span>
    </Link>
  );
}
