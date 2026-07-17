"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/Badge";
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

// Matches formatServiceDate in week-view.tsx exactly (local-time
// interpretation of the YYYY-MM-DD string).
function formatServiceDate(dateStr: string): string {
  const date = new Date(`${dateStr}T00:00:00`);
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "";
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase();
}

function formatEventTime(startTime: string, endTime: string): string {
  const start = new Date(startTime).toLocaleString();
  const end = new Date(endTime).toLocaleString();
  return `${start} – ${end}`;
}

function confirmationBadge(status: InvitationStatus | null): {
  label: string;
  tone: "neutral" | "success" | "warning" | "danger";
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
  }, [serviceWeekId]);

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
        <h1>You don&apos;t have access to this week</h1>
        <p>This screen is available to members of this church group only.</p>
      </main>
    );
  }

  if (view === "not-found") {
    return (
      <main className={styles.container}>
        <h1>Service week not found</h1>
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
  if (!data) return null;

  const { serviceWeek, confirmationStatus, setlist, events, team, documents } = data;
  const badge = confirmationBadge(confirmationStatus);
  const assignedEvents = events.filter((e) => e.assigned);
  const selectedEvent = selectedEventId
    ? (events.find((e) => e.id === selectedEventId) ?? null)
    : null;

  return (
    <main className={styles.container}>
      <header className={styles.header}>
        <h1>{serviceWeek.title ?? "Untitled service"}</h1>
        <p className={styles.date}>{formatServiceDate(serviceWeek.serviceDate)}</p>
        <div className={styles.badges}>
          <Badge tone={badge.tone}>{badge.label}</Badge>
          {serviceWeek.isCancelled ? <Badge tone="danger">Cancelled</Badge> : null}
        </div>
      </header>

      <section className={styles.card}>
        <h2>Setlist</h2>
        {setlist === null ? (
          <p>Setlist not yet released</p>
        ) : setlist.songs.length === 0 ? (
          <p>No songs added yet</p>
        ) : (
          <ol className={styles.songList}>
            {setlist.songs.map((song) => (
              <li key={song.songId}>
                <span className={styles.songTitle}>
                  {song.title}
                  {song.artist ? ` — ${song.artist}` : ""}
                </span>
                <span className={styles.songKey}>{song.effectiveKey ?? "—"}</span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className={styles.card}>
        <h2>Events</h2>
        {assignedEvents.length === 0 ? (
          <p>You&apos;re not assigned to any events this week</p>
        ) : (
          <ul className={styles.eventList}>
            {assignedEvents.map((event) => (
              <li key={event.id}>
                <button
                  type="button"
                  className={styles.eventRow}
                  onClick={() => setSelectedEventId(event.id)}
                >
                  <span className={styles.eventName}>{event.name}</span>
                  <span className={styles.eventTime}>
                    {new Date(event.startTime).toLocaleString()}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={styles.card}>
        <h2>Team</h2>
        {team.length === 0 ? (
          <p>No confirmed team yet</p>
        ) : (
          <ul className={styles.teamList}>
            {team.map((member) => (
              <li key={member.userId} className={styles.teamMember}>
                <span className={styles.avatar} aria-hidden="true">
                  {getInitials(member.name)}
                </span>
                <span className={styles.memberName}>{member.name}</span>
                <span className={styles.memberInstruments}>
                  {member.instruments.length > 0
                    ? member.instruments.map((i) => i.name).join(", ")
                    : "—"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={styles.card}>
        <h2>Documents</h2>
        {documents.length === 0 ? (
          <p>No documents for this week&apos;s songs</p>
        ) : (
          documents.map((group) => (
            <div key={group.songId} className={styles.documentGroup}>
              <h3>{group.songTitle}</h3>
              <ul className={styles.fileList}>
                {group.files.map((file) => (
                  <li key={file.id}>
                    <a href={file.downloadUrl} target="_blank" rel="noopener noreferrer">
                      {file.name}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </section>

      {selectedEvent ? (
        <div className={styles.detailOverlay}>
          <div className={styles.detail} role="dialog" aria-label={selectedEvent.name}>
            <button
              type="button"
              className={styles.detailClose}
              aria-label="Close"
              onClick={() => setSelectedEventId(null)}
            >
              ×
            </button>
            <h2>{selectedEvent.name}</h2>
            <p className={styles.detailType}>{selectedEvent.type}</p>
            <p>{formatEventTime(selectedEvent.startTime, selectedEvent.endTime)}</p>
            {selectedEvent.notes ? <p>{selectedEvent.notes}</p> : null}
            {selectedEvent.location ? (
              <a
                href={mapsUrl(selectedEvent.location)}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open in Maps
              </a>
            ) : null}
          </div>
        </div>
      ) : null}

      <button
        type="button"
        className={styles.chatButton}
        aria-label="Week chat (coming soon)"
        disabled
      >
        💬
      </button>
    </main>
  );
}
