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
import { signInAs } from "./support/auth";

// Issue #82: notification inbox AC — an action fires a notification, it
// appears in the recipient's inbox (#71 API, D1), and marking it read works.
// Uses the authenticated browser session's page.request (carries the Clerk
// session, exercises real authorization) rather than the service-role
// client for the assertions themselves.
test.describe("notification inbox", () => {
  test.skip(!e2eAuthEnabled, "requires staging E2E secrets — see tests/e2e/support/env.ts");

  test("an action fires a notification, it appears in the recipient's inbox, and marking read works", async ({
    browser,
  }) => {
    const svc = getE2EServiceClient();
    const serviceDate = futureDateString(11);
    const serviceWeekId = await seedServiceWeek(svc, FIXTURE.churchGroupId, serviceDate);
    const { id: invitationId } = await seedInvitation(svc, {
      churchGroupId: FIXTURE.churchGroupId,
      serviceWeekId,
      userId: FIXTURE.memberUserId,
      invitedBy: FIXTURE.adminUserId,
      status: "pending",
    });

    let adminContext: Awaited<ReturnType<typeof browser.newContext>> | undefined;
    let memberContext: Awaited<ReturnType<typeof browser.newContext>> | undefined;
    const adminNotificationLinkEntityId = crypto.randomUUID();

    try {
      adminContext = await browser.newContext();
      const adminPage = await adminContext.newPage();
      await adminPage.goto("/");
      await signInAs(adminPage, "admin");

      const withdrawRes = await adminPage.request.delete(`/api/invitations/${invitationId}`);
      expect(withdrawRes.ok()).toBe(true);

      memberContext = await browser.newContext();
      const memberPage = await memberContext.newPage();
      await memberPage.goto("/");
      await signInAs(memberPage, "member");

      const listRes = await memberPage.request.get("/api/notifications?page=1&pageSize=20");
      expect(listRes.ok()).toBe(true);
      const listBody = await listRes.json();
      const item = listBody.data.notifications.find(
        (n: { linkEntityId: string | null }) => n.linkEntityId === invitationId,
      );
      expect(item).toBeTruthy();
      expect(item.type).toBe("invitation_withdrawn");
      expect(item.title).toBe("Invitation withdrawn");
      expect(item.isRead).toBe(false);

      const unreadRes = await memberPage.request.get("/api/notifications/unread-count");
      expect(unreadRes.ok()).toBe(true);
      const unreadBody = await unreadRes.json();
      expect(unreadBody.data.unreadCount).toBeGreaterThanOrEqual(1);

      const markReadRes = await memberPage.request.patch(
        `/api/notifications/${item.id}/read`,
      );
      expect(markReadRes.status()).toBe(200);
      const markReadBody = await markReadRes.json();
      expect(markReadBody.data.notification.isRead).toBe(true);

      const relistRes = await memberPage.request.get("/api/notifications?page=1&pageSize=20");
      const relistBody = await relistRes.json();
      const relistItem = relistBody.data.notifications.find(
        (n: { linkEntityId: string | null }) => n.linkEntityId === invitationId,
      );
      expect(relistItem.isRead).toBe(true);

      // Idempotency: marking an already-read notification read again is
      // still 200, still isRead: true, no error.
      const markReadAgainRes = await memberPage.request.patch(
        `/api/notifications/${item.id}/read`,
      );
      expect(markReadAgainRes.status()).toBe(200);
      const markReadAgainBody = await markReadAgainRes.json();
      expect(markReadAgainBody.data.notification.isRead).toBe(true);

      // Failure case: PATCHing another user's notification from the member
      // session must be 404, never 403, never 200 (markNotificationRead
      // deliberately does not leak existence).
      const { data: adminNotification, error: adminNotificationError } = await svc
        .from("notifications")
        .insert({
          user_id: FIXTURE.adminUserId,
          church_group_id: FIXTURE.churchGroupId,
          type: "invitation_withdrawn",
          title: "Invitation withdrawn",
          body: null,
          link_entity_type: "invitation",
          link_entity_id: adminNotificationLinkEntityId,
          is_read: false,
        })
        .select("id")
        .single();
      expect(adminNotificationError).toBeNull();

      const crossUserPatchRes = await memberPage.request.patch(
        `/api/notifications/${adminNotification!.id}/read`,
      );
      expect(crossUserPatchRes.status()).toBe(404);
    } finally {
      try {
        await adminContext?.close();
      } catch (err) {
        console.error("notification-inbox cleanup: adminContext.close failed", err);
      }
      try {
        await memberContext?.close();
      } catch (err) {
        console.error("notification-inbox cleanup: memberContext.close failed", err);
      }
      await teardownFixtures(svc, {
        serviceWeekId,
        invitationId,
        notificationLinkEntityIds: [invitationId, adminNotificationLinkEntityId],
      });
    }
  });
});
