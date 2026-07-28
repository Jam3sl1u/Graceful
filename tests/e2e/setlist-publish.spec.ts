import { test, expect } from "@playwright/test";
import { e2eAuthEnabled } from "./support/env";
import { getE2EServiceClient } from "./support/db";
import {
  FIXTURE,
  futureDateString,
  seedServiceWeek,
  seedSong,
  seedInvitation,
  seedSyntheticUser,
  teardownFixtures,
} from "./support/fixtures";
import { signInAs } from "./support/auth";

// Issue #66 AC #1/#2: a Set Leader/admin builds a setlist and publishes it,
// and members see the released setlist + get notified.
//
// OPEN QUESTION 1 (.pipeline/spec.md): AC #1's literal wording ("members who
// are still pending do not see the setlist") does not match the implemented
// behavior — once a setlist is published, RLS
// (setlists_select_published_members,
// supabase/migrations/20260704000001_rls_policies.sql) lets EVERY user in
// the church group read it regardless of invitation status. The real
// confirmed-vs-pending distinction lives in notification recipients:
// publishSetlist (app/api/setlists/[id]/handler.ts) only notifies users with
// an *accepted* invitation for the parent service week. So Test A below
// asserts the confirmed member IS notified and the pending member is NOT —
// that is the actual, in-scope-verifiable behavior.
test.describe("setlist publish", () => {
  test.skip(!e2eAuthEnabled, "requires staging E2E secrets — see tests/e2e/support/env.ts");

  test("a Set Leader/admin builds a setlist in the builder, publishes it, and only confirmed members are notified", async ({
    browser,
  }) => {
    const svc = getE2EServiceClient();
    const serviceDate = futureDateString(8);
    const serviceWeekId = await seedServiceWeek(svc, FIXTURE.churchGroupId, serviceDate);
    const song = await seedSong(svc, FIXTURE.churchGroupId, { defaultKey: "G" });
    const { id: confirmedInvitationId } = await seedInvitation(svc, {
      churchGroupId: FIXTURE.churchGroupId,
      serviceWeekId,
      userId: FIXTURE.memberUserId,
      invitedBy: FIXTURE.adminUserId,
      status: "accepted",
    });
    const pendingUserId = await seedSyntheticUser(svc, FIXTURE.churchGroupId);
    const { id: pendingInvitationId } = await seedInvitation(svc, {
      churchGroupId: FIXTURE.churchGroupId,
      serviceWeekId,
      userId: pendingUserId,
      invitedBy: FIXTURE.adminUserId,
      status: "pending",
    });

    let setlistId: string | undefined;
    try {
      const adminContext = await browser.newContext();
      const adminPage = await adminContext.newPage();
      await adminPage.goto("/");
      await signInAs(adminPage, "admin");

      const createRes = await adminPage.request.post(
        `/api/service-weeks/${serviceWeekId}/setlist`,
      );
      expect(createRes.ok()).toBe(true);
      setlistId = (await createRes.json()).data.setlist.id;

      await adminPage.goto(`/setlists/${setlistId}`);
      await expect(adminPage.getByRole("heading", { name: "Setlist Builder" })).toBeVisible();
      await expect(adminPage.getByText("Draft")).toBeVisible();

      await adminPage.getByPlaceholder("Search songs").fill(song.title);
      await adminPage.getByRole("button", { name: "Add", exact: true }).click();
      await expect(adminPage.getByText("1 song")).toBeVisible();

      await adminPage.getByRole("button", { name: "Publish", exact: true }).click();
      await expect(adminPage.getByRole("heading", { name: "Publish this setlist?" })).toBeVisible();
      await expect(
        adminPage.getByText("Confirmed members will be notified once you publish."),
      ).toBeVisible();

      // Two buttons named "Publish" exist once the modal is open (bottom bar
      // + modal), and components/ui/Modal.tsx has no role="dialog" to scope
      // by. Resolve deterministically: assert the count, then click the
      // last one in DOM order (the modal renders after the bottom bar).
      await expect(
        adminPage.getByRole("button", { name: "Publish", exact: true }),
      ).toHaveCount(2);
      await adminPage.getByRole("button", { name: "Publish", exact: true }).last().click();

      await expect(
        adminPage.getByText("This setlist is published and locked for editing."),
      ).toBeVisible();
      await expect(adminPage.getByText("Published")).toBeVisible();

      await adminContext.close();

      const { data: setlistRow } = await svc
        .from("setlists")
        .select("status, published_at")
        .eq("id", setlistId)
        .single();
      expect(setlistRow?.status).toBe("published");
      expect(setlistRow?.published_at).toBeTruthy();

      const { data: confirmedNotifications } = await svc
        .from("notifications")
        .select("*")
        .eq("user_id", FIXTURE.memberUserId)
        .eq("type", "setlist_released")
        .eq("link_entity_id", setlistId);
      expect(confirmedNotifications).toHaveLength(1);
      expect(confirmedNotifications?.[0]?.title).toBe("Setlist published");
      expect(confirmedNotifications?.[0]?.body).toBeNull();

      // The AC's confirmed-vs-pending assertion: the pending member gets no
      // notification, even though (per OQ1) they CAN read the published
      // setlist directly.
      const { data: pendingNotifications } = await svc
        .from("notifications")
        .select("*")
        .eq("user_id", pendingUserId)
        .eq("type", "setlist_released")
        .eq("link_entity_id", setlistId);
      expect(pendingNotifications).toHaveLength(0);

      const memberContext = await browser.newContext();
      const memberPage = await memberContext.newPage();
      await memberPage.goto("/");
      await signInAs(memberPage, "member");
      await memberPage.goto(`/member-week/${serviceWeekId}`);
      await expect(memberPage.getByText(song.title)).toBeVisible();
      await expect(memberPage.getByText("Confirmed")).toBeVisible();
      await memberContext.close();
    } finally {
      await teardownFixtures(svc, {
        serviceWeekId,
        invitationIds: [confirmedInvitationId, pendingInvitationId],
        notificationLinkEntityIds: setlistId ? [setlistId] : [],
        songIds: [song.id],
        userIds: [pendingUserId],
      });
    }
  });

  test("a zero-song setlist publishes successfully with the zero-song notification copy", async ({
    browser,
  }) => {
    const svc = getE2EServiceClient();
    const serviceDate = futureDateString(9);
    const serviceWeekId = await seedServiceWeek(svc, FIXTURE.churchGroupId, serviceDate);
    const { id: invitationId } = await seedInvitation(svc, {
      churchGroupId: FIXTURE.churchGroupId,
      serviceWeekId,
      userId: FIXTURE.memberUserId,
      invitedBy: FIXTURE.adminUserId,
      status: "accepted",
    });

    let setlistId: string | undefined;
    try {
      const adminContext = await browser.newContext();
      const adminPage = await adminContext.newPage();
      await adminPage.goto("/");
      await signInAs(adminPage, "admin");

      const createRes = await adminPage.request.post(
        `/api/service-weeks/${serviceWeekId}/setlist`,
      );
      expect(createRes.ok()).toBe(true);
      setlistId = (await createRes.json()).data.setlist.id;

      await adminPage.goto(`/setlists/${setlistId}`);
      await expect(adminPage.getByText("No songs yet — add some from the catalog.")).toBeVisible();
      await expect(adminPage.getByText("0 songs")).toBeVisible();

      await adminPage.getByRole("button", { name: "Publish", exact: true }).click();
      await expect(adminPage.getByRole("heading", { name: "Publish this setlist?" })).toBeVisible();
      await expect(
        adminPage.getByText(
          "This setlist has no songs yet. It will be published with no songs.",
        ),
      ).toBeVisible();

      await expect(
        adminPage.getByRole("button", { name: "Publish", exact: true }),
      ).toHaveCount(2);
      await adminPage.getByRole("button", { name: "Publish", exact: true }).last().click();
      await expect(adminPage.getByText("Published")).toBeVisible();

      await adminContext.close();

      const { data: setlistRow } = await svc
        .from("setlists")
        .select("status")
        .eq("id", setlistId)
        .single();
      expect(setlistRow?.status).toBe("published");

      const { data: notifications } = await svc
        .from("notifications")
        .select("*")
        .eq("user_id", FIXTURE.memberUserId)
        .eq("type", "setlist_released")
        .eq("link_entity_id", setlistId);
      expect(notifications).toHaveLength(1);
      expect(notifications?.[0]?.title).toBe("Setlist published");
      // Exact string, em dash included — this is the AC's "correct
      // notification copy" for the zero-song case (distinct from the
      // non-zero case in the test above, where body is null).
      expect(notifications?.[0]?.body).toBe(
        "The setlist has been published — songs are still being added.",
      );

      const memberContext = await browser.newContext();
      const memberPage = await memberContext.newPage();
      await memberPage.goto("/");
      await signInAs(memberPage, "member");
      await memberPage.goto(`/member-week/${serviceWeekId}`);
      await expect(memberPage.getByText("No songs added yet")).toBeVisible();
      await expect(memberPage.getByText("Setlist not yet released")).not.toBeVisible();
      await memberContext.close();
    } finally {
      await teardownFixtures(svc, {
        serviceWeekId,
        invitationId,
        notificationLinkEntityIds: setlistId ? [setlistId] : [],
      });
    }
  });
});
