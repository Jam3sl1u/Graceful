"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import type { EventType, InvitationStatus } from "@/types/domain";
import styles from "./invite-response.module.css";

// Data shape returned by GET /api/invitations/respond/:token, wrapped in
// { data } (types/api.ts). Mirrors PublicInvitationLookup
// (app/api/invitations/handler.ts).
type Lookup = {
  invitationId: string;
  status: InvitationStatus;
  roleNote: string | null;
  responseDeadline: string | null;
  serviceWeek: { id: string; serviceDate: string; title: string | null };
  events: Array<{
    id: string;
    type: EventType;
    name: string;
    location: string | null;
    startTime: string;
    endTime: string;
  }>;
};

type ViewState = "loading" | "ready" | "unavailable" | "accepted-success" | "declined-success";

// Terminal statuses the lookup/accept/deny calls can report, keyed to a
// friendly message — never surfaced as a raw error/code/status (#51).
type UnavailableReason = "expired" | "accepted" | "denied" | "withdrawn" | "not-found";

const UNAVAILABLE_MESSAGES: Record<UnavailableReason, string> = {
  expired: "This invitation has expired.",
  accepted: "You've already responded to this invitation.",
  denied: "You've already responded to this invitation.",
  withdrawn: "This invitation was withdrawn.",
  "not-found": "We couldn't find this invitation.",
};

function isUnavailableReason(status: InvitationStatus): status is Exclude<InvitationStatus, "pending"> {
  return status !== "pending";
}

function formatServiceDate(dateStr: string): string {
  const date = new Date(`${dateStr}T00:00:00`);
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function formatTimeRange(startTime: string, endTime: string): string {
  const timeOpts: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
  const start = new Date(startTime).toLocaleTimeString(undefined, timeOpts);
  const end = new Date(endTime).toLocaleTimeString(undefined, timeOpts);
  return `${start}–${end}`;
}

export default function InviteResponse({ token }: { token: string }) {
  const [view, setView] = useState<ViewState>("loading");
  const [unavailableReason, setUnavailableReason] = useState<UnavailableReason>("not-found");
  const [invitation, setInvitation] = useState<Lookup | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showDeclineForm, setShowDeclineForm] = useState(false);
  const [reason, setReason] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch(`/api/invitations/respond/${token}`);
        const body = await res.json();
        if (cancelled) return;

        if (!res.ok) {
          setUnavailableReason("not-found");
          setView("unavailable");
          return;
        }

        const data: Lookup = body.data;
        if (isUnavailableReason(data.status)) {
          setUnavailableReason(data.status);
          setView("unavailable");
          return;
        }

        setInvitation(data);
        setView("ready");
      } catch {
        if (!cancelled) {
          setUnavailableReason("not-found");
          setView("unavailable");
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function handleAccept() {
    if (!invitation || submitting) return;
    setSubmitting(true);
    setActionError(null);

    try {
      const res = await fetch(`/api/invitations/${invitation.invitationId}/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ responseToken: token }),
      });

      if (res.status === 410 || res.status === 404) {
        setUnavailableReason("expired");
        setView("unavailable");
        return;
      }

      if (!res.ok) {
        setActionError("Something went wrong. Please try again.");
        return;
      }

      const body = await res.json();
      const data: { status: InvitationStatus; alreadyResponded: boolean } = body.data;

      if (data.alreadyResponded && data.status !== "accepted") {
        setUnavailableReason(isUnavailableReason(data.status) ? data.status : "not-found");
        setView("unavailable");
        return;
      }

      if (data.status === "accepted") {
        setView("accepted-success");
      }
    } catch {
      setActionError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDeclineConfirm() {
    if (!invitation || submitting) return;
    setSubmitting(true);
    setActionError(null);

    try {
      const res = await fetch(`/api/invitations/${invitation.invitationId}/deny`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ responseToken: token, reason }),
      });

      if (res.status === 410 || res.status === 404) {
        setUnavailableReason("expired");
        setView("unavailable");
        return;
      }

      if (!res.ok) {
        setActionError("Something went wrong. Please try again.");
        return;
      }

      const body = await res.json();
      const data: { status: InvitationStatus; alreadyResponded: boolean } = body.data;

      if (data.alreadyResponded && data.status !== "denied") {
        setUnavailableReason(isUnavailableReason(data.status) ? data.status : "not-found");
        setView("unavailable");
        return;
      }

      setView("declined-success");
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
        <h1>{UNAVAILABLE_MESSAGES[unavailableReason]}</h1>
        <a className={styles.appLink} href="/dashboard">
          Go to the app
        </a>
      </main>
    );
  }

  if (view === "accepted-success" || view === "declined-success") {
    return (
      <main className={styles.container}>
        <p className={styles.checkmark} aria-hidden="true">
          ✓
        </p>
        <h1>{view === "accepted-success" ? "You're on the schedule" : "Response recorded"}</h1>
        <a className={styles.appLink} href="/dashboard">
          Go to the app
        </a>
      </main>
    );
  }

  // ready
  if (!invitation) return null;

  return (
    <main className={styles.container}>
      <div className={styles.card}>
        <h1>{invitation.serviceWeek.title ?? "Service"}</h1>
        <p className={styles.date}>{formatServiceDate(invitation.serviceWeek.serviceDate)}</p>
        {invitation.roleNote ? (
          <p className={styles.roleNote}>
            <strong>Your role:</strong> {invitation.roleNote}
          </p>
        ) : null}

        <div className={styles.events}>
          {invitation.events.length === 0 ? (
            <p>Details coming soon</p>
          ) : (
            invitation.events.map((event) => (
              <div key={event.id} className={styles.eventRow}>
                <p className={styles.eventName}>{event.name}</p>
                <p className={styles.eventTime}>{formatTimeRange(event.startTime, event.endTime)}</p>
                {event.location ? <p className={styles.eventLocation}>{event.location}</p> : null}
              </div>
            ))
          )}
        </div>
      </div>

      {actionError ? (
        <p role="alert" className={styles.error}>
          {actionError}
        </p>
      ) : null}

      {!showDeclineForm ? (
        <div className={styles.buttonRow}>
          <Button
            variant="primary"
            className={styles.acceptButton}
            onClick={handleAccept}
            disabled={submitting}
          >
            {submitting ? "Accepting…" : "Accept"}
          </Button>
          <Button variant="secondary" onClick={() => setShowDeclineForm(true)} disabled={submitting}>
            Decline
          </Button>
        </div>
      ) : (
        <div className={styles.declineForm}>
          <label htmlFor="decline-reason">Reason (optional)</label>
          <textarea
            id="decline-reason"
            maxLength={200}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={submitting}
          />
          <div className={styles.buttonRow}>
            <Button variant="primary" onClick={handleDeclineConfirm} disabled={submitting}>
              {submitting ? "Submitting…" : "Confirm decline"}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setShowDeclineForm(false);
                setReason("");
              }}
              disabled={submitting}
            >
              Keep it
            </Button>
          </div>
        </div>
      )}
    </main>
  );
}
