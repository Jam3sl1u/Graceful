"use client";

import { useEffect, useState } from "react";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Icon } from "@/components/ui/Icon";
import { Page } from "@/components/ui/Page";
import { ErrorAlert, LoadingState, NoticeState, SuccessState } from "@/components/ui/States";
import { formatServiceDate } from "@/lib/format/dates";
import styles from "./conflict-resolution.module.css";

// Data shape returned by GET /api/conflicts, wrapped in { data } (types/api.ts).
// Subset of OpenConflict (app/api/conflicts/handler.ts) needed by this screen.
type Conflict = {
  id: string;
  memberName: string;
  serviceDate: string; // "YYYY-MM-DD"
  serviceWeekTitle: string | null;
  serviceWeekId: string;
  roleNote: string | null;
  triggerReason: string | null;
};

type ViewState = "loading" | "ready" | "unavailable" | "resolved-success";

type Resolution = "member_reconfirmed" | "admin_dismissed";

export default function ConflictResolution({ conflictId }: { conflictId: string }) {
  const [view, setView] = useState<ViewState>("loading");
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // Which of the two resolve buttons is in flight, so only that one spins.
  const [pending, setPending] = useState<Resolution | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoadFailed(false);
      try {
        const res = await fetch("/api/conflicts");
        const body = await res.json();
        if (cancelled) return;

        if (!res.ok) {
          setView("unavailable");
          return;
        }

        const conflicts: Conflict[] = body.data.conflicts;
        const found = conflicts.find((c) => c.id === conflictId);
        if (!found) {
          setView("unavailable");
          return;
        }

        setConflict(found);
        setView("ready");
      } catch {
        if (!cancelled) {
          setLoadFailed(true);
          setView("unavailable");
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [conflictId, reloadKey]);

  async function resolve(resolution: Resolution) {
    if (submitting) return;
    setSubmitting(true);
    setPending(resolution);
    setActionError(null);

    try {
      const res = await fetch(`/api/conflicts/${conflictId}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolution }),
      });

      if (res.status === 409) {
        setView("unavailable");
        return;
      }

      if (!res.ok) {
        setActionError("Something went wrong. Please try again.");
        return;
      }

      setView("resolved-success");
    } catch {
      setActionError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
      setPending(null);
    }
  }

  const backLink = (
    <ButtonLink href="/conflicts" variant="secondary">
      Back to conflicts
    </ButtonLink>
  );

  if (view === "loading") {
    return (
      <Page width="narrow">
        <LoadingState cards={1} />
      </Page>
    );
  }

  if (view === "unavailable") {
    return (
      <Page width="narrow">
        <NoticeState
          icon="checkCircle"
          tone="info"
          title="This conflict has been resolved or no longer exists."
          actions={
            <>
              {loadFailed ? (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setView("loading");
                    setReloadKey((k) => k + 1);
                  }}
                >
                  <Icon name="refresh" size={18} />
                  Try again
                </Button>
              ) : null}
              {backLink}
            </>
          }
        />
      </Page>
    );
  }

  if (view === "resolved-success") {
    return (
      <Page width="narrow">
        <SuccessState title="Conflict resolved" actions={backLink} />
      </Page>
    );
  }

  // ready
  if (!conflict) return null;

  return (
    <Page width="narrow">
      <ButtonLink href="/conflicts" variant="ghost" size="sm" className={styles.back}>
        <Icon name="chevronLeft" size={18} />
        All conflicts
      </ButtonLink>

      <Card as="section" aria-labelledby="conflict-title">
        <p className={styles.badgeRow}>
          <Badge tone="danger">Scheduling conflict</Badge>
        </p>
        <h1 id="conflict-title">{conflict.serviceWeekTitle ?? "Service"}</h1>
        <p className={styles.date}>
          <Icon name="calendar" size={18} />
          {formatServiceDate(conflict.serviceDate)}
        </p>
        <p className={styles.member}>
          <Avatar name={conflict.memberName} />
          <span>{conflict.memberName}</span>
        </p>
        {conflict.roleNote ? (
          <p className={styles.roleNote}>
            <strong>Original role:</strong> {conflict.roleNote}
          </p>
        ) : null}
        {conflict.triggerReason ? (
          <p className={styles.roleNote}>
            <strong>Reason:</strong> {conflict.triggerReason}
          </p>
        ) : null}
      </Card>

      {actionError ? <ErrorAlert>{actionError}</ErrorAlert> : null}

      {/* Phase 4 (out of scope): AI-suggested replacement renders here */}

      <div className={styles.buttonRow}>
        <ButtonLink
          variant="accent"
          size="lg"
          fullWidth
          href={`/invitations/new?serviceWeekId=${conflict.serviceWeekId}&roleNote=${encodeURIComponent(
            conflict.roleNote ?? "",
          )}`}
        >
          Find a Replacement
        </ButtonLink>
        <div>
          <Button
            variant="primary"
            size="lg"
            fullWidth
            onClick={() => resolve("member_reconfirmed")}
            disabled={submitting}
            loading={pending === "member_reconfirmed"}
            aria-describedby="resolve-hint"
          >
            {submitting ? "Submitting…" : "Mark as Resolved"}
          </Button>
          <p id="resolve-hint" className={styles.hint}>
            The member has confirmed they can still serve.
          </p>
        </div>
        <div>
          <Button
            variant="secondary"
            size="lg"
            fullWidth
            onClick={() => resolve("admin_dismissed")}
            disabled={submitting}
            loading={pending === "admin_dismissed"}
            aria-describedby="dismiss-hint"
          >
            {submitting ? "Submitting…" : "Dismiss"}
          </Button>
          <p id="dismiss-hint" className={styles.hint}>
            Close this conflict without changing the roster.
          </p>
        </div>
      </div>
    </Page>
  );
}
