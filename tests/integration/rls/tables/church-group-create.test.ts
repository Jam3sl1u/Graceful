/**
 * create_church_group RPC integration test — Issue #24 regression coverage.
 *
 * The unit test for PUT /api/church-group mocks the RPC entirely, so it
 * cannot catch a wrong default-instrument seed list — that bug shipped
 * silently (see 20260706000001's array, missing "Other", fixed forward by
 * 20260710000002). This exercises the real SQL function against a live
 * Postgres instance instead.
 */

import { getUserClient, getServiceClient } from "../client";
import { rlsTestsEnabled } from "../setup";

const skip = !rlsTestsEnabled || !process.env.SUPABASE_TEST_URL;
const describeRls = skip ? describe.skip : describe;

const EXPECTED_DEFAULT_INSTRUMENTS = [
  "Acoustic guitar",
  "Electric guitar",
  "Bass guitar",
  "Piano/keyboard",
  "Violin",
  "Vocalists",
  "Drums",
  "Cajon",
  "Other",
].sort();

describeRls("create_church_group RPC", () => {
  const NEW_CLERK_ID = "tmp_new_group_creator";
  let serviceClient: ReturnType<typeof getServiceClient>;
  let createdGroupId: string | null = null;

  beforeAll(() => {
    serviceClient = getServiceClient();
  });

  afterAll(async () => {
    if (createdGroupId) {
      // cascades the creator user + seeded instruments
      await serviceClient.from("church_groups").delete().eq("id", createdGroupId);
    }
  });

  it("seeds exactly the 9 PRD-specified default instruments, including 'Other'", async () => {
    const creator = getUserClient({ clerkId: NEW_CLERK_ID });

    const { data: group, error } = await creator.rpc("create_church_group", {
      p_name: "Regression Test Church",
      p_timezone: "America/Chicago",
      p_denomination: null,
      p_logo_url: null,
      p_creator_name: "Test Admin",
      p_creator_email: null,
    });
    expect(error).toBeNull();
    expect(group?.id).toBeTruthy();
    createdGroupId = group!.id;

    const { data: instruments, error: instrumentsError } = await serviceClient
      .from("instruments")
      .select("name, is_default")
      .eq("church_group_id", createdGroupId);

    expect(instrumentsError).toBeNull();
    expect(instruments).toHaveLength(9);
    expect(instruments?.every((i: { is_default: boolean }) => i.is_default)).toBe(true);
    expect((instruments ?? []).map((i: { name: string }) => i.name).sort()).toEqual(
      EXPECTED_DEFAULT_INSTRUMENTS,
    );
  });
});
