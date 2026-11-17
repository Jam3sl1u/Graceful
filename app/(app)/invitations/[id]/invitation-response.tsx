"use client";

import { useEffect, useState } from "react";
import {
  InvitationView,
  type InvitationLookup,
  type InvitationViewState,
} from "@/components/invitations/InvitationView";
import type { InvitationStatus } from "@/types/domain";
import { notifyUnreadChanged } from "@/components/layout/NotificationBell";

// Data shape returned by GET /api/invitations/:id, wrapped in { data }
// (types/api.ts). Mirrors PublicInvitationLookup (app/api/invitations/
// handler.ts) — the same contract the public, token-gated
// app/(public)/invite/[token]/invite-response.tsx uses.
type Lookup = InvitationLookup;

type ViewState = InvitationViewState;

// Terminal statuses the lookup/accept/deny calls can report, keyed to a
// friendly message — never surfaced as a raw error/code/status (mirrors
// invite-response.tsx's #51 precedent).
type UnavailableReason =
  | "expired"
  | "accepted"
  | "denied"
  | "withdrawn"
  | "not-found";

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

type InvitationActionResult = {
  status: InvitationStatus;
  alreadyResponded: boolean;
};

function isInvitationActionResult(value: unknown): value is InvitationActionResult {
  if (typeof value !== "object" || value === null) return false;
  const data = value as Record<string, unknown>;
  return (
    typeof data.alreadyResponded === "boolean" &&
    (data.status === "pending" ||
      data.status === "accepted" ||
      data.status === "denied" ||
      data.status === "withdrawn" ||
      data.status === "expired")
  );
}

export default function InvitationResponse({ invitationId }: { invitationId: string }) {
  const [view, setView] = useState<ViewState>("loading");
  const [unavailableReason, setUnavailableReason] = useState<UnavailableReason>("not-found");
  const [invitation, setInvitation] = useState<Lookup | null>(null);
  const [serviceWeekId, setServiceWeekId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showDeclineForm, setShowDeclineForm] = useState(false);
  const [reason, setReason] = useState("");
  // Bumped by "Try again" to re-run the lookup effect.
  const [reloadKey, setReloadKey] = useState(0);
  const [lookupFailed, setLookupFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLookupFailed(false);
      try {
        const res = await fetch(`/api/invitations/${invitationId}`);
        const body = await res.json();
        if (cancelled) return;

        if (!res.ok) {
          setUnavailableReason("not-found");
          setView("unavailable");
          return;
        }

        const data: Lookup = body.data;
        setServiceWeekId(data.serviceWeek.id);
        if (isUnavailableReason(data.status)) {
          setUnavailableReason(data.status);
          setView("unavailable");
          return;
        }

        setInvitation(data);
        setView("ready");
      } catch {
        if (!cancelled) {
          setLookupFailed(true);
          setUnavailableReason("not-found");
          setView("unavailable");
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [invitationId, reloadKey]);

  async function handleAccept() {
    if (!invitation || submitting) return;
    setSubmitting(true);
    setActionError(null);

    try {
      const res = await fetch(`/api/invitations/${invitation.invitationId}/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      if (res.status === 410) {
        setUnavailableReason("expired");
        setView("unavailable");
        return;
      }

      if (res.status === 404) {
        setUnavailableReason("not-found");
        setView("unavailable");
        return;
      }

      if (!res.ok) {
        setActionError("Something went wrong. Please try again.");
        return;
      }

      const body = await res.json();
      const data = body.data;

      if (!isInvitationActionResult(data)) {
        setActionError("Something went wrong. Please try again.");
        return;
      }

      if (data.alreadyResponded && data.status !== "accepted") {
        setUnavailableReason(isUnavailableReason(data.status) ? data.status : "not-found");
        setView("unavailable");
        return;
      }

      if (data.status === "accepted") {
        notifyUnreadChanged();
        setView("accepted-success");
        return;
      }

      setActionError("Something went wrong. Please try again.");
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
        body: JSON.stringify({ reason }),
      });

      if (res.status === 410) {
        setUnavailableReason("expired");
        setView("unavailable");
        return;
      }

      if (res.status === 404) {
        setUnavailableReason("not-found");
        setView("unavailable");
        return;
      }

      if (!res.ok) {
        setActionError("Something went wrong. Please try again.");
        return;
      }

      const body = await res.json();
      const data = body.data;

      if (!isInvitationActionResult(data)) {
        setActionError("Something went wrong. Please try again.");
        return;
      }

      if (data.alreadyResponded && data.status !== "denied") {
        setUnavailableReason(isUnavailableReason(data.status) ? data.status : "not-found");
        setView("unavailable");
        return;
      }

      if (data.status === "denied") {
        notifyUnreadChanged();
        setView("declined-success");
        return;
      }

      setActionError("Something went wrong. Please try again.");
    } catch {
      setActionError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  const appLink = serviceWeekId ? `/member-week/${serviceWeekId}` : "/notifications";

  return (
    <InvitationView
      view={view}
      invitation={invitation}
      unavailableMessage={UNAVAILABLE_MESSAGES[unavailableReason]}
      onRetry={
        lookupFailed
          ? () => {
              setView("loading");
              setReloadKey((k) => k + 1);
            }
          : undefined
      }
      appLink={appLink}
      actionError={actionError}
      submitting={submitting}
      showDeclineForm={showDeclineForm}
      reason={reason}
      onReasonChange={setReason}
      onAccept={handleAccept}
      onShowDecline={() => setShowDeclineForm(true)}
      onCancelDecline={() => {
        setShowDeclineForm(false);
        setReason("");
      }}
      onConfirmDecline={handleDeclineConfirm}
    />
  );
}
