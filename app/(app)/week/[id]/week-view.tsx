"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Avatar } from "@/components/ui/Avatar";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { InputField } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Page } from "@/components/ui/Page";
import {
  EmptyState,
  ErrorAlert,
  ErrorState,
  LoadingState,
  NoAccessState,
  NoticeState,
} from "@/components/ui/States";
import { useToast } from "@/components/ui/Toast";
import { formatServiceDate } from "@/lib/format/dates";
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
  role: string;
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
  tone: BadgeTone;
  showInvite: boolean;
};

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

// Status label for a guest's invitation card (#72) — simpler than
// getRosterStatus (no conflict/showInvite concerns, just "what state is
// this guest's invitation in").
function getGuestStatusLabel(
  status: InvitationStatus,
): { label: string; tone: BadgeTone } {
  switch (status) {
    case "accepted":
      return { label: "Confirmed", tone: "success" };
    case "pending":
      return { label: "Pending", tone: "warning" };
    case "denied":
      return { label: "Declined", tone: "neutral" };
    case "withdrawn":
      return { label: "Withdrawn", tone: "neutral" };
    case "expired":
      return { label: "Expired", tone: "neutral" };
    default:
      return { label: status, tone: "neutral" };
  }
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
  const [guestEmail, setGuestEmail] = useState("");
  const [guestRoleNote, setGuestRoleNote] = useState("");
  const [invitingGuest, setInvitingGuest] = useState(false);
  const [guestInviteError, setGuestInviteError] = useState<string | null>(null);
  const [guestAccountSetupUrl, setGuestAccountSetupUrl] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const { toast } = useToast();

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
  }, [serviceWeekId, reloadKey]);

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
      toast("Invitation sent");
    } catch {
      setInviteError("Something went wrong sending the invitation. Please try again.");
    } finally {
      setInvitingMemberId(null);
    }
  }

  // Invites a guest (4th role, #72) by email — the account-creation link (for
  // a brand-new guest) is only surfaced here until #68 sends it by email.
  async function handleInviteGuest(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (invitingGuest) return;
    setInvitingGuest(true);
    setGuestInviteError(null);
    setGuestAccountSetupUrl(null);

    try {
      const trimmedNote = guestRoleNote.trim();
      const res = await fetch("/api/invitations/guest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serviceWeekId,
          email: guestEmail,
          roleNote: trimmedNote.length > 0 ? trimmedNote : undefined,
        }),
      });

      const body = await res.json();

      if (!res.ok) {
        setGuestInviteError(body?.error ?? "Something went wrong inviting the guest. Please try again.");
        return;
      }

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

      if (body.data.isNewUser === true) {
        setGuestAccountSetupUrl(body.data.accountSetupUrl);
      }

      // Refresh the directory so the new guest appears in the Guests
      // section immediately, instead of only after a manual reload.
      try {
        const membersRes = await fetch(`/api/church-group/members`);
        if (membersRes.ok) {
          const membersBody = await membersRes.json();
          setMembers(membersBody.data.members);
        }
      } catch {
        // Non-critical: the accountSetupUrl feedback above already confirms
        // the invite succeeded; the directory just won't refresh until the
        // next load.
      }

      setGuestEmail("");
      setGuestRoleNote("");
      toast("Guest invited");
    } catch {
      setGuestInviteError("Something went wrong inviting the guest. Please try again.");
    } finally {
      setInvitingGuest(false);
    }
  }

  const scheduleLink = (
    <ButtonLink href="/dashboard" variant="secondary">
      Back to schedule
    </ButtonLink>
  );

  if (view === "loading") {
    return (
      <Page width="wide">
        <LoadingState cards={3} />
      </Page>
    );
  }

  if (view === "forbidden") {
    return (
      <Page width="wide">
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

  if (view === "not-found") {
    return (
      <Page width="wide">
        <NoticeState icon="calendar" tone="info" title="Service week not found" actions={scheduleLink}>
          It may have been removed, or the link may be incomplete.
        </NoticeState>
      </Page>
    );
  }

  if (view === "error") {
    return (
      <Page width="wide">
        <ErrorState
          onRetry={() => {
            setView("loading");
            setReloadKey((k) => k + 1);
          }}
          actions={scheduleLink}
        />
      </Page>
    );
  }

  // ready
  if (!week) return null;

  const conflictInvitationIds = new Set(conflicts.map((c) => c.invitationId));
  const availabilityWindow = getAvailabilityWindow(week.serviceDate);
  const memberNameById = new Map(members.map((m) => [m.id, m.name]));
  // Guests never occupy a music-roster slot (#72) — split the directory so
  // the roster grid only ever shows non-guest members.
  const rosterMembers = members.filter((m) => m.role !== "guest");
  const guestEntries = members
    .filter((m) => m.role === "guest")
    .map((member) => ({ member, invitation: getCurrentInvitation(member.id, invitations) }))
    .filter(
      (entry): entry is { member: DirectoryMember; invitation: WeekInvitation } =>
        entry.invitation !== undefined,
    );
  const rosterStatuses = rosterMembers.map((member) => ({
    member,
    status: getRosterStatus(member.id, invitations, conflictInvitationIds),
  }));
  const confirmedTotal = rosterStatuses.filter((r) => r.status.label === "Confirmed").length;

  return (
    <Page width="wide">
      <header className={styles.header}>
        <div className={styles.nav}>
          {neighbors.prevId ? (
            <Link
              href={`/week/${neighbors.prevId}`}
              aria-label="Previous week"
              className={styles.navButton}
            >
              <Icon name="chevronLeft" />
            </Link>
          ) : (
            <span className={`${styles.navButton} ${styles.navDisabled}`} aria-hidden="true">
              <Icon name="chevronLeft" />
            </span>
          )}
          <div className={styles.headerTitle}>
            <h1>{week.title ?? "Untitled service"}</h1>
            <p className={styles.date}>{formatServiceDate(week.serviceDate)}</p>
          </div>
          {neighbors.nextId ? (
            <Link
              href={`/week/${neighbors.nextId}`}
              aria-label="Next week"
              className={styles.navButton}
            >
              <Icon name="chevronRight" />
            </Link>
          ) : (
            <span className={`${styles.navButton} ${styles.navDisabled}`} aria-hidden="true">
              <Icon name="chevronRight" />
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
          <Card as="section" aria-labelledby="week-roster">
            <CardHeader>
              <h2 id="week-roster">Roster</h2>
              {rosterMembers.length > 0 ? (
                <span className={styles.summary}>
                  {confirmedTotal} of {rosterMembers.length} confirmed
                </span>
              ) : null}
            </CardHeader>
            {inviteError ? <ErrorAlert>{inviteError}</ErrorAlert> : null}
            {rosterMembers.length === 0 ? (
              <EmptyState icon="users" title="No members yet">
                Share your group&apos;s invite code so people can join.
              </EmptyState>
            ) : (
              <div className={styles.rosterGrid}>
                {rosterStatuses.map(({ member, status }) => (
                  <div key={member.id} className={styles.rosterSlot}>
                    <Avatar name={member.name} />
                    <span className={styles.memberName}>{member.name}</span>
                    <Badge tone={status.tone}>{status.label}</Badge>
                    {status.showInvite ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        className={styles.inviteButton}
                        disabled={invitingMemberId === member.id}
                        loading={invitingMemberId === member.id}
                        aria-label={
                          invitingMemberId === member.id ? undefined : `+ Invite ${member.name}`
                        }
                        onClick={() => handleInvite(member.id)}
                      >
                        {invitingMemberId === member.id ? "Inviting…" : "+ Invite"}
                      </Button>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card as="section" aria-labelledby="week-guests">
            <CardHeader>
              <h2 id="week-guests">Guests</h2>
            </CardHeader>
            {guestInviteError ? <ErrorAlert>{guestInviteError}</ErrorAlert> : null}
            {guestEntries.length === 0 ? (
              <p className={styles.muted}>No guests invited for this week yet</p>
            ) : (
              <div className={styles.rosterGrid}>
                {guestEntries.map(({ member: guest, invitation }) => {
                  const guestStatus = getGuestStatusLabel(invitation.status);
                  return (
                    <div key={guest.id} className={styles.rosterSlot}>
                      <Avatar name={guest.name} />
                      <span className={styles.memberName}>{guest.name}</span>
                      <Badge tone={guestStatus.tone}>{guestStatus.label}</Badge>
                    </div>
                  );
                })}
              </div>
            )}

            <form className={styles.guestForm} onSubmit={handleInviteGuest}>
              <h3>Invite a guest</h3>
              <div className={styles.guestFormRow}>
                <InputField
                  label="Guest email"
                  type="email"
                  required
                  autoComplete="off"
                  inputMode="email"
                  placeholder="name@example.com"
                  value={guestEmail}
                  onChange={(e) => setGuestEmail(e.target.value)}
                />
                <InputField
                  label="Role note"
                  optional
                  type="text"
                  placeholder="e.g. Drums"
                  value={guestRoleNote}
                  onChange={(e) => setGuestRoleNote(e.target.value)}
                />
                <Button
                  variant="primary"
                  type="submit"
                  disabled={invitingGuest}
                  loading={invitingGuest}
                >
                  {invitingGuest ? "Inviting…" : "Invite guest"}
                </Button>
              </div>
            </form>

            {guestAccountSetupUrl ? (
              <div className={styles.guestSetup} role="status">
                <p>
                  <strong>Send this link to your guest.</strong> They need it to create their
                  account — it isn&apos;t emailed automatically yet.
                </p>
                <span className={styles.guestSetupUrl}>{guestAccountSetupUrl}</span>
              </div>
            ) : null}
          </Card>

          <Card as="section" aria-labelledby="week-events">
            <CardHeader>
              <h2 id="week-events">Events</h2>
              {/* TODO(#59): wire to GET/POST /api/events */}
              <Button variant="secondary" size="sm" disabled aria-describedby="week-events-soon">
                + Add event
              </Button>
            </CardHeader>
            <p className={styles.muted}>No events yet</p>
            <p id="week-events-soon" className={styles.soon}>
              Adding events from this screen isn&apos;t available yet.
            </p>
          </Card>

          <Card as="section" aria-labelledby="week-setlist">
            <CardHeader>
              <h2 id="week-setlist">Setlist</h2>
              {/* TODO(Sprint 3 #64): wire to setlist */}
              <Button variant="secondary" size="sm" disabled aria-describedby="week-setlist-soon">
                Edit setlist
              </Button>
            </CardHeader>
            <p className={styles.muted}>0 songs</p>
            <p id="week-setlist-soon" className={styles.soon}>
              Opening the setlist from this screen isn&apos;t available yet.
            </p>
          </Card>
        </div>

        <Card
          as="section"
          aria-labelledby="week-availability"
          className={sidebarCollapsed ? styles.sidebarCollapsed : styles.sidebar}
        >
          <div className={styles.sidebarHeader}>
            <h2 id="week-availability">Availability</h2>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSidebarCollapsed((c) => !c)}
              aria-expanded={!sidebarCollapsed}
              aria-label={
                sidebarCollapsed ? "Expand availability sidebar" : "Collapse availability sidebar"
              }
            >
              {sidebarCollapsed ? "Expand" : "Collapse"}
            </Button>
          </div>
          {!sidebarCollapsed ? (
            availability.length === 0 ? (
              <p className={styles.muted}>No availability data</p>
            ) : (
              <>
                <div className={styles.availabilityScroll}>
                  <table className={styles.availabilityTable}>
                    <caption className="sr-only">
                      Team availability for the seven days up to this service
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">
                          <span className="sr-only">Member</span>
                        </th>
                        {availabilityWindow.map((date) => (
                          <th key={date} scope="col" className={styles.availabilityDate}>
                            {formatShortDate(date)
                              .split(", ")
                              .map((part) => (
                                <span key={part} className={styles.availabilityDatePart}>
                                  {part}
                                </span>
                              ))}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {availability.map((member) => {
                        const entryByDate = new Map(member.entries.map((e) => [e.date, e]));
                        return (
                          <tr key={member.userId}>
                            <th scope="row" className={styles.availabilityMember}>
                              {memberNameById.get(member.userId) ?? "Unknown"}
                            </th>
                            {availabilityWindow.map((date) => {
                              const entry = entryByDate.get(date);
                              const state =
                                entry === undefined
                                  ? { cls: styles.availabilityUnknown, label: "No answer" }
                                  : entry.isAvailable
                                    ? { cls: styles.availabilityAvailable, label: "Available" }
                                    : { cls: styles.availabilityUnavailable, label: "Unavailable" };
                              return (
                                <td key={date}>
                                  <span className={`${styles.availabilityCell} ${state.cls}`}>
                                    {entry === undefined ? null : (
                                      <Icon name={entry.isAvailable ? "check" : "x"} size={14} />
                                    )}
                                    <span className="sr-only">{state.label}</span>
                                  </span>
                                </td>
                              );
                            })}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <ul className={styles.legend} aria-hidden="true">
                  <li>
                    <span className={`${styles.availabilityCell} ${styles.availabilityAvailable}`}>
                      <Icon name="check" size={14} />
                    </span>
                    Available
                  </li>
                  <li>
                    <span className={`${styles.availabilityCell} ${styles.availabilityUnavailable}`}>
                      <Icon name="x" size={14} />
                    </span>
                    Unavailable
                  </li>
                  <li>
                    <span className={`${styles.availabilityCell} ${styles.availabilityUnknown}`} />
                    No answer
                  </li>
                </ul>
              </>
            )
          ) : null}
        </Card>
      </div>
    </Page>
  );
}
