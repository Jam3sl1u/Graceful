import { test, expect } from "@playwright/test";
import { e2eAuthEnabled } from "./support/env";
import { getE2EServiceClient } from "./support/db";
import {
  FIXTURE,
  futureDateString,
  seedServiceWeek,
  seedInvitation,
  teardownFixtures,
} from "./support/fixtures";

// Issue #52 AC #2: deny -> slot reopens -> admin notified. Only the
// observable, real behavior is tested here (the invitation flips to `denied`
// with the given reason). As of #69 the deny handler DOES wire admin SMS +
// email dispatch (app/api/invitations/handler.ts denyInvitation +
// deny_invitation RPC, via lib/notifications/dispatch.ts); asserting real SMS
// / email delivery end-to-end stays out of scope for this issue — #82 owns
// full E2E regression for the notification channels.
test.describe("invitation deny", () => {
  test.skip(!e2eAuthEnabled, "requires staging E2E secrets — see tests/e2e/support/env.ts");

  test("declining via the response-token link marks it denied with the given reason", async ({
    page,
  }) => {
    const svc = getE2EServiceClient();
    const serviceDate = futureDateString(3);
    const serviceWeekId = await seedServiceWeek(svc, FIXTURE.churchGroupId, serviceDate);
    const { id: invitationId, responseToken } = await seedInvitation(svc, {
      churchGroupId: FIXTURE.churchGroupId,
      serviceWeekId,
      userId: FIXTURE.memberUserId,
      invitedBy: FIXTURE.adminUserId,
    });

    try {
      await page.goto(`/invite/${responseToken}`);
      await expect(page.getByRole("button", { name: "Decline" })).toBeVisible();
      await page.getByRole("button", { name: "Decline" }).click();

      await page.getByLabel("Reason (optional)").fill("Family emergency");
      await page.getByRole("button", { name: "Confirm decline" }).click();
      await expect(page.getByRole("heading", { name: "Response recorded" })).toBeVisible();

      const { data: invitation } = await svc
        .from("invitations")
        .select("status, denial_reason")
        .eq("id", invitationId)
        .single();
      expect(invitation?.status).toBe("denied");
      expect(invitation?.denial_reason).toBe("Family emergency");

      // Idempotency (spec edge case): denying again via the same link is a
      // graceful no-op returning the current status, not an error.
      const res = await page.request.post(`/api/invitations/${invitationId}/deny`, {
        data: { responseToken, reason: "Family emergency" },
      });
      expect(res.ok()).toBe(true);
      const body = await res.json();
      expect(body.data.status).toBe("denied");
      expect(body.data.alreadyResponded).toBe(true);
    } finally {
      await teardownFixtures(svc, { serviceWeekId, invitationId });
    }
  });

  // Tracked, intentionally-always-skipped placeholder: admin SMS + email on
  // deny IS wired as of #69 (handler + deny_invitation RPC + dispatch module),
  // but asserting real end-to-end delivery is deferred to #82 (full E2E
  // regression for the notification channels), not covered here.
  test.skip(
    "admin receives SMS + email with the deny reason (wired in #69; real end-to-end delivery assertion deferred to #82 — see lib/notifications/dispatch.ts)",
    async () => {},
  );
});
