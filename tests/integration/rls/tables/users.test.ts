/**
 * Users table RLS tests.
 *
 * Rules:
 *  - SELECT: tenant member directory (all users in same church group).
 *  - INSERT: denied for authenticated (service role only).
 *  - UPDATE: members update own row; leaders/admins update any same-group row.
 *  - DELETE: leaders/admins only.
 *  - Cross-tenant: Church B cannot see Church A users.
 */

import { getUserClient, getServiceClient } from "../client";
import { IDS, rlsTestsEnabled, seedViaServiceClient } from "../setup";
import { assertSelectAllowed, assertSelectBlocked, assertInsertDenied } from "../helpers";

const skip = !rlsTestsEnabled || !process.env.SUPABASE_TEST_URL;
const describeRls = skip ? describe.skip : describe;

describeRls("Users table", () => {
  let serviceClient: ReturnType<typeof getServiceClient>;

  beforeAll(async () => {
    await seedViaServiceClient();
    serviceClient = getServiceClient();
  }, 60_000);

  describe("SELECT — member directory", () => {
    it("member can SELECT all users in own church group", async () => {
      const memberA = getUserClient({ clerkId: IDS.clerkIds.memberA });
      await assertSelectAllowed(memberA, "users", { church_group_id: IDS.churches.A });
    });

    it("Church B member cannot SELECT Church A users", async () => {
      const memberB = getUserClient({ clerkId: IDS.clerkIds.memberB });
      await assertSelectBlocked(memberB, "users", { church_group_id: IDS.churches.A });
    });
  });

  describe("INSERT — denied for authenticated", () => {
    it("member cannot INSERT a new user", async () => {
      const memberA = getUserClient({ clerkId: IDS.clerkIds.memberA });
      await assertInsertDenied(memberA, "users", {
        clerk_id: "injected_clerk_id",
        church_group_id: IDS.churches.A,
        role: "member",
        name: "Injected User",
      });
    });
  });

  describe("UPDATE", () => {
    it("member can UPDATE own row", async () => {
      const memberA = getUserClient({ clerkId: IDS.clerkIds.memberA });
      const { error } = await memberA
        .from("users")
        .update({ name: "Member A Updated" })
        .eq("id", IDS.users.memberA);
      expect(error).toBeNull();

      // Restore
      await serviceClient
        .from("users")
        .update({ name: "Member A" })
        .eq("id", IDS.users.memberA);
    });

    it("member UPDATE on another member's row silently affects 0 rows", async () => {
      const memberA = getUserClient({ clerkId: IDS.clerkIds.memberA });
      const { error } = await memberA
        .from("users")
        .update({ name: "Hijacked" })
        .eq("id", IDS.users.memberA2);
      expect(error).toBeNull();

      // Verify row was NOT mutated
      const { data } = await serviceClient
        .from("users")
        .select("name")
        .eq("id", IDS.users.memberA2)
        .single();
      expect(data?.name).toBe("Member A2");
    });

    it("admin can UPDATE another member's row", async () => {
      const adminA = getUserClient({ clerkId: IDS.clerkIds.adminA });
      const { error } = await adminA
        .from("users")
        .update({ name: "Member A2 (admin-edited)" })
        .eq("id", IDS.users.memberA2);
      expect(error).toBeNull();

      // Restore
      await serviceClient
        .from("users")
        .update({ name: "Member A2" })
        .eq("id", IDS.users.memberA2);
    });

    it("leader can UPDATE another member's row", async () => {
      const leaderA = getUserClient({ clerkId: IDS.clerkIds.leaderA });
      const { error } = await leaderA
        .from("users")
        .update({ name: "Member A2 (leader-edited)" })
        .eq("id", IDS.users.memberA2);
      expect(error).toBeNull();

      // Restore
      await serviceClient
        .from("users")
        .update({ name: "Member A2" })
        .eq("id", IDS.users.memberA2);
    });
  });

  describe("DELETE", () => {
    it("member cannot DELETE another user (silent: 0 rows affected)", async () => {
      const memberA = getUserClient({ clerkId: IDS.clerkIds.memberA });
      await memberA.from("users").delete().eq("id", IDS.users.guestA);

      // Verify guest_a still exists
      const { data } = await serviceClient
        .from("users")
        .select("id")
        .eq("id", IDS.users.guestA)
        .maybeSingle();
      expect(data).not.toBeNull();
    });

    it("admin can DELETE a same-group user (then restore)", async () => {
      const adminA = getUserClient({ clerkId: IDS.clerkIds.adminA });

      // Insert a throw-away user via service client, then delete via admin RLS
      const tmpId = "00000000-0000-4000-8001-000000000099";
      await serviceClient.from("users").insert({
        id: tmpId,
        clerk_id: "tmp_clerk_999",
        church_group_id: IDS.churches.A,
        role: "member",
        name: "Temporary User",
      });

      const { error } = await adminA.from("users").delete().eq("id", tmpId);
      expect(error).toBeNull();
    });
  });
});
