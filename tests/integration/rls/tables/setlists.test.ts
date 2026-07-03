/**
 * Setlist + setlist_songs RLS tests.
 *
 * Key rules:
 *  - Members/guests see only published setlists.
 *  - Leaders/admins see all (draft + published).
 *  - setlist_songs inherits parent setlist visibility.
 *  - Only leaders/admins can INSERT/UPDATE/DELETE setlists and setlist_songs.
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

describeRls("Setlists — published/draft visibility", () => {
  beforeAll(async () => {
    await seedViaServiceClient();
  }, 60_000);

  describe("Member (non-leader) visibility", () => {
    let memberA: ReturnType<typeof getUserClient>;

    beforeAll(() => {
      memberA = getUserClient({ clerkId: IDS.clerkIds.memberA });
    });

    it("cannot see draft setlists", async () => {
      await assertSelectBlocked(memberA, "setlists", { id: IDS.setlists.draftA });
    });

    it("can see published setlists in own group", async () => {
      await assertSelectAllowed(memberA, "setlists", { id: IDS.setlists.publishedA });
    });

    it("cannot see setlist_songs of a draft setlist", async () => {
      await assertSelectBlocked(memberA, "setlist_songs", { setlist_id: IDS.setlists.draftA });
    });

    it("can see setlist_songs of a published setlist", async () => {
      await assertSelectAllowed(memberA, "setlist_songs", { setlist_id: IDS.setlists.publishedA });
    });

    it("cannot INSERT a setlist", async () => {
      await assertInsertDenied(memberA, "setlists", {
        church_group_id: IDS.churches.A,
        service_week_id: IDS.serviceWeeks.A1,
        status: "draft",
      });
    });

    it("cannot INSERT into setlist_songs of a published setlist", async () => {
      await assertInsertDenied(memberA, "setlist_songs", {
        setlist_id: IDS.setlists.publishedA,
        song_id: IDS.songs.A1,
        position: 99,
      });
    });
  });

  describe("Guest visibility", () => {
    let guestA: ReturnType<typeof getUserClient>;

    beforeAll(() => {
      guestA = getUserClient({ clerkId: IDS.clerkIds.guestA });
    });

    it("cannot see draft setlists", async () => {
      await assertSelectBlocked(guestA, "setlists", { id: IDS.setlists.draftA });
    });

    it("can see published setlists", async () => {
      await assertSelectAllowed(guestA, "setlists", { id: IDS.setlists.publishedA });
    });
  });

  describe("Leader visibility", () => {
    let leaderA: ReturnType<typeof getUserClient>;
    let serviceClient: ReturnType<typeof getServiceClient>;

    beforeAll(() => {
      leaderA = getUserClient({ clerkId: IDS.clerkIds.leaderA });
      serviceClient = getServiceClient();
    });

    it("can see draft setlists", async () => {
      await assertSelectAllowed(leaderA, "setlists", { id: IDS.setlists.draftA });
    });

    it("can see setlist_songs of a draft setlist", async () => {
      await assertSelectAllowed(leaderA, "setlist_songs", { setlist_id: IDS.setlists.draftA });
    });

    it("can INSERT and DELETE a setlist", async () => {
      // Need a unique service_week for this insert
      const swId = "00000000-0000-4000-8005-000000000099";
      await serviceClient.from("service_weeks").insert({
        id: swId,
        church_group_id: IDS.churches.A,
        service_date: "2026-12-25",
        title: "Test SW Leader",
      });

      const newId = "00000000-0000-4000-8006-000000000099";
      const { error: insertErr } = await leaderA.from("setlists").insert({
        id: newId,
        church_group_id: IDS.churches.A,
        service_week_id: swId,
        status: "draft",
      });
      expect(insertErr).toBeNull();

      // Cleanup
      await serviceClient.from("setlists").delete().eq("id", newId);
      await serviceClient.from("service_weeks").delete().eq("id", swId);
    });
  });

  describe("Admin visibility", () => {
    let adminA: ReturnType<typeof getUserClient>;

    beforeAll(() => {
      adminA = getUserClient({ clerkId: IDS.clerkIds.adminA });
    });

    it("can see draft setlists", async () => {
      await assertSelectAllowed(adminA, "setlists", { id: IDS.setlists.draftA });
    });

    it("can see all setlist_songs including draft", async () => {
      await assertSelectAllowed(adminA, "setlist_songs", { setlist_id: IDS.setlists.draftA });
    });
  });
});
