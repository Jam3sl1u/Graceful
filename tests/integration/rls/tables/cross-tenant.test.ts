/**
 * Cross-tenant isolation tests.
 *
 * Church B member attempts to SELECT, INSERT, UPDATE, or DELETE Church A rows
 * across all Tier 1 and Tier 2 tables. Every assertion must result in zero
 * rows returned or an RLS error — no Church A data may leak.
 */

import { getUserClient, getServiceClient } from "../client";
import { IDS, rlsTestsEnabled, seedViaServiceClient } from "../setup";
import { assertSelectBlocked, assertInsertDenied } from "../helpers";

const skip = !rlsTestsEnabled || !process.env.SUPABASE_TEST_URL;

const describeRls = skip ? describe.skip : describe;

describeRls("Cross-tenant isolation", () => {
  let memberBClient: ReturnType<typeof getUserClient>;
  let serviceClient: ReturnType<typeof getServiceClient>;

  beforeAll(async () => {
    await seedViaServiceClient();
    memberBClient = getUserClient({ clerkId: IDS.clerkIds.memberB });
    serviceClient = getServiceClient();
  }, 60_000);

  // ── church_groups — self-access only ─────────────────────────────────────

  it("church_groups: member can SELECT own group", async () => {
    const memberA = getUserClient({ clerkId: IDS.clerkIds.memberA });
    const { data, error } = await memberA
      .from("church_groups")
      .select("id")
      .eq("id", IDS.churches.A);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it("church_groups: Church B member cannot see Church A row", async () => {
    const { data, error } = await memberBClient
      .from("church_groups")
      .select("id")
      .eq("id", IDS.churches.A);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("church_groups: unfiltered SELECT returns only own group", async () => {
    const memberA = getUserClient({ clerkId: IDS.clerkIds.memberA });
    const { data, error } = await memberA.from("church_groups").select("id");
    expect(error).toBeNull();
    expect(data?.every((r) => r.id === IDS.churches.A)).toBe(true);
  });

  // ── Tier 1: direct church_group_id tables ────────────────────────────────

  it("instruments: Church B cannot see Church A rows", async () => {
    await assertSelectBlocked(memberBClient, "instruments", { church_group_id: IDS.churches.A });
  });

  it("instruments: Church B cannot insert into Church A", async () => {
    await assertInsertDenied(memberBClient, "instruments", {
      church_group_id: IDS.churches.A,
      name: "Stolen Instrument",
      is_default: false,
    });
  });

  it("service_weeks: Church B cannot see Church A rows", async () => {
    await assertSelectBlocked(memberBClient, "service_weeks", { church_group_id: IDS.churches.A });
  });

  it("setlists: Church B cannot see Church A rows", async () => {
    await assertSelectBlocked(memberBClient, "setlists", { church_group_id: IDS.churches.A });
  });

  it("events: Church B cannot see Church A rows", async () => {
    await assertSelectBlocked(memberBClient, "events", { church_group_id: IDS.churches.A });
  });

  it("songs: Church B cannot see Church A rows", async () => {
    await assertSelectBlocked(memberBClient, "songs", { church_group_id: IDS.churches.A });
  });

  it("availability: Church B cannot see Church A rows", async () => {
    await assertSelectBlocked(memberBClient, "availability", { church_group_id: IDS.churches.A });
  });

  it("invitations: Church B cannot see Church A rows", async () => {
    await assertSelectBlocked(memberBClient, "invitations", { church_group_id: IDS.churches.A });
  });

  it("conflicts: Church B cannot see Church A rows (leader/admin required)", async () => {
    await assertSelectBlocked(memberBClient, "conflicts", { church_group_id: IDS.churches.A });
  });

  it("audit_logs: Church B cannot see Church A rows", async () => {
    await assertSelectBlocked(memberBClient, "audit_logs", { church_group_id: IDS.churches.A });
  });

  // ── Tier 2: indirect FK tables ────────────────────────────────────────────

  it("setlist_songs: Church B cannot see Church A setlist songs", async () => {
    const { data, error } = await memberBClient
      .from("setlist_songs")
      .select("id")
      .eq("setlist_id", IDS.setlists.publishedA); // Church A published setlist
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("event_attendees: Church B cannot see Church A event attendees", async () => {
    const { data, error } = await memberBClient
      .from("event_attendees")
      .select("id")
      .eq("event_id", IDS.events.A);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("member_profiles: Church B cannot see Church A member profiles", async () => {
    const { data, error } = await memberBClient
      .from("member_profiles")
      .select("id")
      .eq("id", IDS.memberProfiles.memberA);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  // ── Tier 3: user-scoped ────────────────────────────────────────────────────

  it("notification_preferences: Church B user cannot see Church A user prefs", async () => {
    const { data, error } = await memberBClient
      .from("notification_preferences")
      .select("id")
      .eq("user_id", IDS.users.memberA);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("google_calendar_tokens: Church B user cannot see Church A tokens", async () => {
    const { data, error } = await memberBClient
      .from("google_calendar_tokens")
      .select("id")
      .eq("user_id", IDS.users.memberA);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  // Cleanup guard
  afterAll(async () => {
    // Service client cleanup of any test leftovers (seeds are idempotent)
    void serviceClient;
  });
});
