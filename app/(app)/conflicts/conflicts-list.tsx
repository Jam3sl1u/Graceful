"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import styles from "./conflicts-list.module.css";

// Data shape returned by GET /api/conflicts, wrapped in { data } (types/api.ts).
// Subset of OpenConflict (app/api/conflicts/handler.ts) needed by this screen.
type Conflict = {
  id: string;
  memberName: string;
  serviceDate: string; // "YYYY-MM-DD"
  serviceWeekTitle: string | null;
  roleNote: string | null;
  triggerReason: string | null;
};

type ViewState = "loading" | "ready" | "forbidden" | "error";

// Matches formatServiceDate in conflict-resolution.tsx / week-view.tsx exactly
// (local-time interpretation of the YYYY-MM-DD string).
function formatServiceDate(dateStr: string): string {
  const date = new Date(`${dateStr}T00:00:00`);
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export default function ConflictsList() {
  const [view, setView] = useState<ViewState>("loading");
  const [conflicts, setConflicts] = useState<Conflict[]>([]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch("/api/conflicts");
        if (cancelled) return;

        if (res.status === 403) {
          setView("forbidden");
          return;
        }
        if (!res.ok) {
          setView("error");
          return;
        }

        const body = await res.json();
        if (cancelled) return;

        setConflicts(body.data.conflicts);
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

  if (view === "loading") {
    return (
      <main className={styles.container}>
        <p>Loading…</p>
      </main>
    );
  }

  if (view === "forbidden") {
    return (
      <main className={styles.container}>
        <h1>You don&apos;t have access to this page</h1>
        <p>This screen is available to Set Leaders and Admins only.</p>
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

  // ready
  return (
    <main className={styles.container}>
      <h1>Conflicts</h1>
      {conflicts.length === 0 ? (
        <p>No open conflicts. Everything&apos;s resolved.</p>
      ) : (
        <ul className={styles.list}>
          {conflicts.map((conflict) => (
            <li key={conflict.id}>
              <Link href={`/conflicts/${conflict.id}`} className={styles.card}>
                <div className={styles.cardHeader}>
                  <span className={styles.weekTitle}>{conflict.serviceWeekTitle ?? "Service"}</span>
                  <span className={styles.date}>{formatServiceDate(conflict.serviceDate)}</span>
                </div>
                <p className={styles.memberName}>{conflict.memberName}</p>
                {conflict.triggerReason ? (
                  <p className={styles.reason}>{conflict.triggerReason}</p>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
