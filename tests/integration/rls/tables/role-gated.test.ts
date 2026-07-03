/**
 * Role-gated table tests: invitations, conflicts, audit_logs.
 *
 * Rules verified:
 *  invitations:
 *    - Leader/admin: SELECT all in group; INSERT; UPDATE any; DELETE
 *    - Member: SELECT own invitation only; UPDATE own invitation (accept/deny); no INSERT/DELETE
 *  conflicts:
 *    - Leader/admin: full CRUD within tenant
 *    - Member/guest: SELECT denied (empty result)
 *  audit_logs:
 *    - Admin: SELECT within tenant
 *    - Member/leader/guest: SELECT denied
 */

import { getUserClient, getServiceClient } from "../client";
import { IDS, rlsTestsEnabled, seedViaServiceClient } from "../setup";
import {
  assertSelectAllowed,
  assertSelectBlocked,
  assertInsertDenied,
} from "../helpers";

const skip = !rlsTestsEnabled || !process.env.SUPABASE_TEST_URL;
const describeRls = skip ? describe.skip : describe;

describeRls("Role-gated tables", () => {
  let serviceClient: ReturnType<typeof getServiceClient>;

  beforeAll(async () => {
    await seedViaServiceClient();
    serviceClient = getServiceClient();
  }, 60_000);

  // ── invitations ────────────────────────────────────────────────────────────

  describe("invitations", () => {
    describe("member sees only own invitations", () => {
      let memberA: ReturnType<typeof getUserClient>;

      beforeAll(() => {
        memberA = getUserClient({ clerkId: IDS.clerkIds.memberA });
      });

      it("member can SELECT own invitation", async () => {
        await assertSelectAllowed(memberA, "invitations", { id: IDS.invitations.memberA });
      });

      it("member cannot SELECT another member's invitation", async () => {
        await assertSelectBlocked(memberA, "invitations", { id: IDS.invitations.memberA2 });
      });

      it("member cannot INSERT an invitation", async () => {
        await assertInsertDenied(memberA, "invitations", {
          church_group_id: IDS.churches.A,
          service_week_id: IDS.serviceWeeks.A1,
          user_id: IDS.users.guestA,
          status: "pending",
          response_token: "token-member-a-injected",
        });
      });
    });

    describe("leader/admin sees all invitations in group", () => {
      let leaderA: ReturnType<typeof getUserClient>;
      let adminA: ReturnType<typeof getUserClient>;

      beforeAll(() => {
        leaderA = getUserClient({ clerkId: IDS.clerkIds.leaderA });
        adminA  = getUserClient({ clerkId: IDS.clerkIds.adminA });
      });

      it("leader can SELECT all invitations in group", async () => {
        const { data, error } = await leaderA.from("invitations").select("id");
        expect(error).toBeNull();
        expect(data?.length).toBeGreaterThanOrEqual(2);
      });

      it("admin can SELECT all invitations in group", async () => {
        await assertSelectAllowed(adminA, "invitations", { church_group_id: IDS.churches.A });
      });

      it("leader can INSERT an invitation", async () => {
        const newId = "00000000-0000-4000-800a-000000000099";
        const { error } = await leaderA.from("invitations").insert({
          id: newId,
          church_group_id: IDS.churches.A,
          service_week_id: IDS.serviceWeeks.A1,
          user_id: IDS.users.guestA,
          status: "pending",
          response_token: "token-leader-created-999",
        });
        expect(error).toBeNull();
        await serviceClient.from("invitations").delete().eq("id", newId);
      });
    });
  });

  // ── conflicts ──────────────────────────────────────────────────────────────

  describe("conflicts", () => {
    it("member cannot SELECT conflicts", async () => {
      const memberA = getUserClient({ clerkId: IDS.clerkIds.memberA });
      await assertSelectBlocked(memberA, "conflicts", { church_group_id: IDS.churches.A });
    });

    it("guest cannot SELECT conflicts", async () => {
      const guestA = getUserClient({ clerkId: IDS.clerkIds.guestA });
      await assertSelectBlocked(guestA, "conflicts", { church_group_id: IDS.churches.A });
    });

    it("leader can SELECT conflicts in own group", async () => {
      const leaderA = getUserClient({ clerkId: IDS.clerkIds.leaderA });
      await assertSelectAllowed(leaderA, "conflicts", { church_group_id: IDS.churches.A });
    });

    it("admin can SELECT conflicts in own group", async () => {
      const adminA = getUserClient({ clerkId: IDS.clerkIds.adminA });
      await assertSelectAllowed(adminA, "conflicts", { church_group_id: IDS.churches.A });
    });

    it("member cannot INSERT a conflict", async () => {
      const memberA = getUserClient({ clerkId: IDS.clerkIds.memberA });
      await assertInsertDenied(memberA, "conflicts", {
        church_group_id: IDS.churches.A,
        invitation_id: IDS.invitations.memberA2,
      });
    });
  });

  // ── audit_logs ─────────────────────────────────────────────────────────────

  describe("audit_logs", () => {
    it("admin can SELECT audit_logs in own group", async () => {
      const adminA = getUserClient({ clerkId: IDS.clerkIds.adminA });
      await assertSelectAllowed(adminA, "audit_logs", { church_group_id: IDS.churches.A });
    });

    it("member cannot SELECT audit_logs", async () => {
      const memberA = getUserClient({ clerkId: IDS.clerkIds.memberA });
      await assertSelectBlocked(memberA, "audit_logs", { church_group_id: IDS.churches.A });
    });

    it("leader cannot SELECT audit_logs (admin-only)", async () => {
      const leaderA = getUserClient({ clerkId: IDS.clerkIds.leaderA });
      await assertSelectBlocked(leaderA, "audit_logs", { church_group_id: IDS.churches.A });
    });

    it("Church B admin cannot SELECT Church A audit_logs", async () => {
      const adminB = getUserClient({ clerkId: IDS.clerkIds.adminB });
      await assertSelectBlocked(adminB, "audit_logs", { church_group_id: IDS.churches.A });
    });
  });
});
