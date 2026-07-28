import { test, expect } from "@playwright/test";
import { e2eAuthEnabled } from "./support/env";
import { getE2EServiceClient } from "./support/db";
import {
  FIXTURE,
  futureDateString,
  seedServiceWeek,
  seedSong,
  teardownFixtures,
  setMemberRole,
} from "./support/fixtures";
import { signInAs } from "./support/auth";

// Issue #66 AC #3: adding the same song twice to a setlist is rejected
// (BR-07), and the builder disables Add for a song already in the setlist.
// Driven by the member fixture temporarily elevated to set_leader so the
// suite has genuine Set Leader coverage of the builder (not just admin) —
// copies conflict-detection.spec.ts's self-exclusion test pattern: restore
// the role as the FIRST statement of `finally`, safe only because
// playwright.config.ts serializes this suite (workers: 1).
test.describe("setlist duplicate song", () => {
  test.skip(!e2eAuthEnabled, "requires staging E2E secrets — see tests/e2e/support/env.ts");

  test("adding the same song twice is rejected (BR-07) and the builder disables Add for a song already in the setlist", async ({
    browser,
  }) => {
    const svc = getE2EServiceClient();
    const serviceDate = futureDateString(10);
    const serviceWeekId = await seedServiceWeek(svc, FIXTURE.churchGroupId, serviceDate);
    const song = await seedSong(svc, FIXTURE.churchGroupId);

    try {
      await setMemberRole(svc, "set_leader");

      const leaderContext = await browser.newContext();
      const leaderPage = await leaderContext.newPage();
      await leaderPage.goto("/");
      await signInAs(leaderPage, "member");

      const createRes = await leaderPage.request.post(
        `/api/service-weeks/${serviceWeekId}/setlist`,
      );
      expect(createRes.ok()).toBe(true);
      const setlistId = (await createRes.json()).data.setlist.id;

      const firstAdd = await leaderPage.request.post(`/api/setlists/${setlistId}/songs`, {
        data: { songId: song.id },
      });
      expect(firstAdd.status()).toBe(201);
      const firstAddBody = await firstAdd.json();
      expect(firstAddBody.data.songs).toHaveLength(1);

      const duplicateAdd = await leaderPage.request.post(`/api/setlists/${setlistId}/songs`, {
        data: { songId: song.id },
      });
      expect(duplicateAdd.status()).toBe(409);
      const duplicateAddBody = await duplicateAdd.json();
      expect(duplicateAddBody.error).toBe("That song is already in the setlist.");
      expect(duplicateAddBody.code).toBe("CONFLICT");

      const { data: setlistSongs } = await svc
        .from("setlist_songs")
        .select("id")
        .eq("setlist_id", setlistId)
        .eq("song_id", song.id);
      expect(setlistSongs).toHaveLength(1);

      await leaderPage.goto(`/setlists/${setlistId}`);
      await leaderPage.getByPlaceholder("Search songs").fill(song.title);
      const addedButton = leaderPage.getByRole("button", { name: "Added", exact: true });
      await expect(addedButton).toBeVisible();
      await expect(addedButton).toBeDisabled();

      await leaderContext.close();
    } finally {
      await setMemberRole(svc, "member");
      await teardownFixtures(svc, { serviceWeekId, songIds: [song.id] });
    }
  });
});
