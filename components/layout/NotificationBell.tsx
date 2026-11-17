"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import styles from "./NotificationBell.module.css";

// Custom event dispatched whenever a caller changes the unread notification
// count (mark-all-read, per-row read) so this bell can refresh without
// polling. Exported here — notification-inbox.tsx imports both.
export const UNREAD_CHANGED_EVENT = "notifications:unread-changed";

export function notifyUnreadChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(UNREAD_CHANGED_EVENT));
}

export function NotificationBell(): React.JSX.Element {
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
    <Link href="/notifications" aria-label="Notifications" className={styles.link}>
      <span className={styles.icon} aria-hidden="true">
        🔔
      </span>
      {unreadCount > 0 ? (
        <span className={styles.badge} aria-label={`${unreadCount} unread notifications`}>
          {badgeText}
        </span>
      ) : null}
    </Link>
  );
}
