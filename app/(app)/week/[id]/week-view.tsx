"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import type { InvitationStatus } from "@/types/domain";
import styles from "./week-view.module.css";

// Data shapes mirror the `{ data }`-wrapped response bodies of the endpoints
// this screen reads (types/api.ts envelope). Kept local/minimal (only the
// fields this screen actually uses) rather than importing server-only
// handler types into a client component.
type ServiceWeekSummary = {
  id: string;
  serviceDate: string;
  title: string | null;
  isCancelled: boolean;
};

type DirectoryMember = {
  id: string;
  name: string;
};

type WeekInvitation = {
  id: string;
  serviceWeekId: string;
  userId: string;
  roleNote: string | null;
  status: InvitationStatus;
  responseDeadline: string | null;
  createdAt: string;
};

type OpenConflict = {
  id: string;
  invitationId: string;
  memberId: string;
  serviceWeekId: string;
};

type TeamAvailabilityEntry = {
  date: string;
  isAvailable: boolean;
  note: string | null;
};

type TeamAvailabilityMember = {
  userId: string;
  entries: TeamAvailabilityEntry[];
};

type ViewState = "loading" | "ready" | "forbidden" | "not-found" | "error";

type RosterStatus = {
  label: string;
  tone: "neutral" | "success" | "warning" | "danger";
  showInvite: boolean;
};

// Matches formatServiceDate in invite-response.tsx exactly (local-time
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

// Short label for an availability-grid column header, e.g. "Mon 7/13".
function formatShortDate(dateStr: string): string {
  const date = new Date(`${dateStr}T00:00:00Z`);
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "numeric",
    day: "numeric",
    timeZone: "UTC",
  });
}

// UTC date math (matches schemas/availability.ts's convention) to avoid
// local-timezone off-by-one on the range bounds.
function addDaysUTC(dateStr: string, days: number): string {
  return new Date(new Date(`${dateStr}T00:00:00Z`).getTime() + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

// The 7-day lead-up window: serviceDate - 6 days .. serviceDate, inclusive.
function getAvailabilityWindow(serviceDate: string): string[] {
  const dates: string[] = [];
  for (let n = -6; n <= 0; n++) {
    dates.push(addDaysUTC(serviceDate, n));
  }
  return dates;
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "";
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase();
}

// Picks the "current" invitation for a member: the WeekInvitation with the
// max createdAt, so a stale denied/withdrawn row from an earlier re-invite
// never masks an active pending/accepted one.
function getCurrentInvitation(
  memberId: string,
  invitations: WeekInvitation[],
): WeekInvitation | undefined {
  const mine = invitations.filter((i) => i.userId === memberId);
  if (mine.length === 0) return undefined;
  return mine.reduce((latest, i) => (i.createdAt > latest.createdAt ? i : latest));
}

// Roster status mapping (checked in this order): conflict overrides accepted;
// no invitation (or only withdrawn/expired) reads as Open.
function getRosterStatus(
  memberId: string,
  invitations: WeekInvitation[],
  conflictInvitationIds: Set<string>,
): RosterStatus {
  const current = getCurrentInvitation(memberId, invitations);

  if (current && conflictInvitationIds.has(current.id)) {
    return { label: "Conflict", tone: "danger", showInvite: false };
  }
  if (current?.status === "accepted") {
    return { label: "Confirmed", tone: "success", showInvite: false };
  }
  if (current?.status === "pending") {
    return { label: "Pending", tone: "warning", showInvite: false };
  }
  if (current?.status === "denied") {
    return { label: "Declined", tone: "neutral", showInvite: false };
  }
  return { label: "Open", tone: "neutral", showInvite: true };
}

// Finds the prev/next neighbor week ids from the full list (ordered by
// serviceDate desc, matching GET /api/service-weeks). Index 0 is the
// newest/furthest-future week, so the neighbor before it (idx - 1) is the
// "next" (newer) week and the neighbor after it (idx + 1) is "prev" (older).
function getNeighborWeekIds(
  weeks: ServiceWeekSummary[],
  currentId: string,
): { prevId: string | null; nextId: string | null } {
  const idx = weeks.findIndex((w) => w.id === currentId);
  if (idx === -1) return { prevId: null, nextId: null };
  return {
    nextId: idx > 0 ? (weeks[idx - 1]?.id ?? null) : null,
    prevId: idx < weeks.length - 1 ? (weeks[idx + 1]?.id ?? null) : null,
  };
}

export default function WeekView({ serviceWeekId }: { serviceWeekId: string }) {
  const [view, setView] = useState<ViewState>("loading");
  const [week, setWeek] = useState<ServiceWeekSummary | null>(null);
  const [members, setMembers] = useState<DirectoryMember[]>([]);
  const [invitations, setInvitations] = useState<WeekInvitation[]>([]);
  const [conflicts, setConflicts] = useState<OpenConflict[]>([]);
  const [neighbors, setNeighbors] = useState<{ prevId: string | null; nextId: string | null }>({
    prevId: null,
    nextId: null,
  });
  const [availability, setAvailability] = useState<TeamAvailabilityMember[]>([]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [invitingMemberId, setInvitingMemberId] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [weekRes, weeksRes, membersRes, invitationsRes, conflictsRes] = await Promise.all([
          fetch(`/api/service-weeks/${serviceWeekId}`),
          fetch(`/api/service-weeks`),
          fetch(`/api/church-group/members`),
          fetch(`/api/invitations?serviceWeekId=${serviceWeekId}`),
          fetch(`/api/conflicts`),
        ]);
        if (cancelled) return;

        if (weekRes.status === 404) {
          setView("not-found");
          return;
        }

        const coreResponses = [weekRes, membersRes, invitationsRes, conflictsRes];
        if (coreResponses.some((r) => r.status === 403)) {
          setView("forbidden");
          return;
        }
        if (coreResponses.some((r) => !r.ok)) {
          setView("error");
          return;
        }

        const weekBody = await weekRes.json();
        const weekData: ServiceWeekSummary = weekBody.data.serviceWeek;

        const membersBody = await membersRes.json();
        const membersData: DirectoryMember[] = membersBody.data.members;

        const invitationsBody = await invitationsRes.json();
        const invitationsData: WeekInvitation[] = invitationsBody.data.invitations;

        const conflictsBody = await conflictsRes.json();
        const allConflicts: OpenConflict[] = conflictsBody.data.conflicts;
        const conflictsData = allConflicts.filter((c) => c.serviceWeekId === serviceWeekId);

        // Non-critical: the week-list nav degrades to no neighbors on failure.
        let neighborIds: { prevId: string | null; nextId: string | null } = {
          prevId: null,
          nextId: null,
        };
        if (weeksRes.ok) {
          try {
            const weeksBody = await weeksRes.json();
            const weeksData: ServiceWeekSummary[] = weeksBody.data.serviceWeeks;
            neighborIds = getNeighborWeekIds(weeksData, serviceWeekId);
          } catch {
            // degrade silently
          }
        }

        if (cancelled) return;

        setWeek(weekData);
        setMembers(membersData);
        setInvitations(invitationsData);
        setConflicts(conflictsData);
        setNeighbors(neighborIds);
        setView("ready");

        // Non-critical: availability sidebar. Fetched after we know
        // serviceDate (from fetch 1), so it cannot be part of the initial
        // Promise.all above; a failure here degrades the sidebar, not the
        // whole screen.
        try {
          const dateWindow = getAvailabilityWindow(weekData.serviceDate);
          const startDate = dateWindow[0];
          const endDate = dateWindow[dateWindow.length - 1];
          const availRes = await fetch(
            `/api/availability/team?startDate=${startDate}&endDate=${endDate}`,
          );
          if (!cancelled && availRes.ok) {
            const availBody = await availRes.json();
            setAvailability(availBody.data.members);
          }
        } catch {
          // degrade silently
        }
      } catch {
        if (!cancelled) setView("error");
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [serviceWeekId]);

  // Sends a set invitation for a roster member with no invitation yet (#40).
  // On the BR-05 double-booking 409, offers to acknowledge and retry once —
  // mirrors createInvitation's acknowledgeConflict escape hatch.
  async function handleInvite(memberId: string) {
    if (invitingMemberId) return;
    setInvitingMemberId(memberId);
    setInviteError(null);

    try {
      const send = (acknowledgeConflict?: boolean) =>
        fetch("/api/invitations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ serviceWeekId, userId: memberId, acknowledgeConflict }),
        });

      let res = await send();

      if (res.status === 409) {
        const proceed = window.confirm(
          "This member is already confirmed for another week on this date. Invite anyway?",
        );
        if (!proceed) return;
        res = await send(true);
      }

      if (!res.ok) {
        setInviteError("Something went wrong sending the invitation. Please try again.");
        return;
      }

      const body = await res.json();
      const created = body.data.invitation;
      setInvitations((prev) => [
        ...prev,
        {
          id: created.id,
          serviceWeekId: created.serviceWeekId,
          userId: created.userId,
          roleNote: created.roleNote,
          status: created.status,
          responseDeadline: created.responseDeadline,
          createdAt: created.createdAt,
        },
      ]);
    } catch {
      setInviteError("Something went wrong sending the invitation. Please try again.");
    } finally {
      setInvitingMemberId(null);
    }
  }

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
        <h1>You don&apos;t have access to this page</h1>
        <p>This screen is available to Set Leaders and Admins only.</p>
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
  if (!week) return null;

  const conflictInvitationIds = new Set(conflicts.map((c) => c.invitationId));
  const availabilityWindow = getAvailabilityWindow(week.serviceDate);
  const memberNameById = new Map(members.map((m) => [m.id, m.name]));

  return (
    <main className={styles.container}>
      <header className={styles.header}>
        <div className={styles.nav}>
          {neighbors.prevId ? (
            <a href={`/week/${neighbors.prevId}`} aria-label="Previous week">
              ←
            </a>
          ) : (
            <span aria-disabled="true" className={styles.navDisabled}>
              ←
            </span>
          )}
          <div className={styles.headerTitle}>
            <h1>{week.title ?? "Untitled service"}</h1>
            <p className={styles.date}>{formatServiceDate(week.serviceDate)}</p>
          </div>
          {neighbors.nextId ? (
            <a href={`/week/${neighbors.nextId}`} aria-label="Next week">
              →
            </a>
          ) : (
            <span aria-disabled="true" className={styles.navDisabled}>
              →
            </span>
          )}
        </div>
        {week.isCancelled ? (
          <Badge tone="danger">Cancelled</Badge>
        ) : (
          // TODO(Sprint 3 #64): drive from setlist status
          <Badge tone="neutral">Draft</Badge>
        )}
      </header>

      <div className={styles.layout}>
        <div className={styles.main}>
          <section className={styles.card}>
            <h2>Roster</h2>
            {inviteError ? (
              <p role="alert" className={styles.error}>
                {inviteError}
              </p>
            ) : null}
            {members.length === 0 ? (
              <p>No members yet</p>
            ) : (
              <div className={styles.rosterGrid}>
                {members.map((member) => {
                  const status = getRosterStatus(member.id, invitations, conflictInvitationIds);
                  return (
                    <div key={member.id} className={styles.rosterSlot}>
                      <span className={styles.avatar} aria-hidden="true">
                        {getInitials(member.name)}
                      </span>
                      <span className={styles.memberName}>{member.name}</span>
                      <Badge tone={status.tone}>{status.label}</Badge>
                      {status.showInvite ? (
                        <Button
                          variant="secondary"
                          type="button"
                          className={styles.inviteButton}
                          disabled={invitingMemberId === member.id}
                          onClick={() => handleInvite(member.id)}
                        >
                          {invitingMemberId === member.id ? "Inviting…" : "+ Invite"}
                        </Button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section className={styles.card}>
            <h2>Events</h2>
            <p>No events yet</p>
            {/* TODO(#59): wire to GET/POST /api/events */}
            <Button variant="secondary" type="button">
              + Add event
            </Button>
          </section>

          <section className={styles.card}>
            <h2>Setlist</h2>
            <p>0 songs</p>
            {/* TODO(Sprint 3 #64): wire to setlist */}
            <Button variant="secondary" type="button">
              Edit setlist
            </Button>
          </section>
        </div>

        <aside className={sidebarCollapsed ? styles.sidebarCollapsed : styles.sidebar}>
          <div className={styles.sidebarHeader}>
            <h2>Availability</h2>
            <button
              type="button"
              onClick={() => setSidebarCollapsed((c) => !c)}
              aria-label={sidebarCollapsed ? "Expand availability sidebar" : "Collapse availability sidebar"}
            >
              {sidebarCollapsed ? "Expand" : "Collapse"}
            </button>
          </div>
          {!sidebarCollapsed ? (
            availability.length === 0 ? (
              <p>No availability data</p>
            ) : (
              <div className={styles.availabilityGrid}>
                <div className={styles.availabilityRow}>
                  <span className={styles.availabilityMemberCell} />
                  {availabilityWindow.map((date) => (
                    <span key={date} className={styles.availabilityDateCell}>
                      {formatShortDate(date)}
                    </span>
                  ))}
                </div>
                {availability.map((member) => {
                  const entryByDate = new Map(member.entries.map((e) => [e.date, e]));
                  return (
                    <div key={member.userId} className={styles.availabilityRow}>
                      <span className={styles.availabilityMemberCell}>
                        {memberNameById.get(member.userId) ?? "Unknown"}
                      </span>
                      {availabilityWindow.map((date) => {
                        const entry = entryByDate.get(date);
                        const cellClass =
                          entry === undefined
                            ? styles.availabilityUnknown
                            : entry.isAvailable
                              ? styles.availabilityAvailable
                              : styles.availabilityUnavailable;
                        return (
                          <span key={date} className={`${styles.availabilityDateCell} ${cellClass}`} />
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            )
          ) : null}
        </aside>
      </div>
    </main>
  );
}
