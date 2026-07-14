import { test, expect } from "@playwright/test";
import { e2eAuthEnabled } from "./support/env";
import { getE2EServiceClient } from "./support/db";
import {
  FIXTURE,
  futureDateString,
  seedServiceWeek,
  seedInvitation,
  teardownFixtures,
  setMemberRole,
} from "./support/fixtures";
import { signInAs } from "./support/auth";

// Issue #52 AC #4: confirm -> mark unavailable -> admin conflict
// notification. Unlike accept/deny (public token flow), this AC needs a
// real authenticated session: PUT /api/availability and GET /api/conflicts
// both call requireAuth (lib/api/auth.ts), which verifies a Clerk session —
// this is exactly what OQ1's @clerk/testing resolution unblocks.
test.describe("conflict detection on availability change", () => {
  test.skip(!e2eAuthEnabled, "requires staging E2E secrets — see tests/e2e/support/env.ts");

  test("member marking an accepted service date unavailable records a conflict and notifies the admin in-app", async ({
    browser,
  }) => {
    const svc = getE2EServiceClient();
    const serviceDate = futureDateString(5);
    const serviceWeekId = await seedServiceWeek(svc, FIXTURE.churchGroupId, serviceDate);
    const { id: invitationId } = await seedInvitation(svc, {
      churchGroupId: FIXTURE.churchGroupId,
      serviceWeekId,
      userId: FIXTURE.memberUserId,
      invitedBy: FIXTURE.adminUserId,
      status: "accepted",
    });

    let conflictId: string | undefined;
    try {
      const memberContext = await browser.newContext();
      const memberPage = await memberContext.newPage();
      await memberPage.goto("/");
      await signInAs(memberPage, "member");
      const putRes = await memberPage.request.put("/api/availability", {
        data: { entries: [{ date: serviceDate, isAvailable: false, note: "family emergency" }] },
      });
      expect(putRes.ok()).toBe(true);
      const putBody = await putRes.json();
      expect(putBody.data.conflictTriggered).toBe(true);
      await memberContext.close();

      // Admin verifies via the real GET /api/conflicts endpoint (#47) — the
      // one observable in-app surface for this AC that's actually
      // implemented.
      const adminContext = await browser.newContext();
      const adminPage = await adminContext.newPage();
      await adminPage.goto("/");
      await signInAs(adminPage, "admin");
      const conflictsRes = await adminPage.request.get("/api/conflicts");
      expect(conflictsRes.ok()).toBe(true);
      const conflictsBody = await conflictsRes.json();
      const conflict = (
        conflictsBody.data.conflicts as Array<{ id: string; invitationId: string; triggerReason: string | null }>
      ).find((c) => c.invitationId === invitationId);
      expect(conflict).toBeDefined();
      expect(conflict?.triggerReason).toBe("marked_unavailable");
      conflictId = conflict?.id;
      await adminContext.close();

      // GET /api/notifications is an unimplemented 501 stub
      // (app/api/notifications/route.ts) as of this issue — assert the
      // underlying row directly, scoped to the specific admin recipient and
      // entity (spec edge case: never just "an unread notification exists").
      const { data: notifications } = await svc
        .from("notifications")
        .select("*")
        .eq("user_id", FIXTURE.adminUserId)
        .eq("type", "scheduling_conflict")
        .eq("link_entity_id", conflictId);
      expect(notifications).toHaveLength(1);
    } finally {
      await teardownFixtures(svc, {
        serviceWeekId,
        invitationId,
        conflictId,
        notificationLinkEntityIds: conflictId ? [conflictId] : [],
        availability: { userId: FIXTURE.memberUserId, date: serviceDate },
      });
    }
  });

  test("the triggering member never receives a self-notification, even while holding an admin/set_leader role", async ({
    browser,
  }) => {
    const svc = getE2EServiceClient();
    const serviceDate = futureDateString(6);
    const serviceWeekId = await seedServiceWeek(svc, FIXTURE.churchGroupId, serviceDate);
    const { id: invitationId } = await seedInvitation(svc, {
      churchGroupId: FIXTURE.churchGroupId,
      serviceWeekId,
      userId: FIXTURE.memberUserId,
      invitedBy: FIXTURE.adminUserId,
      status: "accepted",
    });

    let conflictId: string | undefined;
    try {
      // The RPC excludes the triggering user even if they hold an
      // admin/set_leader role (id <> v_user_id) — temporarily elevate the
      // stable member fixture to prove it. Safe only because
      // playwright.config.ts serializes this suite (workers: 1).
      await setMemberRole(svc, "set_leader");

      const memberContext = await browser.newContext();
      const memberPage = await memberContext.newPage();
      await memberPage.goto("/");
      await signInAs(memberPage, "member");
      const putRes = await memberPage.request.put("/api/availability", {
        data: { entries: [{ date: serviceDate, isAvailable: false, note: null }] },
      });
      expect(putRes.ok()).toBe(true);
      await memberContext.close();

      const { data: conflicts } = await svc
        .from("conflicts")
        .select("id")
        .eq("invitation_id", invitationId);
      conflictId = conflicts?.[0]?.id;
      expect(conflictId).toBeDefined();

      const { data: selfNotifications } = await svc
        .from("notifications")
        .select("*")
        .eq("user_id", FIXTURE.memberUserId)
        .eq("link_entity_id", conflictId);
      expect(selfNotifications).toHaveLength(0);
    } finally {
      await setMemberRole(svc, "member");
      await teardownFixtures(svc, {
        serviceWeekId,
        invitationId,
        conflictId,
        notificationLinkEntityIds: conflictId ? [conflictId] : [],
        availability: { userId: FIXTURE.memberUserId, date: serviceDate },
      });
    }
  });
});
