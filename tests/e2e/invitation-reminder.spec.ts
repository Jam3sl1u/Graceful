import { test, expect } from "@playwright/test";
import { e2eAuthEnabled, checkEnv, requireEnv } from "./support/env";
import { getE2EServiceClient } from "./support/db";
import {
  FIXTURE,
  futureDateString,
  seedServiceWeek,
  seedInvitation,
  teardownFixtures,
} from "./support/fixtures";

// Issue #52 AC #3: a pending invitation unanswered for 24h+ gets a reminder.
// Per the human OQ3 resolution (.pipeline/spec.md): the member-SMS side is
// dropped/deferred (sendSms is an unimplemented throwing stub,
// lib/pingram/client.ts — see the cron route's `smsFailed` swallow), and
// "time mocked to advance 24 hours" isn't achievable against a remote
// staging server, so the trigger is a service-role-backdated `created_at`
// (already 24h+ in the past) plus a direct call to
// GET /api/cron/invitation-reminders with the CRON_SECRET bearer token —
// only the admin in-app reminder is asserted.
const cronReady = e2eAuthEnabled && checkEnv(["CRON_SECRET"]);

test.describe("24h invitation reminder", () => {
  test.skip(!cronReady, "requires staging E2E secrets plus CRON_SECRET — see tests/e2e/support/env.ts");

  test("a pending invitation overdue by 24h+ gets an admin in-app reminder, stamped once (not double-reminded)", async ({
    request,
  }) => {
    const svc = getE2EServiceClient();
    const serviceDate = futureDateString(4);
    const serviceWeekId = await seedServiceWeek(svc, FIXTURE.churchGroupId, serviceDate);
    const backdatedCreatedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const { id: invitationId } = await seedInvitation(svc, {
      churchGroupId: FIXTURE.churchGroupId,
      serviceWeekId,
      userId: FIXTURE.memberUserId,
      invitedBy: FIXTURE.adminUserId,
      createdAt: backdatedCreatedAt,
    });

    try {
      const firstRun = await request.get("/api/cron/invitation-reminders", {
        headers: { Authorization: `Bearer ${requireEnv("CRON_SECRET")}` },
      });
      expect(firstRun.ok()).toBe(true);

      const { data: afterFirst } = await svc
        .from("invitations")
        .select("last_reminded_at")
        .eq("id", invitationId)
        .single();
      expect(afterFirst?.last_reminded_at).toBeTruthy();
      const firstStamp = afterFirst?.last_reminded_at;

      const { data: notifications } = await svc
        .from("notifications")
        .select("*")
        .eq("user_id", FIXTURE.adminUserId)
        .eq("type", "invitation_reminder")
        .eq("link_entity_id", serviceWeekId);
      expect(notifications?.length).toBeGreaterThanOrEqual(1);
      expect(notifications?.[0]?.body).toContain("E2E Fixture Member");

      // Not double-reminded on a second run within the 24h window (spec
      // edge case): last_reminded_at must be unchanged.
      const secondRun = await request.get("/api/cron/invitation-reminders", {
        headers: { Authorization: `Bearer ${requireEnv("CRON_SECRET")}` },
      });
      expect(secondRun.ok()).toBe(true);

      const { data: afterSecond } = await svc
        .from("invitations")
        .select("last_reminded_at")
        .eq("id", invitationId)
        .single();
      expect(afterSecond?.last_reminded_at).toBe(firstStamp);
    } finally {
      await teardownFixtures(svc, {
        serviceWeekId,
        invitationId,
        notificationLinkEntityIds: [serviceWeekId],
      });
    }
  });
});
