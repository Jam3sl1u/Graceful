"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/Badge";
import styles from "./admin-dashboard.module.css";

// Data shape returned by GET /api/service-weeks/overview, wrapped in { data }
// (types/api.ts). Kept local/minimal rather than importing the handler's
// response type (mirrors the comment at the top of week-view.tsx).
type OverviewWeek = {
  id: string;
  serviceDate: string;
  title: string | null;
  isCancelled: boolean;
  setlistStatus: "draft" | "published" | null;
  confirmedCount: number;
  rosterSize: number;
  openConflictCount: number;
};

type StatusFilter = "all" | "active" | "cancelled";

type ViewState = "loading" | "ready" | "forbidden" | "error";

// Matches formatServiceDate in conflicts-list.tsx / week-view.tsx exactly
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

export default function AdminDashboard() {
  const [view, setView] = useState<ViewState>("loading");
  const [weeks, setWeeks] = useState<OverviewWeek[]>([]);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [filterError, setFilterError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setView("loading");

    async function load() {
      try {
        const params = new URLSearchParams();
        params.set("status", status);
        if (startDate) params.set("startDate", startDate);
        if (endDate) params.set("endDate", endDate);

        const res = await fetch(`/api/service-weeks/overview?${params.toString()}`);
        if (cancelled) return;

        if (res.status === 403) {
          setView("forbidden");
          return;
        }
        if (res.status === 400) {
          setWeeks([]);
          setFilterError(
            "Check the date range — the start date must be on or before the end date.",
          );
          setView("ready");
          return;
        }
        if (!res.ok) {
          setView("error");
          return;
        }

        const body = await res.json();
        if (cancelled) return;

        setWeeks(body.data.serviceWeeks);
        setFilterError(null);
        setView("ready");
      } catch {
        if (!cancelled) setView("error");
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [startDate, endDate, status]);

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
      <h1>Global dashboard</h1>

      <div className={styles.filters}>
        <div className={styles.filterField}>
          <label htmlFor="dashboard-from">From</label>
          <input
            id="dashboard-from"
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
          />
        </div>
        <div className={styles.filterField}>
          <label htmlFor="dashboard-to">To</label>
          <input
            id="dashboard-to"
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
          />
        </div>
        <div className={styles.filterField}>
          <label htmlFor="dashboard-status">Status</label>
          <select
            id="dashboard-status"
            value={status}
            onChange={(e) => setStatus(e.target.value as StatusFilter)}
          >
            <option value="all">All</option>
            <option value="active">Active</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </div>
      </div>

      {filterError ? <p role="alert">{filterError}</p> : null}

      {weeks.length === 0 ? (
        <p>No service weeks match these filters.</p>
      ) : (
        <ul className={styles.list}>
          {weeks.map((week) => {
            const publishBadge =
              week.setlistStatus === "published"
                ? { tone: "success" as const, text: "Published" }
                : week.setlistStatus === "draft"
                  ? { tone: "neutral" as const, text: "Draft" }
                  : { tone: "neutral" as const, text: "No setlist" };

            return (
              <li key={week.id}>
                <Link href={`/week/${week.id}`} className={styles.card}>
                  <div className={styles.cardHeader}>
                    <span className={styles.weekTitle}>{week.title ?? "Untitled service"}</span>
                    <span className={styles.date}>{formatServiceDate(week.serviceDate)}</span>
                  </div>
                  <div className={styles.cardMeta}>
                    <Badge tone={publishBadge.tone}>{publishBadge.text}</Badge>
                    {week.isCancelled ? <Badge tone="danger">Cancelled</Badge> : null}
                    <span>
                      {week.rosterSize === 0
                        ? "No one invited yet"
                        : `${week.confirmedCount} of ${week.rosterSize} confirmed`}
                    </span>
                    {week.openConflictCount > 0 ? (
                      <Badge tone="danger">
                        {`${week.openConflictCount} open conflict${
                          week.openConflictCount === 1 ? "" : "s"
                        }`}
                      </Badge>
                    ) : null}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
