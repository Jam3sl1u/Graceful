/**
 * Cross-tenant bypass matrix (issue #33, AC-1).
 *
 * For every one of the 19 Sprint 0–1 tables, a Church A persona attempts all
 * four verbs (SELECT / INSERT / UPDATE / DELETE) against Church B's rows.
 * Every attempt must fail to leak or mutate data:
 *   - SELECT must return zero rows (or a policy error).
 *   - INSERT must return an error (RLS WITH CHECK / missing policy denial).
 *   - UPDATE/DELETE do NOT necessarily error — RLS silently filters the
 *     target row out, so the assertion re-reads via the service client to
 *     confirm the row is unchanged / still present. A hard privilege error
 *     (e.g. audit_logs, which REVOKEs UPDATE/DELETE) is also acceptable.
 *
 * Attacker persona is Church A's memberA. For tables where only an elevated
 * role could ever write (setlists, invitations, conflicts, audit_logs), the
 * same attempts are repeated as adminA to prove even a privileged Church A
 * user cannot cross tenants.
 */

import { getUserClient, getServiceClient } from "../client";
import { IDS, rlsTestsEnabled, seedViaServiceClient } from "../setup";
import {
  assertSelectBlocked,
  assertInsertDenied,
  assertUpdateNoOp,
  assertDeleteNoOp,
} from "../helpers";

const skip = !rlsTestsEnabled || !process.env.SUPABASE_TEST_URL;

const describeRls = skip ? describe.skip : describe;

describeRls("Cross-tenant bypass matrix (Church A → Church B)", () => {
  let serviceClient: ReturnType<typeof getServiceClient>;
  let memberA: ReturnType<typeof getUserClient>;
  let adminA: ReturnType<typeof getUserClient>;

  beforeAll(async () => {
    await seedViaServiceClient();
    serviceClient = getServiceClient();
    memberA = getUserClient({ clerkId: IDS.clerkIds.memberA });
    adminA = getUserClient({ clerkId: IDS.clerkIds.adminA });
  }, 60_000);

  // ── church_groups ─────────────────────────────────────────────────────────

  describe("church_groups", () => {
    it("SELECT blocked", async () => {
      await assertSelectBlocked(memberA, "church_groups", { id: IDS.churches.B });
    });

    it("INSERT denied", async () => {
      await assertInsertDenied(memberA, "church_groups", {
        name: "Evil",
        timezone: "UTC",
        invite_code: "EVIL",
      });
    });

    it("UPDATE no-op", async () => {
      await assertUpdateNoOp(memberA, serviceClient, "church_groups", IDS.churches.B, {
        name: "Hacked",
      });
    });

    it("DELETE no-op", async () => {
      await assertDeleteNoOp(memberA, serviceClient, "church_groups", IDS.churches.B);
    });
  });

  // ── users ─────────────────────────────────────────────────────────────────

  describe("users", () => {
    it("SELECT blocked", async () => {
      await assertSelectBlocked(memberA, "users", { church_group_id: IDS.churches.B });
    });

    it("INSERT denied", async () => {
      await assertInsertDenied(memberA, "users", {
        clerk_id: "evil",
        church_group_id: IDS.churches.B,
        role: "member",
        name: "Evil",
        email: "evil@test.example",
      });
    });

    it("UPDATE no-op", async () => {
      await assertUpdateNoOp(memberA, serviceClient, "users", IDS.users.memberB, {
        name: "Hacked",
      });
    });

    it("DELETE no-op", async () => {
      await assertDeleteNoOp(memberA, serviceClient, "users", IDS.users.memberB);
    });
  });

  // ── member_profiles ───────────────────────────────────────────────────────

  describe("member_profiles", () => {
    it("SELECT blocked", async () => {
      await assertSelectBlocked(memberA, "member_profiles", { id: IDS.memberProfiles.memberB });
    });

    it("INSERT denied", async () => {
      await assertInsertDenied(memberA, "member_profiles", {
        user_id: IDS.users.memberB,
        vocal_capability: "lead",
      });
    });

    it("UPDATE no-op", async () => {
      await assertUpdateNoOp(
        memberA,
        serviceClient,
        "member_profiles",
        IDS.memberProfiles.memberB,
        { vocal_capability: "harmony" },
      );
    });

    it("DELETE no-op", async () => {
      await assertDeleteNoOp(memberA, serviceClient, "member_profiles", IDS.memberProfiles.memberB);
    });
  });

  // ── instruments ───────────────────────────────────────────────────────────

  describe("instruments", () => {
    it("SELECT blocked", async () => {
      await assertSelectBlocked(memberA, "instruments", { church_group_id: IDS.churches.B });
    });

    it("INSERT denied", async () => {
      await assertInsertDenied(memberA, "instruments", {
        church_group_id: IDS.churches.B,
        name: "Evil",
        is_default: false,
      });
    });

    it("UPDATE no-op", async () => {
      await assertUpdateNoOp(memberA, serviceClient, "instruments", IDS.instruments.drumsB, {
        name: "Hacked",
      });
    });

    it("DELETE no-op", async () => {
      await assertDeleteNoOp(memberA, serviceClient, "instruments", IDS.instruments.drumsB);
    });
  });

  // ── member_instruments ────────────────────────────────────────────────────

  describe("member_instruments", () => {
    it("SELECT blocked", async () => {
      await assertSelectBlocked(memberA, "member_instruments", {
        id: IDS.memberInstruments.memberB,
      });
    });

    it("INSERT denied", async () => {
      await assertInsertDenied(memberA, "member_instruments", {
        member_profile_id: IDS.memberProfiles.memberB,
        instrument_id: IDS.instruments.drumsB,
      });
    });

    it("UPDATE no-op", async () => {
      await assertUpdateNoOp(
        memberA,
        serviceClient,
        "member_instruments",
        IDS.memberInstruments.memberB,
        { instrument_id: IDS.instruments.pianoA },
      );
    });

    it("DELETE no-op", async () => {
      await assertDeleteNoOp(
        memberA,
        serviceClient,
        "member_instruments",
        IDS.memberInstruments.memberB,
      );
    });
  });

  // ── service_weeks ─────────────────────────────────────────────────────────

  describe("service_weeks", () => {
    it("SELECT blocked", async () => {
      await assertSelectBlocked(memberA, "service_weeks", { church_group_id: IDS.churches.B });
    });

    it("INSERT denied", async () => {
      await assertInsertDenied(memberA, "service_weeks", {
        church_group_id: IDS.churches.B,
        service_date: "2026-09-01",
        title: "Evil",
      });
    });

    it("UPDATE no-op", async () => {
      await assertUpdateNoOp(memberA, serviceClient, "service_weeks", IDS.serviceWeeks.B1, {
        title: "Hacked",
      });
    });

    it("DELETE no-op", async () => {
      await assertDeleteNoOp(memberA, serviceClient, "service_weeks", IDS.serviceWeeks.B1);
    });
  });

  // ── setlists (also adminA — role-gated writes) ───────────────────────────

  describe("setlists", () => {
    it("SELECT blocked", async () => {
      await assertSelectBlocked(memberA, "setlists", { church_group_id: IDS.churches.B });
    });

    it("INSERT denied (memberA)", async () => {
      await assertInsertDenied(memberA, "setlists", {
        church_group_id: IDS.churches.B,
        service_week_id: IDS.serviceWeeks.B1,
        status: "draft",
      });
    });

    it("INSERT denied (adminA)", async () => {
      await assertInsertDenied(adminA, "setlists", {
        church_group_id: IDS.churches.B,
        service_week_id: IDS.serviceWeeks.B1,
        status: "draft",
      });
    });

    it("UPDATE no-op (memberA)", async () => {
      await assertUpdateNoOp(memberA, serviceClient, "setlists", IDS.setlists.publishedB, {
        status: "draft",
      });
    });

    it("UPDATE no-op (adminA)", async () => {
      await assertUpdateNoOp(adminA, serviceClient, "setlists", IDS.setlists.publishedB, {
        status: "draft",
      });
    });

    it("DELETE no-op (memberA)", async () => {
      await assertDeleteNoOp(memberA, serviceClient, "setlists", IDS.setlists.publishedB);
    });

    it("DELETE no-op (adminA)", async () => {
      await assertDeleteNoOp(adminA, serviceClient, "setlists", IDS.setlists.publishedB);
    });
  });

  // ── setlist_songs ─────────────────────────────────────────────────────────

  describe("setlist_songs", () => {
    it("SELECT blocked", async () => {
      await assertSelectBlocked(memberA, "setlist_songs", { id: IDS.setlistSongs.publishedB });
    });

    it("INSERT denied", async () => {
      await assertInsertDenied(memberA, "setlist_songs", {
        setlist_id: IDS.setlists.publishedB,
        song_id: IDS.songs.B1,
        position: 99,
      });
    });

    it("UPDATE no-op", async () => {
      await assertUpdateNoOp(
        memberA,
        serviceClient,
        "setlist_songs",
        IDS.setlistSongs.publishedB,
        { position: 99 },
      );
    });

    it("DELETE no-op", async () => {
      await assertDeleteNoOp(memberA, serviceClient, "setlist_songs", IDS.setlistSongs.publishedB);
    });
  });

  // ── events ────────────────────────────────────────────────────────────────

  describe("events", () => {
    it("SELECT blocked", async () => {
      await assertSelectBlocked(memberA, "events", { church_group_id: IDS.churches.B });
    });

    it("INSERT denied", async () => {
      await assertInsertDenied(memberA, "events", {
        church_group_id: IDS.churches.B,
        service_week_id: IDS.serviceWeeks.B1,
        type: "rehearsal",
        name: "Evil",
        start_time: "2026-09-01T09:00:00Z",
        end_time: "2026-09-01T10:00:00Z",
      });
    });

    it("UPDATE no-op", async () => {
      await assertUpdateNoOp(memberA, serviceClient, "events", IDS.events.B, {
        name: "Hacked",
      });
    });

    it("DELETE no-op", async () => {
      await assertDeleteNoOp(memberA, serviceClient, "events", IDS.events.B);
    });
  });

  // ── invitations (also adminA — role-gated writes) ────────────────────────

  describe("invitations", () => {
    it("SELECT blocked", async () => {
      await assertSelectBlocked(memberA, "invitations", { church_group_id: IDS.churches.B });
    });

    it("INSERT denied (memberA)", async () => {
      await assertInsertDenied(memberA, "invitations", {
        church_group_id: IDS.churches.B,
        service_week_id: IDS.serviceWeeks.B1,
        user_id: IDS.users.memberB,
        status: "pending",
        response_token: "evil-tok",
      });
    });

    it("INSERT denied (adminA)", async () => {
      await assertInsertDenied(adminA, "invitations", {
        church_group_id: IDS.churches.B,
        service_week_id: IDS.serviceWeeks.B1,
        user_id: IDS.users.memberB,
        status: "pending",
        response_token: "evil-tok",
      });
    });

    it("UPDATE no-op (memberA)", async () => {
      await assertUpdateNoOp(memberA, serviceClient, "invitations", IDS.invitations.memberB, {
        status: "accepted",
      });
    });

    it("UPDATE no-op (adminA)", async () => {
      await assertUpdateNoOp(adminA, serviceClient, "invitations", IDS.invitations.memberB, {
        status: "accepted",
      });
    });

    it("DELETE no-op (memberA)", async () => {
      await assertDeleteNoOp(memberA, serviceClient, "invitations", IDS.invitations.memberB);
    });

    it("DELETE no-op (adminA)", async () => {
      await assertDeleteNoOp(adminA, serviceClient, "invitations", IDS.invitations.memberB);
    });
  });

  // ── event_attendees ───────────────────────────────────────────────────────

  describe("event_attendees", () => {
    it("SELECT blocked", async () => {
      await assertSelectBlocked(memberA, "event_attendees", { id: IDS.eventAttendees.B });
    });

    it("INSERT denied", async () => {
      await assertInsertDenied(memberA, "event_attendees", {
        event_id: IDS.events.B,
        user_id: IDS.users.memberB,
      });
    });

    it("UPDATE no-op", async () => {
      await assertUpdateNoOp(
        memberA,
        serviceClient,
        "event_attendees",
        IDS.eventAttendees.B,
        { user_id: IDS.users.memberA },
      );
    });

    it("DELETE no-op", async () => {
      await assertDeleteNoOp(memberA, serviceClient, "event_attendees", IDS.eventAttendees.B);
    });
  });

  // ── conflicts (also adminA — role-gated writes) ──────────────────────────

  describe("conflicts", () => {
    it("SELECT blocked", async () => {
      await assertSelectBlocked(memberA, "conflicts", { church_group_id: IDS.churches.B });
    });

    it("INSERT denied (memberA)", async () => {
      await assertInsertDenied(memberA, "conflicts", {
        church_group_id: IDS.churches.B,
        invitation_id: IDS.invitations.memberB,
      });
    });

    it("INSERT denied (adminA)", async () => {
      await assertInsertDenied(adminA, "conflicts", {
        church_group_id: IDS.churches.B,
        invitation_id: IDS.invitations.memberB,
      });
    });

    it("UPDATE no-op (memberA)", async () => {
      await assertUpdateNoOp(memberA, serviceClient, "conflicts", IDS.conflicts.B, {
        trigger_reason: "hacked",
      });
    });

    it("UPDATE no-op (adminA)", async () => {
      await assertUpdateNoOp(adminA, serviceClient, "conflicts", IDS.conflicts.B, {
        trigger_reason: "hacked",
      });
    });

    it("DELETE no-op (memberA)", async () => {
      await assertDeleteNoOp(memberA, serviceClient, "conflicts", IDS.conflicts.B);
    });

    it("DELETE no-op (adminA)", async () => {
      await assertDeleteNoOp(adminA, serviceClient, "conflicts", IDS.conflicts.B);
    });
  });

  // ── songs ─────────────────────────────────────────────────────────────────

  describe("songs", () => {
    it("SELECT blocked", async () => {
      await assertSelectBlocked(memberA, "songs", { church_group_id: IDS.churches.B });
    });

    it("INSERT denied", async () => {
      await assertInsertDenied(memberA, "songs", {
        church_group_id: IDS.churches.B,
        title: "Evil",
        artist: "Evil",
      });
    });

    it("UPDATE no-op", async () => {
      await assertUpdateNoOp(memberA, serviceClient, "songs", IDS.songs.B1, {
        title: "Hacked",
      });
    });

    it("DELETE no-op", async () => {
      await assertDeleteNoOp(memberA, serviceClient, "songs", IDS.songs.B1);
    });
  });

  // ── song_documents ────────────────────────────────────────────────────────

  describe("song_documents", () => {
    it("SELECT blocked", async () => {
      await assertSelectBlocked(memberA, "song_documents", { church_group_id: IDS.churches.B });
    });

    it("INSERT denied", async () => {
      await assertInsertDenied(memberA, "song_documents", {
        song_id: IDS.songs.B1,
        church_group_id: IDS.churches.B,
        name: "Evil",
        file_key: "x",
        file_type: "application/pdf",
        file_size_bytes: 1,
      });
    });

    it("UPDATE no-op", async () => {
      await assertUpdateNoOp(memberA, serviceClient, "song_documents", IDS.songDocuments.B, {
        name: "Hacked",
      });
    });

    it("DELETE no-op", async () => {
      await assertDeleteNoOp(memberA, serviceClient, "song_documents", IDS.songDocuments.B);
    });
  });

  // ── availability ──────────────────────────────────────────────────────────

  describe("availability", () => {
    it("SELECT blocked", async () => {
      await assertSelectBlocked(memberA, "availability", { church_group_id: IDS.churches.B });
    });

    it("INSERT denied", async () => {
      await assertInsertDenied(memberA, "availability", {
        user_id: IDS.users.memberB,
        church_group_id: IDS.churches.B,
        date: "2026-09-01",
        is_available: true,
      });
    });

    it("UPDATE no-op", async () => {
      await assertUpdateNoOp(memberA, serviceClient, "availability", IDS.availability.memberB, {
        is_available: false,
      });
    });

    it("DELETE no-op", async () => {
      await assertDeleteNoOp(memberA, serviceClient, "availability", IDS.availability.memberB);
    });
  });

  // ── notification_preferences ─────────────────────────────────────────────

  describe("notification_preferences", () => {
    it("SELECT blocked", async () => {
      await assertSelectBlocked(memberA, "notification_preferences", {
        id: IDS.notificationPreferences.memberB,
      });
    });

    it("INSERT denied", async () => {
      await assertInsertDenied(memberA, "notification_preferences", {
        user_id: IDS.users.memberB,
      });
    });

    it("UPDATE no-op", async () => {
      await assertUpdateNoOp(
        memberA,
        serviceClient,
        "notification_preferences",
        IDS.notificationPreferences.memberB,
        { invitation_sms: false },
      );
    });

    it("DELETE no-op", async () => {
      await assertDeleteNoOp(
        memberA,
        serviceClient,
        "notification_preferences",
        IDS.notificationPreferences.memberB,
      );
    });
  });

  // ── notifications ─────────────────────────────────────────────────────────

  describe("notifications", () => {
    it("SELECT blocked", async () => {
      await assertSelectBlocked(memberA, "notifications", { church_group_id: IDS.churches.B });
    });

    it("INSERT denied", async () => {
      await assertInsertDenied(memberA, "notifications", {
        church_group_id: IDS.churches.B,
        user_id: IDS.users.memberB,
        type: "set_invitation",
        title: "Evil",
      });
    });

    it("UPDATE no-op", async () => {
      await assertUpdateNoOp(memberA, serviceClient, "notifications", IDS.notifications.memberB, {
        is_read: true,
      });
    });

    it("DELETE no-op", async () => {
      await assertDeleteNoOp(memberA, serviceClient, "notifications", IDS.notifications.memberB);
    });
  });

  // ── google_calendar_tokens ────────────────────────────────────────────────

  describe("google_calendar_tokens", () => {
    it("SELECT blocked", async () => {
      await assertSelectBlocked(memberA, "google_calendar_tokens", {
        id: IDS.gCalTokens.memberB,
      });
    });

    it("INSERT denied", async () => {
      await assertInsertDenied(memberA, "google_calendar_tokens", {
        user_id: IDS.users.memberB,
        access_token_encrypted: "x",
        refresh_token_encrypted: "y",
        token_expiry: "2027-01-01T00:00:00Z",
        calendar_id: "evil@test.example",
        scope: "https://www.googleapis.com/auth/calendar",
      });
    });

    it("UPDATE no-op", async () => {
      await assertUpdateNoOp(
        memberA,
        serviceClient,
        "google_calendar_tokens",
        IDS.gCalTokens.memberB,
        { calendar_id: "hacked@test.example" },
      );
    });

    it("DELETE no-op", async () => {
      await assertDeleteNoOp(
        memberA,
        serviceClient,
        "google_calendar_tokens",
        IDS.gCalTokens.memberB,
      );
    });
  });

  // ── audit_logs (also adminA — role-gated writes) ─────────────────────────

  describe("audit_logs", () => {
    it("SELECT blocked", async () => {
      await assertSelectBlocked(memberA, "audit_logs", { church_group_id: IDS.churches.B });
    });

    it("INSERT denied (memberA)", async () => {
      await assertInsertDenied(memberA, "audit_logs", {
        church_group_id: IDS.churches.B,
        user_id: IDS.users.memberB,
        action: "evil",
        entity_type: "x",
        entity_id: IDS.churches.B,
      });
    });

    it("INSERT denied (adminA)", async () => {
      await assertInsertDenied(adminA, "audit_logs", {
        church_group_id: IDS.churches.B,
        user_id: IDS.users.memberB,
        action: "evil",
        entity_type: "x",
        entity_id: IDS.churches.B,
      });
    });

    it("UPDATE no-op (memberA)", async () => {
      await assertUpdateNoOp(memberA, serviceClient, "audit_logs", IDS.auditLogs.B, {
        action: "hacked",
      });
    });

    it("UPDATE no-op (adminA)", async () => {
      await assertUpdateNoOp(adminA, serviceClient, "audit_logs", IDS.auditLogs.B, {
        action: "hacked",
      });
    });

    it("DELETE no-op (memberA)", async () => {
      await assertDeleteNoOp(memberA, serviceClient, "audit_logs", IDS.auditLogs.B);
    });

    it("DELETE no-op (adminA)", async () => {
      await assertDeleteNoOp(adminA, serviceClient, "audit_logs", IDS.auditLogs.B);
    });
  });
});
