"use client";

import { useEffect, useState } from "react";
import {
  InvitationView,
  type InvitationLookup,
  type InvitationViewState,
} from "@/components/invitations/InvitationView";
import type { InvitationStatus } from "@/types/domain";

// Data shape returned by GET /api/invitations/respond/:token, wrapped in
// { data } (types/api.ts). Mirrors PublicInvitationLookup
// (app/api/invitations/handler.ts).
type Lookup = InvitationLookup;

type ViewState = InvitationViewState;

// Terminal statuses the lookup/accept/deny calls can report, keyed to a
// friendly message — never surfaced as a raw error/code/status (#51).
type UnavailableReason =
  | "expired"
  | "accepted"
  | "denied"
  | "withdrawn"
  | "not-found"
  | "rate-limited";

const UNAVAILABLE_MESSAGES: Record<UnavailableReason, string> = {
  expired: "This invitation has expired.",
  accepted: "You've already responded to this invitation.",
  denied: "You've already responded to this invitation.",
  withdrawn: "This invitation was withdrawn.",
  "not-found": "We couldn't find this invitation.",
  "rate-limited": "Too many attempts. Please try again in a moment.",
};

// A 429's Retry-After header is a whole number of seconds; anything else
// (missing, non-numeric, negative) falls back to the generic message above.
function rateLimitedMessage(retryAfterHeader: string | null): string {
  const seconds = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : NaN;
  if (Number.isFinite(seconds) && seconds > 0) {
    return `Too many attempts. Please try again in ${seconds}s.`;
  }
  return UNAVAILABLE_MESSAGES["rate-limited"];
}

function isUnavailableReason(status: InvitationStatus): status is Exclude<InvitationStatus, "pending"> {
  return status !== "pending";
}

export default function InviteResponse({ token }: { token: string }) {
  const [view, setView] = useState<ViewState>("loading");
  const [unavailableReason, setUnavailableReason] = useState<UnavailableReason>("not-found");
  // Overrides UNAVAILABLE_MESSAGES[unavailableReason] when the message needs
  // a value only known at request time (the Retry-After seconds on a 429).
  const [unavailableMessageOverride, setUnavailableMessageOverride] = useState<string | null>(
    null,
  );
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
        const res = await fetch(`/api/invitations/respond/${token}`);
        if (res.status === 429) {
          if (cancelled) return;
          setUnavailableMessageOverride(rateLimitedMessage(res.headers.get("Retry-After")));
          setUnavailableReason("rate-limited");
          setView("unavailable");
          return;
        }

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
  }, [token, reloadKey]);

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

      if (res.status === 429) {
        setActionError(rateLimitedMessage(res.headers.get("Retry-After")));
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

      if (res.status === 429) {
        setActionError(rateLimitedMessage(res.headers.get("Retry-After")));
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

  // /dashboard is admin/set_leader-only; most invitees are members, so send
  // them to their own week view instead once we know which week that is.
  const appLink = serviceWeekId ? `/member-week/${serviceWeekId}` : "/dashboard";

  return (
    <InvitationView
      view={view}
      invitation={invitation}
      unavailableMessage={unavailableMessageOverride ?? UNAVAILABLE_MESSAGES[unavailableReason]}
      onRetry={
        lookupFailed || unavailableReason === "rate-limited"
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
