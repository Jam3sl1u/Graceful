// Single source of truth for the auth-bypass sweep (issue #80). Every
// exported handler that takes a UserLookup is listed here exactly once (see
// tests/unit/app/api/auth-bypass-matrix.test.ts §"Non-registry routes" for
// the small set of handlers that deliberately do not take a lookup and are
// tested separately). Non-test module under tests/ — precedent:
// tests/support/api-auth.ts.

import type { UserLookup } from "@/lib/api/auth";
import type { UserRole } from "@/types/domain";
import { makeApiReq, DEFAULT_CHURCH_GROUP_ID } from "@/tests/support/api-auth";

import { adminOnlyExample } from "@/app/api/_examples/admin-only/handler";
import { getAvailability, setAvailability, deleteAvailability } from "@/app/api/availability/handler";
import { getTeamAvailability } from "@/app/api/availability/team/handler";
import { getAuditLog } from "@/app/api/church-group/audit-log/handler";
import { getChurchGroupMembers } from "@/app/api/church-group/members/handler";
import { deleteMember } from "@/app/api/church-group/members/[id]/handler";
import { patchMemberRole } from "@/app/api/church-group/members/[id]/role/handler";
import { getOpenConflicts, resolveConflict } from "@/app/api/conflicts/handler";
import { listEvents, createEvent } from "@/app/api/events/handler";
import { updateEvent, deleteEvent } from "@/app/api/events/[id]/handler";
import { assignAttendee, removeAttendee } from "@/app/api/events/[id]/attendees/handler";
import { exportEventIcs } from "@/app/api/events/[id]/ics/handler";
import { exportEventsIcs } from "@/app/api/events/ics/handler";
import { callback } from "@/app/api/google-calendar/callback/handler";
import { connect } from "@/app/api/google-calendar/connect/handler";
import { disconnect } from "@/app/api/google-calendar/disconnect/handler";
import {
  listInstruments,
  addInstrument,
  submitCustomInstrument,
  promoteInstrument,
  deleteInstrument,
} from "@/app/api/instruments/handler";
import {
  listInvitations,
  createInvitation,
  createGuestInvitation,
  withdrawInvitation,
  denyInvitation,
  acceptInvitation,
} from "@/app/api/invitations/handler";
import {
  getNotificationPreferences,
  updateNotificationPreferences,
} from "@/app/api/notifications/preferences/handler";
import { getProfile, updateProfile } from "@/app/api/profile/handler";
import { listServiceWeeks, createServiceWeek } from "@/app/api/service-weeks/handler";
import {
  getServiceWeek,
  updateServiceWeek,
  deleteServiceWeek,
  cancelServiceWeek,
  reactivateServiceWeek,
} from "@/app/api/service-weeks/[id]/handler";
import { getMemberWeekView } from "@/app/api/service-weeks/[id]/member-view/handler";
import { getSetlist, createSetlist } from "@/app/api/service-weeks/[id]/setlist/handler";
import { getServiceWeeksOverview } from "@/app/api/service-weeks/overview/handler";
import {
  getSetlistWithSongs,
  reorderSetlist,
  addSetlistSong,
  publishSetlist,
  unlockSetlist,
  removeSetlistSong,
} from "@/app/api/setlists/[id]/handler";
import { listSongs, createSong } from "@/app/api/songs/handler";
import {
  createUploadUrl,
  registerDocument,
  listDocuments,
  deleteDocument,
} from "@/app/api/songs/[id]/documents/handler";

export type RouteEntry = {
  /** Stable label used in test names, e.g. "PATCH /api/church-group/members/:id/role". */
  name: string;
  /** Roles that pass requireRole. null = authenticated, no role gate. */
  allowedRoles: UserRole[] | null;
  /** What the handler must scope its DB access by. */
  scope: "group" | "user";
  /** Invokes the handler with the given lookup. */
  invoke: (lookup: UserLookup) => Promise<Response>;
  /** Optional result override handed to makeRecordingSupabase(). */
  result?: { data?: unknown; error?: unknown; count?: number | null };
  /**
   * False for handlers that never call getSupabaseClient()/getAnonSupabaseClient()
   * on ANY code path (verified by reading the source), e.g. an example handler
   * that only checks a role, or an OAuth-connect handler that only sets a
   * cookie and returns a redirect URL. Default true. When false:
   *  - the "expired token, getToken resolves null" (variant 2) case is
   *    inapplicable — the handler never re-fetches the Supabase JWT, so
   *    there is nothing for a stale/absent JWT to break, and is skipped.
   *  - case 4's touched/scope assertions are skipped (there is no
   *    tenant-scoped DB call to inspect) in favor of a plain smoke check
   *    that the call still succeeds.
   */
  touchesSupabase?: boolean;
  /**
   * True only for handlers documented as ALWAYS responding with an HTTP
   * redirect, never JSON (currently just the google-calendar OAuth
   * callback). Cases 1/2a/2b assert a redirect instead of a 401 JSON body.
   */
  authFailureIsRedirect?: boolean;
  /**
   * False when case 4's positive "own scope id must appear in seenValues"
   * assertion does not apply to this handler's architecture — e.g. tenant/
   * user scoping is enforced entirely by RLS (no explicit
   * `.eq("church_group_id", ctx.churchGroupId)`-style filter in the
   * handler) or by a SECURITY DEFINER RPC that derives identity from the
   * JWT's own auth.uid()/sub claim server-side, never from a value the
   * handler passes in. Default true. The negative "no victim id leaked"
   * assertion always still applies regardless of this flag — only the
   * positive sanity check is skipped, and only with a comment on the
   * entry explaining why. See .pipeline/changes.md SECURITY FINDINGS.
   */
  ownScopeAssertion?: boolean;
};

// Fixed UUIDs standing in for "some other tenant's resource" (a setlist id,
// an attendee id, etc.) — the recording client doesn't know or enforce
// tenant ownership, so these only need to be syntactically valid and
// distinct from VICTIM_CHURCH_GROUP_ID/VICTIM_USER_ID. They are separate
// from the tenant-scope probe: makeApiReq (tests/support/api-auth.ts)
// independently injects the VICTIM_* values into every request's query
// string/body under churchGroupId/church_group_id/userId/user_id keys,
// which is what case 4's negative assertion actually checks against.
const R1 = "22222222-2222-2222-2222-222222222222";
const R2 = "33333333-3333-3333-3333-333333333333";

const A: UserRole[] = ["admin"];
const AL: UserRole[] = ["admin", "set_leader"];
const ALM: UserRole[] = ["admin", "set_leader", "member"];
const ALMG: UserRole[] = ["admin", "set_leader", "member", "guest"];

export const ADMIN_ROUTE_REGISTRY: RouteEntry[] = [
  {
    name: "GET /api/_examples/admin-only",
    allowedRoles: A,
    scope: "group",
    invoke: (lookup) => adminOnlyExample(makeApiReq(), lookup),
    // Example/demo handler — checks requireRole and returns a static { ok:
    // true } body; never calls getSupabaseClient on any path, so there is
    // no tenant-scoped resource for a stale JWT or a foreign-group admin to
    // ever leak.
    touchesSupabase: false,
  },
  {
    name: "GET /api/availability",
    allowedRoles: null,
    scope: "user",
    // Excludes the userId/user_id probe keys: getAvailabilityQuerySchema's
    // `user_id` is presence-sensitive (any value, including the injected
    // probe's, switches the handler into the cross-user admin-lookup branch
    // — see app/api/availability/handler.ts), so injecting one here would
    // silently turn this "own availability" case into a duplicate of the
    // "?user_id=<other>" entry below instead of testing what it's meant to.
    invoke: (lookup) => getAvailability(makeApiReq({ excludeProbeKeys: ["userId", "user_id"] }), lookup),
  },
  {
    name: "GET /api/availability?user_id=<other>",
    allowedRoles: AL,
    scope: "user",
    invoke: (lookup) => getAvailability(makeApiReq({ query: { user_id: R2 } }), lookup),
    // By design, this branch substitutes the explicitly-requested user_id
    // (R2) for ctx.userId entirely (an admin/leader looking up a specific
    // teammate's availability) — ctx.userId never appears in the query on
    // this path. Group-level isolation (same-church-only) is enforced by
    // RLS via the caller's JWT, not a literal church_group_id filter here
    // (see the handler's own file-header comment) — covered by
    // tests/integration/rls, not this app-layer sweep.
    ownScopeAssertion: false,
  },
  {
    name: "PUT /api/availability",
    allowedRoles: null,
    scope: "user",
    invoke: (lookup) =>
      setAvailability(
        makeApiReq({ body: { entries: [{ date: "2026-01-01", isAvailable: true }] } }),
        lookup,
      ),
  },
  {
    name: "DELETE /api/availability/:date",
    allowedRoles: null,
    scope: "user",
    invoke: (lookup) => deleteAvailability(makeApiReq(), "2026-01-01", lookup),
  },
  {
    name: "GET /api/availability/team",
    allowedRoles: AL,
    scope: "group",
    invoke: (lookup) =>
      getTeamAvailability(
        makeApiReq({ query: { startDate: "2026-01-01", endDate: "2026-01-02" } }),
        lookup,
      ),
  },
  {
    name: "GET /api/church-group/audit-log",
    allowedRoles: A,
    scope: "group",
    invoke: (lookup) => getAuditLog(makeApiReq(), lookup),
    // Scoping is entirely delegated to RLS (audit_logs_select_admin) via
    // the caller's own JWT — the handler's own file-header comment says so
    // explicitly. No literal .eq("church_group_id", ...) filter exists for
    // this positive assertion to find. See SECURITY FINDINGS.
    ownScopeAssertion: false,
  },
  {
    name: "GET /api/church-group/members",
    allowedRoles: ALM,
    scope: "group",
    invoke: (lookup) => getChurchGroupMembers(makeApiReq(), lookup),
  },
  {
    name: "DELETE /api/church-group/members/:id",
    allowedRoles: A,
    scope: "group",
    invoke: (lookup) => deleteMember(makeApiReq(), R1, lookup),
    // The whole operation runs as a single SECURITY DEFINER RPC
    // (remove_church_group_member) that derives the caller's identity from
    // the JWT server-side, per the handler's own file-header comment —
    // ctx.churchGroupId is never passed as a literal RPC argument. See
    // SECURITY FINDINGS.
    ownScopeAssertion: false,
  },
  {
    name: "PATCH /api/church-group/members/:id/role",
    allowedRoles: A,
    scope: "group",
    invoke: (lookup) => patchMemberRole(makeApiReq({ body: { role: "member" } }), R1, lookup),
  },
  {
    name: "GET /api/conflicts",
    allowedRoles: AL,
    scope: "group",
    invoke: (lookup) => getOpenConflicts(makeApiReq(), lookup),
  },
  {
    name: "POST /api/conflicts/:id/resolve",
    allowedRoles: AL,
    scope: "group",
    invoke: (lookup) =>
      resolveConflict(makeApiReq({ body: { resolution: "admin_dismissed" } }), R1, lookup),
  },
  {
    name: "GET /api/events",
    allowedRoles: null,
    scope: "group",
    invoke: (lookup) => listEvents(makeApiReq(), lookup),
  },
  {
    name: "POST /api/events",
    allowedRoles: AL,
    scope: "group",
    invoke: (lookup) =>
      createEvent(
        makeApiReq({
          body: {
            serviceWeekId: R1,
            type: "rehearsal",
            name: "Event",
            startTime: "2026-01-01T00:00:00.000Z",
            endTime: "2026-01-01T01:00:00.000Z",
          },
        }),
        lookup,
      ),
  },
  {
    name: "PUT /api/events/:id",
    allowedRoles: AL,
    scope: "group",
    invoke: (lookup) => updateEvent(makeApiReq({ body: { name: "Updated" } }), R1, lookup),
  },
  {
    name: "DELETE /api/events/:id",
    allowedRoles: AL,
    scope: "group",
    invoke: (lookup) => deleteEvent(makeApiReq(), R1, lookup),
  },
  {
    name: "POST /api/events/:id/attendees",
    allowedRoles: AL,
    scope: "group",
    invoke: (lookup) => assignAttendee(makeApiReq({ body: { userId: R2 } }), R1, lookup),
  },
  {
    name: "DELETE /api/events/:id/attendees/:userId",
    allowedRoles: AL,
    scope: "group",
    invoke: (lookup) => removeAttendee(makeApiReq(), R1, R2, lookup),
  },
  {
    name: "GET /api/events/:id/ics",
    allowedRoles: null,
    // Spec table §3 lists "group" for this row, but the handler (see its own
    // file-header comment: "Exports ... one of the caller's *assigned*
    // events") never reads ctx.churchGroupId anywhere — it scopes entirely
    // by ctx.userId via event_attendees, exactly like its sibling
    // GET /api/events/ics (exportEventsIcs) directly below, which the same
    // table correctly lists as "user". Treating this as "group" would make
    // case 4 unsatisfiable for any possible `result` override, since the
    // handler structurally never touches church_group_id — corrected to
    // "user" to match actual handler behavior (documented in changes.md).
    scope: "user",
    // exportEventIcs feeds the fetched row's fields straight into
    // escapeIcsText, which throws on undefined — give it a real-shaped row
    // (edge case #3) rather than the [] default.
    result: {
      data: {
        id: R1,
        name: "Event",
        location: null,
        notes: null,
        start_time: "2026-01-01T00:00:00.000Z",
        end_time: "2026-01-01T01:00:00.000Z",
      },
      error: null,
    },
    invoke: (lookup) => exportEventIcs(makeApiReq(), R1, lookup),
  },
  {
    name: "GET /api/events/ics",
    allowedRoles: null,
    scope: "user",
    invoke: (lookup) => exportEventsIcs(makeApiReq(), lookup),
  },
  {
    name: "GET /api/google-calendar/callback",
    allowedRoles: null,
    scope: "user",
    invoke: (lookup) =>
      callback(
        {
          ...makeApiReq({ query: { code: "abc", state: "csrf-state-value" } }),
          url: "https://app.example.com/api/google-calendar/callback",
        } as unknown as Parameters<typeof callback>[0],
        lookup,
      ),
    // Per the handler's own file-header comment: "Always responds with an
    // HTTP redirect (never JSON): /profile?calendar=connected on success,
    // /profile?calendar=error on any failure" — every requireAuth failure
    // (no token, expired-variant-1, expired-variant-2) is caught by the
    // handler's blanket try/catch and turned into a redirect, never a JSON
    // 401.
    authFailureIsRedirect: true,
  },
  {
    name: "POST /api/google-calendar/connect",
    allowedRoles: null,
    scope: "user",
    invoke: (lookup) => connect(makeApiReq(), lookup),
    // Only sets a CSRF-state cookie and returns Google's consent URL; never
    // calls getSupabaseClient (confirmed by reading the handler) — there is
    // no Supabase-template JWT re-check to break and no tenant-scoped DB
    // call to leak from.
    touchesSupabase: false,
  },
  {
    name: "DELETE /api/google-calendar/disconnect",
    allowedRoles: null,
    scope: "user",
    invoke: (lookup) => disconnect(makeApiReq(), lookup),
  },
  {
    name: "GET /api/instruments",
    allowedRoles: null,
    scope: "group",
    invoke: (lookup) => listInstruments(makeApiReq(), lookup),
  },
  {
    name: "POST /api/instruments",
    allowedRoles: A,
    scope: "group",
    invoke: (lookup) => addInstrument(makeApiReq({ body: { name: "Trumpet" } }), lookup),
  },
  {
    name: "POST /api/instruments/custom",
    allowedRoles: null,
    scope: "group",
    invoke: (lookup) => submitCustomInstrument(makeApiReq({ body: { name: "Kazoo" } }), lookup),
  },
  {
    name: "POST /api/instruments/:id/promote",
    allowedRoles: A,
    scope: "group",
    invoke: (lookup) => promoteInstrument(makeApiReq(), R1, lookup),
  },
  {
    name: "DELETE /api/instruments/:id",
    allowedRoles: A,
    scope: "group",
    invoke: (lookup) => deleteInstrument(makeApiReq(), R1, lookup),
  },
  {
    name: "GET /api/invitations",
    allowedRoles: AL,
    scope: "group",
    invoke: (lookup) => listInvitations(makeApiReq({ query: { serviceWeekId: R1 } }), lookup),
  },
  {
    name: "POST /api/invitations",
    allowedRoles: AL,
    scope: "group",
    invoke: (lookup) =>
      createInvitation(makeApiReq({ body: { serviceWeekId: R1, userId: R2 } }), lookup),
  },
  {
    name: "POST /api/invitations/guest",
    allowedRoles: AL,
    scope: "group",
    invoke: (lookup) =>
      createGuestInvitation(
        makeApiReq({ body: { serviceWeekId: R1, email: "guest@example.com" } }),
        lookup,
      ),
  },
  {
    name: "DELETE /api/invitations/:id",
    allowedRoles: AL,
    scope: "group",
    invoke: (lookup) => withdrawInvitation(makeApiReq(), R1, lookup),
  },
  {
    name: "POST /api/invitations/:id/deny",
    allowedRoles: null,
    scope: "group",
    // No responseToken in the body -> exercises the session (requireAuth)
    // path, not the no-session token path (edge case #4).
    invoke: (lookup) => denyInvitation(makeApiReq(), R1, lookup),
  },
  {
    name: "POST /api/invitations/:id/accept",
    allowedRoles: null,
    scope: "group",
    invoke: (lookup) => acceptInvitation(makeApiReq(), R1, lookup),
    // Unlike its sibling denyInvitation (which filters explicitly by
    // ctx.churchGroupId/ctx.userId before mutating), the session path here
    // delegates entirely to the accept_invitation SECURITY DEFINER RPC,
    // which derives identity from the JWT server-side — ctx.churchGroupId
    // is never passed as a literal RPC argument. See SECURITY FINDINGS.
    ownScopeAssertion: false,
  },
  {
    name: "GET /api/notifications/preferences",
    allowedRoles: null,
    scope: "user",
    invoke: (lookup) => getNotificationPreferences(makeApiReq(), lookup),
  },
  {
    name: "PUT /api/notifications/preferences",
    allowedRoles: null,
    scope: "user",
    invoke: (lookup) =>
      updateNotificationPreferences(
        makeApiReq({ body: { invitationSms: true, invitationEmail: true, invitationInapp: true } }),
        lookup,
      ),
  },
  {
    name: "GET /api/profile",
    allowedRoles: null,
    scope: "user",
    invoke: (lookup) => getProfile(makeApiReq(), lookup),
  },
  {
    name: "PUT /api/profile",
    allowedRoles: null,
    scope: "user",
    invoke: (lookup) =>
      updateProfile(makeApiReq({ body: { vocalCapability: "lead", bio: "hi" } }), lookup),
  },
  {
    name: "GET /api/service-weeks",
    allowedRoles: null,
    scope: "group",
    invoke: (lookup) => listServiceWeeks(makeApiReq(), lookup),
  },
  {
    name: "POST /api/service-weeks",
    allowedRoles: AL,
    scope: "group",
    invoke: (lookup) =>
      createServiceWeek(
        makeApiReq({
          body: {
            serviceDate: "2026-01-01",
            title: "T",
            sermonTopic: "topic",
            sermonScripture: "scripture",
            speakerName: "Speaker",
          },
        }),
        lookup,
      ),
  },
  {
    name: "GET /api/service-weeks/:id",
    allowedRoles: null,
    scope: "group",
    invoke: (lookup) => getServiceWeek(makeApiReq(), R1, lookup),
  },
  {
    name: "PUT /api/service-weeks/:id",
    allowedRoles: AL,
    scope: "group",
    invoke: (lookup) => updateServiceWeek(makeApiReq({ body: { title: "Updated" } }), R1, lookup),
  },
  {
    name: "DELETE /api/service-weeks/:id",
    allowedRoles: A,
    scope: "group",
    invoke: (lookup) => deleteServiceWeek(makeApiReq(), R1, lookup),
  },
  {
    name: "POST /api/service-weeks/:id/cancel",
    allowedRoles: A,
    scope: "group",
    invoke: (lookup) => cancelServiceWeek(makeApiReq(), R1, lookup),
  },
  {
    name: "POST /api/service-weeks/:id/reactivate",
    allowedRoles: A,
    scope: "group",
    invoke: (lookup) => reactivateServiceWeek(makeApiReq(), R1, lookup),
  },
  {
    name: "GET /api/service-weeks/:id/member-view",
    allowedRoles: ALMG,
    scope: "group",
    invoke: (lookup) => getMemberWeekView(makeApiReq(), R1, lookup),
  },
  {
    name: "GET /api/service-weeks/:id/setlist",
    allowedRoles: null,
    scope: "group",
    invoke: (lookup) => getSetlist(makeApiReq(), R1, lookup),
  },
  {
    name: "POST /api/service-weeks/:id/setlist",
    allowedRoles: AL,
    scope: "group",
    invoke: (lookup) => createSetlist(makeApiReq(), R1, lookup),
  },
  {
    name: "GET /api/service-weeks/overview",
    allowedRoles: AL,
    scope: "group",
    invoke: (lookup) => getServiceWeeksOverview(makeApiReq(), lookup),
  },
  {
    name: "GET /api/setlists/:id",
    allowedRoles: AL,
    scope: "group",
    invoke: (lookup) => getSetlistWithSongs(makeApiReq(), R1, lookup),
  },
  {
    name: "PUT /api/setlists/:id",
    allowedRoles: AL,
    scope: "group",
    invoke: (lookup) =>
      reorderSetlist(makeApiReq({ body: { songs: [{ songId: R2 }] } }), R1, lookup),
  },
  {
    name: "POST /api/setlists/:id/songs",
    allowedRoles: AL,
    scope: "group",
    invoke: (lookup) => addSetlistSong(makeApiReq({ body: { songId: R2 } }), R1, lookup),
  },
  {
    name: "POST /api/setlists/:id/publish",
    allowedRoles: AL,
    scope: "group",
    invoke: (lookup) => publishSetlist(makeApiReq(), R1, lookup),
  },
  {
    name: "POST /api/setlists/:id/unlock",
    allowedRoles: AL,
    scope: "group",
    invoke: (lookup) => unlockSetlist(makeApiReq(), R1, lookup),
  },
  {
    name: "DELETE /api/setlists/:id/songs/:songId",
    allowedRoles: AL,
    scope: "group",
    invoke: (lookup) => removeSetlistSong(makeApiReq(), R1, R2, lookup),
  },
  {
    name: "GET /api/songs",
    allowedRoles: ALM,
    scope: "group",
    invoke: (lookup) => listSongs(makeApiReq(), lookup),
  },
  {
    name: "POST /api/songs",
    allowedRoles: AL,
    scope: "group",
    invoke: (lookup) => createSong(makeApiReq({ body: { title: "Song" } }), lookup),
  },
  {
    name: "POST /api/songs/:id/documents/upload-url",
    allowedRoles: AL,
    scope: "group",
    invoke: (lookup) =>
      createUploadUrl(
        makeApiReq({ body: { name: "chart.pdf", file_type: "application/pdf", file_size_bytes: 1000 } }),
        R1,
        lookup,
      ),
  },
  {
    name: "POST /api/songs/:id/documents",
    allowedRoles: AL,
    scope: "group",
    invoke: (lookup) =>
      registerDocument(
        makeApiReq({
          body: {
            name: "chart.pdf",
            file_type: "application/pdf",
            file_size_bytes: 1000,
            file_key: `song-documents/${DEFAULT_CHURCH_GROUP_ID}/${R1}/u/chart.pdf`,
          },
        }),
        R1,
        lookup,
      ),
  },
  {
    name: "GET /api/songs/:id/documents",
    allowedRoles: ALM,
    scope: "group",
    invoke: (lookup) => listDocuments(makeApiReq(), R1, lookup),
  },
  {
    name: "DELETE /api/songs/:id/documents/:docId",
    allowedRoles: AL,
    scope: "group",
    invoke: (lookup) => deleteDocument(makeApiReq(), R1, R2, lookup),
  },
];
