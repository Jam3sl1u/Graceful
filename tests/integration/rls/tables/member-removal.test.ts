/**
 * remove_church_group_member RPC integration tests — Issue #28.
 *
 * No existing RPC in this repo (join_church_group, create_church_group,
 * write_audit_log) has an integration test yet; this is a deliberate first,
 * justified by BR-12 (last-admin guard) and PII anonymization both being
 * safety-critical and unverifiable by a mocked unit test — in particular the
 * TOCTOU race between two concurrent admin removals, which requires a real
 * transaction/locking engine to exercise meaningfully.
 */

import { getUserClient, getServiceClient } from "../client";
import { IDS, rlsTestsEnabled, seedViaServiceClient } from "../setup";

const skip = !rlsTestsEnabled || !process.env.SUPABASE_TEST_URL;
const describeRls = skip ? describe.skip : describe;

describeRls("remove_church_group_member RPC", () => {
  let serviceClient: ReturnType<typeof getServiceClient>;

  beforeAll(async () => {
    await seedViaServiceClient();
    serviceClient = getServiceClient();
  }, 60_000);

  it("admin removes a non-admin member: anonymizes PII, deletes future-only rows, preserves historical invitations, and 404s on re-removal", async () => {
    const adminA = getUserClient({ clerkId: IDS.clerkIds.adminA });

    const { data, error } = await adminA.rpc("remove_church_group_member", {
      p_target_user_id: IDS.users.memberA2,
    });
    expect(error).toBeNull();
    expect(data).toMatchObject({
      id: IDS.users.memberA2,
      name: "Deleted User",
      email: null,
      phone: null,
      role: "guest",
      clerk_id: `deleted-${IDS.users.memberA2}`,
    });
    expect(data?.anonymized_at).not.toBeNull();

    // future/PII-adjacent rows cleared
    const { data: profileRows } = await serviceClient
      .from("member_profiles")
      .select("id")
      .eq("user_id", IDS.users.memberA2);
    expect(profileRows).toHaveLength(0);

    const { data: instrumentRows } = await serviceClient
      .from("member_instruments")
      .select("id")
      .eq("id", IDS.memberInstruments.memberA2);
    expect(instrumentRows).toHaveLength(0);

    const { data: availabilityRows } = await serviceClient
      .from("availability")
      .select("id")
      .eq("user_id", IDS.users.memberA2);
    expect(availabilityRows).toHaveLength(0);

    // historical participation retained, still pointing at the same user id
    const { data: invitationRow } = await serviceClient
      .from("invitations")
      .select("id, user_id")
      .eq("id", IDS.invitations.memberA2)
      .single();
    expect(invitationRow).toMatchObject({
      id: IDS.invitations.memberA2,
      user_id: IDS.users.memberA2,
    });

    // re-removal of an already-anonymized member 404s, not a no-op 200
    const second = await adminA.rpc("remove_church_group_member", {
      p_target_user_id: IDS.users.memberA2,
    });
    expect(second.error?.message).toContain("NOT_FOUND");
  });

  it("BR-12: cannot remove the sole remaining admin", async () => {
    const adminA = getUserClient({ clerkId: IDS.clerkIds.adminA });

    const { data, error } = await adminA.rpc("remove_church_group_member", {
      p_target_user_id: IDS.users.adminA,
    });
    expect(data).toBeNull();
    expect(error?.message).toContain("LAST_ADMIN");

    const { data: unchanged } = await serviceClient
      .from("users")
      .select("role, anonymized_at")
      .eq("id", IDS.users.adminA)
      .single();
    expect(unchanged?.role).toBe("admin");
    expect(unchanged?.anonymized_at).toBeNull();
  });

  it("FORBIDDEN: non-admin caller cannot remove a member, even though RLS would permit set_leader to UPDATE users", async () => {
    const memberA = getUserClient({ clerkId: IDS.clerkIds.memberA });

    const { data, error } = await memberA.rpc("remove_church_group_member", {
      p_target_user_id: IDS.users.guestA,
    });
    expect(data).toBeNull();
    expect(error?.message).toContain("FORBIDDEN");

    const { data: unchanged } = await serviceClient
      .from("users")
      .select("role, anonymized_at")
      .eq("id", IDS.users.guestA)
      .single();
    expect(unchanged?.role).toBe("guest");
    expect(unchanged?.anonymized_at).toBeNull();
  });

  describe("concurrent BR-12 enforcement", () => {
    // Isolated church group with exactly 2 admins, so this test doesn't
    // interact with Church A/B's fixture admin counts.
    const TEMP_CHURCH_ID = "00000000-0000-4000-8099-000000000001";
    const TEMP_ADMIN_X = "00000000-0000-4000-8099-000000000002";
    const TEMP_ADMIN_Y = "00000000-0000-4000-8099-000000000003";
    const TEMP_CLERK_X = "tmp_concurrent_admin_x";
    const TEMP_CLERK_Y = "tmp_concurrent_admin_y";

    beforeAll(async () => {
      await serviceClient.from("church_groups").insert({
        id: TEMP_CHURCH_ID,
        name: "Temp Concurrency Church",
        timezone: "America/Chicago",
        invite_code: "TEMP-CONCUR-01",
      });
      await serviceClient.from("users").insert([
        {
          id: TEMP_ADMIN_X,
          clerk_id: TEMP_CLERK_X,
          church_group_id: TEMP_CHURCH_ID,
          role: "admin",
          name: "Temp Admin X",
        },
        {
          id: TEMP_ADMIN_Y,
          clerk_id: TEMP_CLERK_Y,
          church_group_id: TEMP_CHURCH_ID,
          role: "admin",
          name: "Temp Admin Y",
        },
      ]);
    });

    afterAll(async () => {
      // cascades the two temp users
      await serviceClient.from("church_groups").delete().eq("id", TEMP_CHURCH_ID);
    });

    it("exactly one of two concurrent removals in a 2-admin group succeeds; the other hits LAST_ADMIN", async () => {
      const clientX = getUserClient({ clerkId: TEMP_CLERK_X });
      const clientY = getUserClient({ clerkId: TEMP_CLERK_Y });

      const [xRemovesY, yRemovesX] = await Promise.all([
        clientX.rpc("remove_church_group_member", { p_target_user_id: TEMP_ADMIN_Y }),
        clientY.rpc("remove_church_group_member", { p_target_user_id: TEMP_ADMIN_X }),
      ]);

      const results = [xRemovesY, yRemovesX];
      const successes = results.filter((r) => r.error === null);
      const lastAdminFailures = results.filter((r) => r.error?.message?.includes("LAST_ADMIN"));

      expect(successes).toHaveLength(1);
      expect(lastAdminFailures).toHaveLength(1);

      // the group never dropped to zero admins
      const { data: remainingAdmins } = await serviceClient
        .from("users")
        .select("id")
        .eq("church_group_id", TEMP_CHURCH_ID)
        .eq("role", "admin")
        .is("anonymized_at", null);
      expect(remainingAdmins).toHaveLength(1);
    });
  });
});
