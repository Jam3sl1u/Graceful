"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
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

function formatServiceDate(dateStr: string): string {
  const date = new Date(`${dateStr}T00:00:00`);
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export default function ConflictResolution({ conflictId }: { conflictId: string }) {
  const [view, setView] = useState<ViewState>("loading");
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
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
          setView("unavailable");
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [conflictId]);

  async function resolve(resolution: Resolution) {
    if (submitting) return;
    setSubmitting(true);
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
    }
  }

  if (view === "loading") {
    return (
      <main className={styles.container}>
        <p>Loading…</p>
      </main>
    );
  }

  if (view === "unavailable") {
    return (
      <main className={styles.container}>
        <h1>This conflict has been resolved or no longer exists.</h1>
        <Link className={styles.appLink} href="/conflicts">
          Back to conflicts
        </Link>
      </main>
    );
  }

  if (view === "resolved-success") {
    return (
      <main className={styles.container}>
        <p className={styles.checkmark} aria-hidden="true">
          ✓
        </p>
        <h1>Conflict resolved</h1>
        <Link className={styles.appLink} href="/conflicts">
          Back to conflicts
        </Link>
      </main>
    );
  }

  // ready
  if (!conflict) return null;

  return (
    <main className={styles.container}>
      <div className={styles.card}>
        <h1>{conflict.serviceWeekTitle ?? "Service"}</h1>
        <p className={styles.date}>{formatServiceDate(conflict.serviceDate)}</p>
        <p>{conflict.memberName}</p>
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
      </div>

      {actionError ? (
        <p role="alert" className={styles.error}>
          {actionError}
        </p>
      ) : null}

      {/* Phase 4 (out of scope): AI-suggested replacement renders here */}

      <div className={styles.buttonRow}>
        <a
          className={styles.replacementLink}
          href={`/invitations/new?serviceWeekId=${conflict.serviceWeekId}&roleNote=${encodeURIComponent(
            conflict.roleNote ?? "",
          )}`}
        >
          Find a Replacement
        </a>
        <Button
          variant="primary"
          onClick={() => resolve("member_reconfirmed")}
          disabled={submitting}
        >
          {submitting ? "Submitting…" : "Mark as Resolved"}
        </Button>
        <Button
          variant="secondary"
          onClick={() => resolve("admin_dismissed")}
          disabled={submitting}
        >
          {submitting ? "Submitting…" : "Dismiss"}
        </Button>
      </div>
    </main>
  );
}
