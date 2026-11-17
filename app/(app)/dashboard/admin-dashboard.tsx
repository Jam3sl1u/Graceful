"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/Badge";
import { ButtonLink } from "@/components/ui/Button";
import { interactiveCardClassName } from "@/components/ui/Card";
import { InputField, SelectField } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Page, PageHeader } from "@/components/ui/Page";
import { EmptyState, ErrorState, LoadingState, NoAccessState } from "@/components/ui/States";
import { formatServiceDate } from "@/lib/format/dates";
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

export default function AdminDashboard() {
  const [view, setView] = useState<ViewState>("loading");
  const [weeks, setWeeks] = useState<OverviewWeek[]>([]);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [filterError, setFilterError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

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
  }, [startDate, endDate, status, reloadKey]);

  if (view === "forbidden") {
    return (
      <Page>
        <NoAccessState
          actions={
            <ButtonLink href="/notifications" variant="secondary">
              Go to notifications
            </ButtonLink>
          }
        >
          This screen is available to Set Leaders and Admins only.
        </NoAccessState>
      </Page>
    );
  }

  if (view === "error") {
    return (
      <Page>
        <ErrorState onRetry={() => setReloadKey((k) => k + 1)} />
      </Page>
    );
  }

  // loading | ready — the filters stay mounted while a new result loads, so
  // changing one never drops keyboard focus.
  return (
    <Page>
      <PageHeader title="Schedule" subtitle="Every service week for your church group" />

      <div className={styles.filters} role="group" aria-label="Filter service weeks">
        <InputField
          id="dashboard-from"
          label="From"
          type="date"
          value={startDate}
          aria-invalid={filterError ? true : undefined}
          aria-describedby={filterError ? "dashboard-filter-error" : undefined}
          onChange={(e) => setStartDate(e.target.value)}
        />
        <InputField
          id="dashboard-to"
          label="To"
          type="date"
          value={endDate}
          aria-invalid={filterError ? true : undefined}
          aria-describedby={filterError ? "dashboard-filter-error" : undefined}
          onChange={(e) => setEndDate(e.target.value)}
        />
        <SelectField
          id="dashboard-status"
          label="Status"
          value={status}
          onChange={(e) => setStatus(e.target.value as StatusFilter)}
        >
          <option value="all">All</option>
          <option value="active">Active</option>
          <option value="cancelled">Cancelled</option>
        </SelectField>
      </div>

      {filterError ? (
        <p id="dashboard-filter-error" role="alert" className={styles.filterError}>
          {filterError}
        </p>
      ) : null}

      {view === "loading" ? (
        <LoadingState cards={3} />
      ) : weeks.length === 0 ? (
        <EmptyState icon="calendar" compact={false} title="No service weeks match these filters.">
          Try a wider date range or a different status.
        </EmptyState>
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
                <Link
                  href={`/week/${week.id}`}
                  className={`${interactiveCardClassName} ${styles.card} ${
                    week.isCancelled ? styles.cancelled : ""
                  }`}
                >
                  <div className={styles.cardBody}>
                    <div className={styles.cardHeader}>
                      <span className={styles.weekTitle}>{week.title ?? "Untitled service"}</span>
                      <span className={styles.date}>{formatServiceDate(week.serviceDate)}</span>
                    </div>
                    <div className={styles.cardMeta}>
                      <Badge tone={publishBadge.tone}>{publishBadge.text}</Badge>
                      {week.isCancelled ? <Badge tone="danger">Cancelled</Badge> : null}
                      <span className={styles.count}>
                        <Icon name="users" size={16} />
                        <span>
                          {week.rosterSize === 0
                            ? "No one invited yet"
                            : `${week.confirmedCount} of ${week.rosterSize} confirmed`}
                        </span>
                      </span>
                      {week.openConflictCount > 0 ? (
                        <Badge tone="danger">
                          {`${week.openConflictCount} open conflict${
                            week.openConflictCount === 1 ? "" : "s"
                          }`}
                        </Badge>
                      ) : null}
                    </div>
                  </div>
                  <Icon name="chevronRight" className={styles.chevron} />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Page>
  );
}
