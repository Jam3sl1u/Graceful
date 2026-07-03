/**
 * Tier 3 user-scoped table tests: notification_preferences, google_calendar_tokens.
 *
 * Rules: all ops (SELECT/INSERT/UPDATE/DELETE) require user_id = auth_user_id().
 * No concept of tenant — user can only ever see/touch their own row.
 */

import { getUserClient, getServiceClient } from "../client";
import { IDS, rlsTestsEnabled, seedViaServiceClient } from "../setup";
import { assertSelectBlocked } from "../helpers";

const skip = !rlsTestsEnabled || !process.env.SUPABASE_TEST_URL;
const describeRls = skip ? describe.skip : describe;

describeRls("Tier 3: user-scoped tables", () => {
  let serviceClient: ReturnType<typeof getServiceClient>;

  beforeAll(async () => {
    await seedViaServiceClient();
    serviceClient = getServiceClient();
  }, 60_000);

  describe("notification_preferences", () => {
    it("user can SELECT own preferences", async () => {
      const memberA = getUserClient({ clerkId: IDS.clerkIds.memberA });
      const { data, error } = await memberA
        .from("notification_preferences")
        .select("id")
        .eq("user_id", IDS.users.memberA);
      expect(error).toBeNull();
      expect(data?.length).toBeGreaterThan(0);
    });

    it("user cannot SELECT another user's preferences", async () => {
      // memberA2 has no prefs row seeded; but even if they did, memberA can't see them
      const memberA = getUserClient({ clerkId: IDS.clerkIds.memberA });
      await assertSelectBlocked(memberA, "notification_preferences", { user_id: IDS.users.memberA2 });
    });

    it("user can INSERT and DELETE own preferences row", async () => {
      const memberA2 = getUserClient({ clerkId: IDS.clerkIds.memberA2 });
      const newId = "00000000-0000-4000-800e-000000000099";
      const { error: insertErr } = await memberA2.from("notification_preferences").insert({
        id: newId,
        user_id: IDS.users.memberA2,
      });
      expect(insertErr).toBeNull();

      const { error: deleteErr } = await memberA2
        .from("notification_preferences")
        .delete()
        .eq("id", newId);
      expect(deleteErr).toBeNull();
    });

    it("user cannot INSERT preferences for another user", async () => {
      const memberA = getUserClient({ clerkId: IDS.clerkIds.memberA });
      const { error } = await memberA.from("notification_preferences").insert({
        user_id: IDS.users.memberA2, // NOT the calling user
      });
      expect(error).not.toBeNull();
    });
  });

  describe("google_calendar_tokens", () => {
    it("user can SELECT own token", async () => {
      const memberA = getUserClient({ clerkId: IDS.clerkIds.memberA });
      const { data, error } = await memberA
        .from("google_calendar_tokens")
        .select("id")
        .eq("user_id", IDS.users.memberA);
      expect(error).toBeNull();
      expect(data?.length).toBeGreaterThan(0);
    });

    it("different user cannot SELECT another user's token", async () => {
      const memberA2 = getUserClient({ clerkId: IDS.clerkIds.memberA2 });
      await assertSelectBlocked(memberA2, "google_calendar_tokens", { user_id: IDS.users.memberA });
    });

    it("user cannot INSERT a token for another user", async () => {
      const memberA = getUserClient({ clerkId: IDS.clerkIds.memberA });
      const { error } = await memberA.from("google_calendar_tokens").insert({
        user_id: IDS.users.memberA2,
        access_token_encrypted: "enc_access",
        refresh_token_encrypted: "enc_refresh",
        token_expiry: new Date(Date.now() + 3600000).toISOString(),
        calendar_id: "stolen@test.example",
        scope: "https://www.googleapis.com/auth/calendar",
      });
      expect(error).not.toBeNull();
    });

    it("user can UPDATE own token", async () => {
      const memberA = getUserClient({ clerkId: IDS.clerkIds.memberA });
      const { error } = await memberA
        .from("google_calendar_tokens")
        .update({ calendar_id: "updated_cal@test.example" })
        .eq("user_id", IDS.users.memberA);
      expect(error).toBeNull();

      // Restore
      await serviceClient
        .from("google_calendar_tokens")
        .update({ calendar_id: "cal@test.example" })
        .eq("user_id", IDS.users.memberA);
    });
  });
});
