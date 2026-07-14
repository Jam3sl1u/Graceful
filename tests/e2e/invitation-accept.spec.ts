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

// Issue #52 AC #1: accepting an invitation flips it to Confirmed and
// notifies the inviting admin in-app. Uses the public, no-session token
// flow (app/(public)/invite/[token]) — the real product UX for this AC, and
// needs no Clerk sign-in (OQ1 only gates the conflict-detection suite, which
// requires an authenticated session).
test.describe("invitation accept", () => {
  test.skip(!e2eAuthEnabled, "requires staging E2E secrets — see tests/e2e/support/env.ts");

  test("accepting via the response-token link marks it accepted and notifies the inviting admin in-app", async ({
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
      await expect(page.getByRole("button", { name: "Accept", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Accept", exact: true }).click();
      await expect(page.getByRole("heading", { name: "You're on the schedule" })).toBeVisible();

      const { data: invitation } = await svc
        .from("invitations")
        .select("status")
        .eq("id", invitationId)
        .single();
      expect(invitation?.status).toBe("accepted");

      // GET /api/notifications is an unimplemented 501 stub
      // (app/api/notifications/route.ts) as of this issue — assert the
      // underlying row directly via the service-role client, scoped to the
      // specific admin recipient and entity (spec edge case: never just "an
      // unread notification exists").
      const { data: notifications } = await svc
        .from("notifications")
        .select("*")
        .eq("user_id", FIXTURE.adminUserId)
        .eq("type", "invitation_accepted")
        .eq("link_entity_id", invitationId);
      expect(notifications).toHaveLength(1);

      // Idempotency (spec edge case): accepting again via the same link is a
      // graceful no-op returning the current status, not an error.
      const res = await page.request.post(`/api/invitations/${invitationId}/accept`, {
        data: { responseToken },
      });
      expect(res.ok()).toBe(true);
      const body = await res.json();
      expect(body.data.status).toBe("accepted");
      expect(body.data.alreadyResponded).toBe(true);
    } finally {
      await teardownFixtures(svc, {
        serviceWeekId,
        invitationId,
        notificationLinkEntityIds: [invitationId],
      });
    }
  });
});
