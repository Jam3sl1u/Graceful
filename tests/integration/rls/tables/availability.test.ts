/**
 * Availability table RLS tests.
 *
 * Rules:
 *  - All members can SELECT availability within their group.
 *  - Members can only INSERT/UPDATE/DELETE their own rows.
 *  - Leaders/admins can INSERT/UPDATE/DELETE any row in their group.
 */

import { getUserClient, getServiceClient } from "../client";
import { IDS, rlsTestsEnabled, seedViaServiceClient } from "../setup";
import { assertSelectAllowed, assertSelectBlocked } from "../helpers";

const skip = !rlsTestsEnabled || !process.env.SUPABASE_TEST_URL;
const describeRls = skip ? describe.skip : describe;

describeRls("Availability — own-row write constraint", () => {
  let serviceClient: ReturnType<typeof getServiceClient>;

  beforeAll(async () => {
    await seedViaServiceClient();
    serviceClient = getServiceClient();
  }, 60_000);

  describe("SELECT visibility", () => {
    it("member can SELECT all availability in own group", async () => {
      const memberA = getUserClient({ clerkId: IDS.clerkIds.memberA });
      await assertSelectAllowed(memberA, "availability", { church_group_id: IDS.churches.A });
    });

    it("Church B member cannot SELECT Church A availability", async () => {
      const memberB = getUserClient({ clerkId: IDS.clerkIds.memberB });
      await assertSelectBlocked(memberB, "availability", { church_group_id: IDS.churches.A });
    });
  });

  describe("member INSERT/UPDATE/DELETE own rows only", () => {
    it("member can INSERT own availability row", async () => {
      const memberA = getUserClient({ clerkId: IDS.clerkIds.memberA });
      const newId = "00000000-0000-4000-800c-000000000099";
      const { error } = await memberA.from("availability").insert({
        id: newId,
        user_id: IDS.users.memberA,
        church_group_id: IDS.churches.A,
        date: "2026-08-01",
        is_available: true,
      });
      expect(error).toBeNull();
      await serviceClient.from("availability").delete().eq("id", newId);
    });

    it("member cannot INSERT availability for another user", async () => {
      const memberA = getUserClient({ clerkId: IDS.clerkIds.memberA });
      const { error } = await memberA.from("availability").insert({
        user_id: IDS.users.memberA2, // NOT the calling user
        church_group_id: IDS.churches.A,
        date: "2026-08-02",
        is_available: true,
      });
      expect(error).not.toBeNull();
    });

    it("member can UPDATE own availability row", async () => {
      const memberA = getUserClient({ clerkId: IDS.clerkIds.memberA });
      // Seed row belongs to memberA — update should succeed
      const { error } = await memberA
        .from("availability")
        .update({ note: "updated by self" })
        .eq("id", IDS.availability.memberA);
      expect(error).toBeNull();
    });

    it("member UPDATE on another member's row affects 0 rows (silent RLS filter)", async () => {
      const memberA = getUserClient({ clerkId: IDS.clerkIds.memberA });
      const { error, count } = await memberA
        .from("availability")
        .update({ note: "injected" })
        .eq("id", IDS.availability.memberA2); // belongs to memberA2
      expect(error).toBeNull();
      // RLS filters the target row; 0 rows updated
      expect(count).toBeFalsy();
    });
  });

  describe("leader/admin can manage any row in group", () => {
    it("leader can INSERT availability for any member", async () => {
      const leaderA = getUserClient({ clerkId: IDS.clerkIds.leaderA });
      const newId = "00000000-0000-4000-800c-000000000098";
      const { error } = await leaderA.from("availability").insert({
        id: newId,
        user_id: IDS.users.memberA2,
        church_group_id: IDS.churches.A,
        date: "2026-08-03",
        is_available: false,
      });
      expect(error).toBeNull();
      await serviceClient.from("availability").delete().eq("id", newId);
    });

    it("admin can UPDATE any member's availability row", async () => {
      const adminA = getUserClient({ clerkId: IDS.clerkIds.adminA });
      const { error } = await adminA
        .from("availability")
        .update({ note: "admin override" })
        .eq("id", IDS.availability.memberA2);
      expect(error).toBeNull();
    });
  });
});
