"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/Badge";
import { ButtonLink } from "@/components/ui/Button";
import { interactiveCardClassName } from "@/components/ui/Card";
import { Icon } from "@/components/ui/Icon";
import { Page, PageHeader } from "@/components/ui/Page";
import { EmptyState, ErrorState, LoadingState, NoAccessState } from "@/components/ui/States";
import { formatServiceDate } from "@/lib/format/dates";
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

export default function ConflictsList() {
  const [view, setView] = useState<ViewState>("loading");
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [reloadKey, setReloadKey] = useState(0);

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
  }, [reloadKey]);

  if (view === "loading") {
    return (
      <Page>
        <LoadingState cards={2} />
      </Page>
    );
  }

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
        <ErrorState
          onRetry={() => {
            setView("loading");
            setReloadKey((k) => k + 1);
          }}
        />
      </Page>
    );
  }

  // ready
  return (
    <Page>
      <PageHeader
        title="Conflicts"
        subtitle="Confirmed members who can no longer serve on their date"
      >
        {conflicts.length > 0 ? <Badge tone="danger">{`${conflicts.length} open`}</Badge> : null}
      </PageHeader>
      {conflicts.length === 0 ? (
        <EmptyState icon="checkCircle" compact={false} title="No open conflicts. Everything's resolved." />
      ) : (
        <ul className={styles.list}>
          {conflicts.map((conflict) => (
            <li key={conflict.id}>
              <Link
                href={`/conflicts/${conflict.id}`}
                className={`${interactiveCardClassName} ${styles.card}`}
              >
                <span className={styles.icon}>
                  <Icon name="alert" />
                </span>
                <div className={styles.cardBody}>
                  <p className={styles.memberName}>{conflict.memberName}</p>
                  <div className={styles.cardHeader}>
                    <span className={styles.weekTitle}>{conflict.serviceWeekTitle ?? "Service"}</span>
                    <span className={styles.date}>{formatServiceDate(conflict.serviceDate)}</span>
                  </div>
                  {conflict.triggerReason ? (
                    <p className={styles.reason}>{conflict.triggerReason}</p>
                  ) : null}
                </div>
                <Icon name="chevronRight" className={styles.chevron} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}
