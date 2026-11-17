"use client";

import { useEffect, useRef } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { TextareaField } from "@/components/ui/Field";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Page } from "@/components/ui/Page";
import { ErrorAlert, LoadingState, NoticeState, SuccessState } from "@/components/ui/States";
import { formatEventType, formatEventWhen, formatServiceDate } from "@/lib/format/dates";
import type { EventType, InvitationStatus } from "@/types/domain";
import styles from "./InvitationView.module.css";

// Shared presentation for the two invitation-response screens: the in-app
// one (app/(app)/invitations/[id]) and the public, token-gated one
// (app/(public)/invite/[token]). Each screen keeps its own data fetching and
// accept/deny calls; this component only renders the state it is handed.

export type InvitationLookup = {
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

export type InvitationViewState =
  | "loading"
  | "ready"
  | "unavailable"
  | "accepted-success"
  | "declined-success";

const EVENT_ICON: Record<EventType, IconName> = {
  pre_practice: "music",
  rehearsal: "music",
  sound_check: "mic",
  service: "calendar",
};

const REASON_MAX = 200;

type InvitationViewProps = {
  view: InvitationViewState;
  invitation: InvitationLookup | null;
  unavailableMessage: string;
  /** Offer "Try again" on the unavailable view (lookup failures only). */
  onRetry?: () => void;
  appLink: string;
  actionError: string | null;
  submitting: boolean;
  showDeclineForm: boolean;
  reason: string;
  onReasonChange: (value: string) => void;
  onAccept: () => void;
  onShowDecline: () => void;
  onCancelDecline: () => void;
  onConfirmDecline: () => void;
};

function formatDeadline(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

export function InvitationView(props: InvitationViewProps) {
  const { view, invitation, submitting, showDeclineForm, reason } = props;
  const declineFormRef = useRef<HTMLDivElement>(null);

  // Move focus into the reason field when the decline form appears, so
  // keyboard and screen-reader users land on the thing that just opened.
  useEffect(() => {
    if (showDeclineForm) declineFormRef.current?.querySelector("textarea")?.focus();
  }, [showDeclineForm]);

  const appLink = (
    <ButtonLink href={props.appLink} variant="secondary">
      Go to the app
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
          title={props.unavailableMessage}
          actions={
            <>
              {props.onRetry ? (
                <Button variant="secondary" onClick={props.onRetry}>
                  <Icon name="refresh" size={18} />
                  Try again
                </Button>
              ) : null}
              {appLink}
            </>
          }
        />
      </Page>
    );
  }

  if (view === "accepted-success" || view === "declined-success") {
    return (
      <Page width="narrow">
        <SuccessState
          title={view === "accepted-success" ? "You're on the schedule" : "Response recorded"}
          actions={appLink}
        >
          {view === "accepted-success"
            ? "Thanks for serving. Your leader has been told you're in."
            : "You've declined this one. Your leader has been told, so they can find someone else."}
        </SuccessState>
      </Page>
    );
  }

  if (!invitation) return null;

  return (
    <Page width="narrow">
      <Card as="section" aria-labelledby="invitation-title">
        <div className={styles.cardTop}>
          <span className={styles.eyebrow}>You&apos;re invited to serve</span>
          <Badge tone="warning">Awaiting your reply</Badge>
        </div>
        <h1 id="invitation-title">{invitation.serviceWeek.title ?? "Service"}</h1>
        <p className={styles.date}>
          <Icon name="calendar" size={18} />
          {formatServiceDate(invitation.serviceWeek.serviceDate)}
        </p>
        {invitation.roleNote ? (
          <p className={styles.roleNote}>
            <strong>Your role:</strong> {invitation.roleNote}
          </p>
        ) : null}

        <div className={styles.events}>
          {invitation.events.length === 0 ? (
            <p className={styles.muted}>Details coming soon</p>
          ) : (
            <ul className={styles.eventList}>
              {invitation.events.map((event) => (
                <li key={event.id} className={styles.eventRow}>
                  <span className={styles.eventIcon}>
                    <Icon name={EVENT_ICON[event.type] ?? "calendar"} size={18} />
                  </span>
                  <div className={styles.eventBody}>
                    <p className={styles.eventName}>{event.name}</p>
                    <p className={styles.eventMeta}>
                      <span className="sr-only">{formatEventType(event.type)}, </span>
                      {formatEventWhen(event.startTime, event.endTime)}
                    </p>
                    {event.location ? (
                      <p className={styles.eventMeta}>
                        <Icon name="mapPin" size={14} />
                        {event.location}
                      </p>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {invitation.responseDeadline ? (
          <p className={styles.deadline}>
            <Icon name="clock" size={16} />
            Please reply by {formatDeadline(invitation.responseDeadline)}
          </p>
        ) : null}
      </Card>

      {props.actionError ? <ErrorAlert>{props.actionError}</ErrorAlert> : null}

      {!showDeclineForm ? (
        <div className={styles.buttonRow}>
          <Button
            variant="accent"
            size="lg"
            fullWidth
            onClick={props.onAccept}
            disabled={submitting}
            loading={submitting}
          >
            {submitting ? "Accepting…" : "Accept"}
          </Button>
          <Button
            variant="secondary"
            size="lg"
            fullWidth
            onClick={props.onShowDecline}
            disabled={submitting}
          >
            Decline
          </Button>
        </div>
      ) : (
        <div className={styles.declineForm} ref={declineFormRef}>
          <TextareaField
            id="decline-reason"
            label="Reason"
            optional
            hint={`Only your leader sees this. ${reason.length}/${REASON_MAX}`}
            maxLength={REASON_MAX}
            value={reason}
            onChange={(e) => props.onReasonChange(e.target.value)}
            disabled={submitting}
          />
          <div className={styles.buttonRow}>
            <Button
              variant="primary"
              size="lg"
              fullWidth
              onClick={props.onConfirmDecline}
              disabled={submitting}
              loading={submitting}
            >
              {submitting ? "Submitting…" : "Confirm decline"}
            </Button>
            <Button
              variant="ghost"
              size="lg"
              fullWidth
              onClick={props.onCancelDecline}
              disabled={submitting}
            >
              Keep it
            </Button>
          </div>
        </div>
      )}
    </Page>
  );
}
