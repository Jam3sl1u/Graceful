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

// Issue #52 AC #2: deny -> slot reopens -> admin notified. Per the human
// OQ2 resolution (.pipeline/spec.md): only the observable, real behavior is
// tested here (the invitation flips to `denied` with the given reason). The
// admin SMS + email dispatch is skipped below with a tracked reason — the
// deny handler only has a TODO for it (app/api/invitations/handler.ts ~line
// 399: `TODO(#67/#68): dispatch SMS + email to invited_by`), and both
// dispatch primitives are unimplemented throwing stubs
// (lib/pingram/client.ts, lib/resend/client.ts). Implementing #67/#68 is
// explicitly out of scope for this issue.
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

  // Tracked, intentionally-always-skipped placeholder (OQ2): surfaces in the
  // test report that admin SMS + email on deny is deliberately NOT covered
  // here, rather than silently absent, until #67/#68 ship.
  test.skip(
    "admin receives SMS + email with the deny reason (deferred until #67/#68 ship — see app/api/invitations/handler.ts TODO and lib/pingram/client.ts + lib/resend/client.ts stubs)",
    async () => {},
  );
});
