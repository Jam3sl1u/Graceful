"use client";

import { useEffect, useState } from "react";
import { Avatar } from "@/components/ui/Avatar";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Icon } from "@/components/ui/Icon";
import { Modal } from "@/components/ui/Modal";
import { Page, PageHeader } from "@/components/ui/Page";
import { EmptyState, ErrorState, LoadingState, NoAccessState, NoticeState } from "@/components/ui/States";
import {
  formatEventType,
  formatEventWhen,
  formatFileSize,
  formatServiceDate,
} from "@/lib/format/dates";
import type { EventType, InvitationStatus, VocalCapability } from "@/types/domain";
import styles from "./member-week-view.module.css";

// Data shapes mirror the `{ data }`-wrapped response body of
// GET /api/service-weeks/:id/member-view (types/api.ts envelope). Kept
// local/minimal rather than importing server-only handler types into a
// client component (mirrors week-view.tsx's convention).
type ServiceWeekSummary = {
  id: string;
  serviceDate: string;
  title: string | null;
  isCancelled: boolean;
};

type MemberWeekEvent = {
  id: string;
  type: EventType;
  name: string;
  location: string | null;
  startTime: string;
  endTime: string;
  notes: string | null;
  assigned: boolean;
};

type MemberWeekSong = {
  songId: string;
  title: string;
  artist: string | null;
  position: number;
  effectiveKey: string | null;
};

type MemberWeekTeamMember = {
  userId: string;
  name: string;
  vocalCapability: VocalCapability;
  instruments: { id: string; name: string }[];
};

type MemberWeekDocumentGroup = {
  songId: string;
  songTitle: string;
  files: {
    id: string;
    name: string;
    fileType: string;
    fileSizeBytes: number;
    downloadUrl: string;
  }[];
};

type MemberWeekViewData = {
  serviceWeek: ServiceWeekSummary;
  confirmationStatus: InvitationStatus | null;
  setlist: { status: "published"; songs: MemberWeekSong[] } | null;
  events: MemberWeekEvent[];
  team: MemberWeekTeamMember[];
  documents: MemberWeekDocumentGroup[];
};

type ViewState = "loading" | "ready" | "forbidden" | "not-found" | "error";

const VOCAL_LABELS: Record<VocalCapability, string | null> = {
  lead: "Lead vocals",
  harmony: "Harmony vocals",
  both: "Lead & harmony vocals",
  none: null,
};

function confirmationBadge(status: InvitationStatus | null): {
  label: string;
  tone: BadgeTone;
} {
  switch (status) {
    case "accepted":
      return { label: "Confirmed", tone: "success" };
    case "pending":
      return { label: "Pending", tone: "warning" };
    case "denied":
      return { label: "Declined", tone: "neutral" };
    case "withdrawn":
    case "expired":
      return { label: "Not serving", tone: "neutral" };
    default:
      return { label: "Not invited", tone: "neutral" };
  }
}

function mapsUrl(location: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(location)}`;
}

export default function MemberWeekView({ serviceWeekId }: { serviceWeekId: string }) {
  const [view, setView] = useState<ViewState>("loading");
  const [data, setData] = useState<MemberWeekViewData | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch(`/api/service-weeks/${serviceWeekId}/member-view`);
        if (cancelled) return;

        if (res.status === 404) {
          setView("not-found");
          return;
        }
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

        setData(body.data);
        setView("ready");
      } catch {
        if (!cancelled) setView("error");
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [serviceWeekId, reloadKey]);

  function retry() {
    setView("loading");
    setReloadKey((k) => k + 1);
  }

  const inboxLink = (
    <ButtonLink href="/notifications" variant="secondary">
      Go to notifications
    </ButtonLink>
  );

  if (view === "loading") {
    return (
      <Page>
        <LoadingState cards={3} />
      </Page>
    );
  }

  if (view === "forbidden") {
    return (
      <Page>
        <NoAccessState title="You don't have access to this week" actions={inboxLink}>
          This week belongs to a church group you&apos;re not a member of.
        </NoAccessState>
      </Page>
    );
  }

  if (view === "not-found") {
    return (
      <Page>
        <NoticeState icon="calendar" tone="info" title="Service week not found" actions={inboxLink}>
          It may have been removed, or the link may be incomplete.
        </NoticeState>
      </Page>
    );
  }

  if (view === "error") {
    return (
      <Page>
        <ErrorState onRetry={retry} />
      </Page>
    );
  }

  // ready
  if (!data) return null;

  const { serviceWeek, confirmationStatus, setlist, events, team, documents } = data;
  const badge = confirmationBadge(confirmationStatus);
  const assignedEvents = events.filter((e) => e.assigned);
  const selectedEvent = selectedEventId
    ? (events.find((e) => e.id === selectedEventId) ?? null)
    : null;

  return (
    <Page>
      <PageHeader
        eyebrow="Your week"
        title={serviceWeek.title ?? "Untitled service"}
        subtitle={formatServiceDate(serviceWeek.serviceDate)}
      >
        <Badge tone={badge.tone}>{badge.label}</Badge>
        {serviceWeek.isCancelled ? <Badge tone="danger">Cancelled</Badge> : null}
      </PageHeader>

      <Card as="section" aria-labelledby="mw-setlist">
        <h2 id="mw-setlist" className={styles.cardTitle}>
          Setlist
        </h2>
        {setlist === null ? (
          <EmptyState icon="music" title="Setlist not yet released">
            You&apos;ll get a notification as soon as it&apos;s published.
          </EmptyState>
        ) : setlist.songs.length === 0 ? (
          <EmptyState icon="music" title="No songs added yet" />
        ) : (
          <ol className={styles.songList}>
            {setlist.songs.map((song, index) => (
              <li key={song.songId} className={styles.songRow}>
                <span className={styles.songNumber} aria-hidden="true">
                  {index + 1}
                </span>
                <span className={styles.songText}>
                  <span className={styles.songTitle}>{song.title}</span>
                  {song.artist ? <span className={styles.muted}>{song.artist}</span> : null}
                </span>
                <span className={styles.songKey}>
                  <span className="sr-only">Key: </span>
                  <span>{song.effectiveKey ?? "—"}</span>
                </span>
              </li>
            ))}
          </ol>
        )}
      </Card>

      <Card as="section" aria-labelledby="mw-events">
        <h2 id="mw-events" className={styles.cardTitle}>
          Events
        </h2>
        {assignedEvents.length === 0 ? (
          <EmptyState icon="calendar" title="You're not assigned to any events this week" />
        ) : (
          <ul className={styles.eventList}>
            {assignedEvents.map((event) => (
              <li key={event.id}>
                <button
                  type="button"
                  className={styles.eventRow}
                  onClick={() => setSelectedEventId(event.id)}
                >
                  <span className={styles.eventText}>
                    <span className={styles.eventName}>{event.name}</span>
                    <span className={styles.muted}>
                      {formatEventWhen(event.startTime, event.endTime)}
                    </span>
                  </span>
                  <Icon name="chevronRight" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card as="section" aria-labelledby="mw-team">
        <h2 id="mw-team" className={styles.cardTitle}>
          Team
        </h2>
        {team.length === 0 ? (
          <EmptyState icon="users" title="No confirmed team yet">
            Teammates appear here as they accept.
          </EmptyState>
        ) : (
          <ul className={styles.teamList}>
            {team.map((member) => {
              const vocals = VOCAL_LABELS[member.vocalCapability] ?? null;
              return (
                <li key={member.userId} className={styles.teamMember}>
                  <Avatar name={member.name} />
                  <span className={styles.memberText}>
                    <span className={styles.memberName}>{member.name}</span>
                    {vocals ? <span className={styles.muted}>{vocals}</span> : null}
                  </span>
                  <span className={styles.memberInstruments}>
                    {member.instruments.length > 0
                      ? member.instruments.map((i) => i.name).join(", ")
                      : "—"}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card as="section" aria-labelledby="mw-documents">
        <h2 id="mw-documents" className={styles.cardTitle}>
          Documents
        </h2>
        {documents.length === 0 ? (
          <EmptyState icon="file" title="No documents for this week's songs" />
        ) : (
          documents.map((group) => (
            <div key={group.songId} className={styles.documentGroup}>
              <h3>{group.songTitle}</h3>
              <ul className={styles.fileList}>
                {group.files.map((file) => (
                  <li key={file.id}>
                    <a
                      href={file.downloadUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={styles.fileLink}
                    >
                      <Icon name="file" size={18} />
                      <span className={styles.fileName}>{file.name}</span>
                      <span className={styles.fileMeta}>
                        {formatFileSize(file.fileSizeBytes)}
                        <span className="sr-only"> (opens in a new tab)</span>
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </Card>

      <Button
        variant="secondary"
        className={styles.chatButton}
        aria-label="Week chat (coming soon)"
        disabled
      >
        <Icon name="chat" size={18} />
        <span aria-hidden="true">Week chat</span>
        <Badge>Coming soon</Badge>
      </Button>

      <Modal
        open={selectedEvent !== null}
        onClose={() => setSelectedEventId(null)}
        title={selectedEvent?.name}
      >
        {selectedEvent ? (
          <div className={styles.detail}>
            <p>
              <Badge tone="info">{formatEventType(selectedEvent.type)}</Badge>
            </p>
            <p className={styles.detailRow}>
              <Icon name="clock" size={18} />
              {formatEventWhen(selectedEvent.startTime, selectedEvent.endTime)}
            </p>
            {selectedEvent.location ? (
              <p className={styles.detailRow}>
                <Icon name="mapPin" size={18} />
                {selectedEvent.location}
              </p>
            ) : null}
            {selectedEvent.notes ? <p className={styles.notes}>{selectedEvent.notes}</p> : null}
            {selectedEvent.location ? (
              <ButtonLink
                href={mapsUrl(selectedEvent.location)}
                target="_blank"
                rel="noopener noreferrer"
                variant="secondary"
                fullWidth
              >
                <Icon name="external" size={18} />
                Open in Maps
                <span className="sr-only"> (opens in a new tab)</span>
              </ButtonLink>
            ) : null}
          </div>
        ) : null}
      </Modal>
    </Page>
  );
}
