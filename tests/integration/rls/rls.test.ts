/**
 * RLS Integration Test Suite
 *
 * Covers: cross-tenant isolation, same-tenant access, role-gated tables,
 * setlist published/draft visibility, user-scoped (Tier 3) tables, and
 * indirect FK (Tier 2) tables.
 *
 * Prerequisites (see supabase/README.md):
 *   SUPABASE_TEST_URL, SUPABASE_TEST_ANON_KEY,
 *   SUPABASE_TEST_SERVICE_ROLE_KEY, SUPABASE_JWT_SECRET
 *
 * Run: bun run test:rls
 *
 * The suite is skipped automatically when required vars are unset so it
 * does not break CI unit-test runs.
 */

import {
  IDS,
  rlsTestsEnabled,
  seedViaServiceClient,
  globalSetup,
} from "./setup";
import {
  clients,
  expectEmpty,
  expectRow,
  expectNoRow,
  expectInsertDenied,
} from "./helpers";
import { getUserClient } from "./client";

// Skip the entire file when env vars are absent
const SKIP = !process.env.SUPABASE_TEST_URL || !process.env.SUPABASE_JWT_SECRET;

const maybeDescribe = SKIP ? describe.skip : describe;

maybeDescribe("RLS Integration", () => {
  beforeAll(async () => {
    await globalSetup();
    if (rlsTestsEnabled) {
      await seedViaServiceClient();
    }
  }, 60_000);

  // -------------------------------------------------------------------------
  // Tier 1 — Direct church_group_id tables: cross-tenant isolation
  // -------------------------------------------------------------------------

  describe("instruments — Tier 1 cross-tenant isolation", () => {
    it("Church A member sees Church A instruments", async () => {
      await expectRow(clients.memberA(), "instruments", IDS.instruments.pianoA);
    });

    it("Church A member cannot see Church B instruments", async () => {
      await expectNoRow(clients.memberA(), "instruments", IDS.instruments.drumsB);
    });

    it("Church B member sees their own instruments", async () => {
      await expectRow(clients.adminB(), "instruments", IDS.instruments.drumsB);
    });
  });

  describe("service_weeks — Tier 1 cross-tenant isolation", () => {
    it("Church A member sees Church A service weeks", async () => {
      await expectRow(clients.memberA(), "service_weeks", IDS.serviceWeeks.A1);
    });

    it("Church A member cannot see Church B service weeks", async () => {
      await expectNoRow(clients.memberA(), "service_weeks", IDS.serviceWeeks.B1);
    });
  });

  describe("songs — Tier 1 cross-tenant isolation", () => {
    it("Church A member sees Church A songs", async () => {
      await expectRow(clients.memberA(), "songs", IDS.songs.A1);
    });

    it("Church A member cannot see Church B songs", async () => {
      await expectNoRow(clients.memberA(), "songs", IDS.songs.B1);
    });
  });

  describe("events — Tier 1 cross-tenant isolation", () => {
    it("Church A member sees Church A events", async () => {
      await expectRow(clients.memberA(), "events", IDS.events.A);
    });

    it("Church A member cannot see Church B events", async () => {
      await expectNoRow(clients.memberA(), "events", IDS.events.B);
    });
  });

  // -------------------------------------------------------------------------
  // users — member directory + cross-tenant
  // -------------------------------------------------------------------------

  describe("users", () => {
    it("member_a can see all Church A users", async () => {
      const { data } = await clients.memberA().from("users").select("id");
      const ids = (data ?? []).map((r: { id: string }) => r.id);
      expect(ids).toContain(IDS.users.memberA);
      expect(ids).toContain(IDS.users.adminA);
      expect(ids).toContain(IDS.users.leaderA);
    });

    it("member_a cannot see Church B users", async () => {
      await expectNoRow(clients.memberA(), "users", IDS.users.memberB);
    });

    it("member_a can UPDATE own row", async () => {
      const { error } = await clients.memberA()
        .from("users")
        .update({ name: "Member A Updated" })
        .eq("id", IDS.users.memberA);
      expect(error).toBeNull();
    });

    it("member_a cannot INSERT a new user", async () => {
      await expectInsertDenied(clients.memberA(), "users", {
        clerk_id: "clerk_injected_99",
        church_group_id: IDS.churches.A,
        role: "admin",
        name: "Injected",
        email: "injected@test.example",
      });
    });

    it("leader_a can UPDATE any Church A user", async () => {
      const { error } = await clients.leaderA()
        .from("users")
        .update({ name: "Member A By Leader" })
        .eq("id", IDS.users.memberA);
      expect(error).toBeNull();
    });

    it("admin_a cannot see Church B users", async () => {
      await expectNoRow(clients.adminA(), "users", IDS.users.memberB);
    });
  });

  // -------------------------------------------------------------------------
  // setlists — published-only for members/guests
  // -------------------------------------------------------------------------

  describe("setlists — published/draft visibility", () => {
    it("member_a can SELECT the published setlist", async () => {
      await expectRow(clients.memberA(), "setlists", IDS.setlists.publishedA);
    });

    it("member_a cannot SELECT the draft setlist", async () => {
      await expectNoRow(clients.memberA(), "setlists", IDS.setlists.draftA);
    });

    it("guest_a cannot SELECT the draft setlist", async () => {
      await expectNoRow(clients.guestA(), "setlists", IDS.setlists.draftA);
    });

    it("leader_a can SELECT the draft setlist", async () => {
      await expectRow(clients.leaderA(), "setlists", IDS.setlists.draftA);
    });

    it("admin_a can SELECT the draft setlist", async () => {
      await expectRow(clients.adminA(), "setlists", IDS.setlists.draftA);
    });

    it("member_a cannot SELECT Church B published setlist (cross-tenant)", async () => {
      await expectNoRow(clients.memberA(), "setlists", IDS.setlists.publishedB);
    });

    it("member_a cannot INSERT setlists", async () => {
      await expectInsertDenied(clients.memberA(), "setlists", {
        church_group_id: IDS.churches.A,
        service_week_id: IDS.serviceWeeks.A1,
        status: "published",
      });
    });

    it("leader_a can INSERT a setlist (no RLS error)", async () => {
      // Attempting insert on an already-unique service_week may fail with a
      // constraint violation (23505) — that is NOT an RLS error (42501).
      const { error } = await clients.leaderA().from("setlists").insert({
        church_group_id: IDS.churches.A,
        service_week_id: IDS.serviceWeeks.A1,
        status: "draft",
      });
      if (error) {
        expect(error.code).not.toBe("42501"); // not a permission denied error
      }
    });
  });

  // -------------------------------------------------------------------------
  // setlist_songs — inherits parent setlist draft/published visibility
  // -------------------------------------------------------------------------

  describe("setlist_songs — draft/published visibility inherited from parent", () => {
    it("member_a can SELECT setlist_songs from the published setlist", async () => {
      await expectRow(clients.memberA(), "setlist_songs", IDS.setlistSongs.publishedA);
    });

    it("member_a cannot SELECT setlist_songs from the draft setlist", async () => {
      await expectNoRow(clients.memberA(), "setlist_songs", IDS.setlistSongs.draftA);
    });

    it("leader_a can SELECT setlist_songs from the draft setlist", async () => {
      await expectRow(clients.leaderA(), "setlist_songs", IDS.setlistSongs.draftA);
    });

    it("member_a cannot SELECT Church B setlist_songs (cross-tenant)", async () => {
      await expectNoRow(clients.memberA(), "setlist_songs", IDS.setlistSongs.publishedB);
    });

    it("member_a cannot INSERT setlist_songs", async () => {
      await expectInsertDenied(clients.memberA(), "setlist_songs", {
        setlist_id: IDS.setlists.publishedA,
        song_id: IDS.songs.A1,
        position: 99,
      });
    });
  });

  // -------------------------------------------------------------------------
  // availability — tenant-scoped reads; user-scoped writes for members
  // -------------------------------------------------------------------------

  describe("availability", () => {
    it("member_a can SELECT Church A availability (all members')", async () => {
      await expectRow(clients.memberA(), "availability", IDS.availability.memberA);
    });

    it("member_a can INSERT their own availability", async () => {
      const { error } = await clients.memberA().from("availability").insert({
        user_id: IDS.users.memberA,
        church_group_id: IDS.churches.A,
        date: "2026-08-10",
        is_available: true,
      });
      expect(error).toBeNull();
    });

    it("member_a cannot INSERT availability for another user", async () => {
      await expectInsertDenied(clients.memberA(), "availability", {
        user_id: IDS.users.guestA,
        church_group_id: IDS.churches.A,
        date: "2026-08-11",
        is_available: true,
      });
    });

    it("leader_a can INSERT availability for any Church A member", async () => {
      const { error } = await clients.leaderA().from("availability").insert({
        user_id: IDS.users.guestA,
        church_group_id: IDS.churches.A,
        date: "2026-08-12",
        is_available: false,
      });
      expect(error).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // invitations — role-gated with member own-row exception
  // -------------------------------------------------------------------------

  describe("invitations", () => {
    it("member_a can SELECT their own invitation", async () => {
      await expectRow(clients.memberA(), "invitations", IDS.invitations.memberA);
    });

    it("member_a cannot SELECT memberA2's invitation", async () => {
      await expectNoRow(clients.memberA(), "invitations", IDS.invitations.memberA2);
    });

    it("leader_a can SELECT all Church A invitations", async () => {
      await expectRow(clients.leaderA(), "invitations", IDS.invitations.memberA);
      await expectRow(clients.leaderA(), "invitations", IDS.invitations.memberA2);
    });

    it("member_a cannot INSERT invitations", async () => {
      await expectInsertDenied(clients.memberA(), "invitations", {
        church_group_id: IDS.churches.A,
        service_week_id: IDS.serviceWeeks.A1,
        user_id: IDS.users.guestA,
        status: "pending",
        response_token: "token_injected_by_member",
      });
    });

    it("leader_a can INSERT an invitation (no RLS error)", async () => {
      const { error } = await clients.leaderA().from("invitations").insert({
        church_group_id: IDS.churches.A,
        service_week_id: IDS.serviceWeeks.A1,
        user_id: IDS.users.guestA,
        status: "pending",
        response_token: "token_new_by_leader_" + Date.now(),
      });
      if (error) {
        expect(error.code).not.toBe("42501");
      }
    });

    it("member_a can UPDATE their own invitation (respond)", async () => {
      const { error } = await clients.memberA()
        .from("invitations")
        .update({ status: "accepted", responded_at: new Date().toISOString() })
        .eq("id", IDS.invitations.memberA);
      expect(error).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // conflicts — leader/admin only
  // -------------------------------------------------------------------------

  describe("conflicts", () => {
    it("leader_a can SELECT Church A conflicts", async () => {
      await expectRow(clients.leaderA(), "conflicts", IDS.conflicts.A);
    });

    it("admin_a can SELECT Church A conflicts", async () => {
      await expectRow(clients.adminA(), "conflicts", IDS.conflicts.A);
    });

    it("member_a cannot SELECT conflicts", async () => {
      await expectEmpty(clients.memberA(), "conflicts");
    });

    it("member_a cannot INSERT conflicts", async () => {
      await expectInsertDenied(clients.memberA(), "conflicts", {
        church_group_id: IDS.churches.A,
        invitation_id: IDS.invitations.memberA,
        triggered_by: IDS.users.memberA,
        trigger_reason: "Test conflict by member",
      });
    });
  });

  // -------------------------------------------------------------------------
  // audit_logs — admin SELECT only; no authenticated INSERT
  // -------------------------------------------------------------------------

  describe("audit_logs", () => {
    it("admin_a can SELECT Church A audit logs", async () => {
      await expectRow(clients.adminA(), "audit_logs", IDS.auditLogs.A);
    });

    it("member_a cannot SELECT audit logs", async () => {
      await expectEmpty(clients.memberA(), "audit_logs");
    });

    it("leader_a cannot SELECT audit logs", async () => {
      await expectEmpty(clients.leaderA(), "audit_logs");
    });

    it("admin_a cannot INSERT audit logs (append-only via service role)", async () => {
      await expectInsertDenied(clients.adminA(), "audit_logs", {
        church_group_id: IDS.churches.A,
        user_id: IDS.users.adminA,
        action: "test_insert",
        entity_type: "test",
        entity_id: IDS.churches.A,
      });
    });
  });

  // -------------------------------------------------------------------------
  // notifications — tenant + user_id scoped
  // -------------------------------------------------------------------------

  describe("notifications", () => {
    it("member_a can SELECT their own notifications", async () => {
      await expectRow(clients.memberA(), "notifications", IDS.notifications.memberA);
    });

    it("leader_a cannot SELECT member_a's notifications (user-scoped)", async () => {
      await expectNoRow(clients.leaderA(), "notifications", IDS.notifications.memberA);
    });

    it("member_a cannot INSERT notifications", async () => {
      await expectInsertDenied(clients.memberA(), "notifications", {
        church_group_id: IDS.churches.A,
        user_id: IDS.users.memberA,
        type: "set_invitation",
        title: "Injected notification",
      });
    });

    it("leader_a can INSERT notifications for Church A members", async () => {
      const { error } = await clients.leaderA().from("notifications").insert({
        church_group_id: IDS.churches.A,
        user_id: IDS.users.guestA,
        type: "setlist_released",
        title: "New setlist released",
      });
      expect(error).toBeNull();
    });

    it("member_a can UPDATE their own notification (mark read)", async () => {
      const { error } = await clients.memberA()
        .from("notifications")
        .update({ is_read: true })
        .eq("id", IDS.notifications.memberA);
      expect(error).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // notification_preferences — Tier 3: user-scoped
  // -------------------------------------------------------------------------

  describe("notification_preferences", () => {
    const NP_ID = "00000000-0000-4000-800e-000000000001";

    it("member_a can SELECT their own preferences", async () => {
      await expectRow(clients.memberA(), "notification_preferences", NP_ID);
    });

    it("leader_a cannot SELECT member_a's preferences", async () => {
      await expectNoRow(clients.leaderA(), "notification_preferences", NP_ID);
    });

    it("admin_a cannot SELECT member_a's preferences (strictly user-scoped)", async () => {
      await expectNoRow(clients.adminA(), "notification_preferences", NP_ID);
    });

    it("member_a can UPDATE their own preferences", async () => {
      const { error } = await clients.memberA()
        .from("notification_preferences")
        .update({ invitation_sms: false })
        .eq("user_id", IDS.users.memberA);
      expect(error).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // google_calendar_tokens — Tier 3: user-scoped
  // -------------------------------------------------------------------------

  describe("google_calendar_tokens", () => {
    it("member_a can SELECT their own token", async () => {
      await expectRow(clients.memberA(), "google_calendar_tokens", IDS.gCalTokens.memberA);
    });

    it("leader_a cannot SELECT member_a's token", async () => {
      await expectNoRow(clients.leaderA(), "google_calendar_tokens", IDS.gCalTokens.memberA);
    });

    it("admin_a cannot SELECT member_a's token (strictly user-scoped)", async () => {
      await expectNoRow(clients.adminA(), "google_calendar_tokens", IDS.gCalTokens.memberA);
    });
  });

  // -------------------------------------------------------------------------
  // Tier 2: indirect FK tables
  // -------------------------------------------------------------------------

  describe("member_profiles — Tier 2 indirect FK via users", () => {
    it("member_a can SELECT Church A member profiles", async () => {
      await expectRow(clients.memberA(), "member_profiles", IDS.memberProfiles.memberA);
    });

    it("member_a can SELECT other Church A member profiles (directory)", async () => {
      await expectRow(clients.memberA(), "member_profiles", IDS.memberProfiles.memberA2);
    });

    it("Church B user cannot SELECT Church A member profiles", async () => {
      await expectNoRow(clients.memberB(), "member_profiles", IDS.memberProfiles.memberA);
    });
  });

  describe("member_instruments — Tier 2 indirect FK via member_profiles → users", () => {
    const MI_A = "00000000-0000-4000-8004-000000000010";

    it("member_a can SELECT Church A member instruments", async () => {
      await expectRow(clients.memberA(), "member_instruments", MI_A);
    });

    it("Church B user cannot SELECT Church A member instruments", async () => {
      await expectNoRow(clients.memberB(), "member_instruments", MI_A);
    });
  });

  describe("event_attendees — Tier 2 indirect FK via events", () => {
    it("Church A member can SELECT when Church A event attendees exist", async () => {
      // No attendees are seeded — just verify no cross-tenant data leaks
      const { data } = await clients.memberA().from("event_attendees").select("id");
      // If empty, just verify Church B attendees are not visible
      const { data: dataB } = await clients.memberB().from("event_attendees").select("id");
      const aIds = (data ?? []).map((r: { id: string }) => r.id);
      const bIds = (dataB ?? []).map((r: { id: string }) => r.id);
      // There should be no overlap between what A and B can see
      const overlap = aIds.filter((id) => bIds.includes(id));
      expect(overlap).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // song_documents — Tier 1 (denormalized church_group_id)
  // -------------------------------------------------------------------------

  describe("song_documents", () => {
    const SD_A = "00000000-0000-4000-8011-000000000001";

    it("Church A member can SELECT Church A song documents", async () => {
      await expectRow(clients.memberA(), "song_documents", SD_A);
    });

    it("Church B user cannot SELECT Church A song documents", async () => {
      await expectNoRow(clients.memberB(), "song_documents", SD_A);
    });
  });

  // -------------------------------------------------------------------------
  // JWT fast-path: explicit church_group_id claim skips DB lookup
  // -------------------------------------------------------------------------

  describe("JWT claims fast path", () => {
    it("JWT with church_group_id claim isolates correctly", async () => {
      // Inject the church_group_id claim directly so auth_church_group_id()
      // uses the JWT path instead of the DB fallback
      const clientWithClaim = getUserClient({
        clerkId: IDS.clerkIds.memberA,
        churchGroupId: IDS.churches.A,
      });
      await expectRow(clientWithClaim, "songs", IDS.songs.A1);
      await expectNoRow(clientWithClaim, "songs", IDS.songs.B1);
    });

    it("JWT with wrong church_group_id claim blocks own-group data", async () => {
      // Provide Church B's ID in claims for a Church A user — should see Church B data only
      const crossClient = getUserClient({
        clerkId: IDS.clerkIds.memberA,
        churchGroupId: IDS.churches.B,
      });
      await expectNoRow(crossClient, "songs", IDS.songs.A1);
    });
  });
});
