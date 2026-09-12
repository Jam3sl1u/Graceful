import { test, expect } from "@playwright/test";
import { e2eAuthEnabled, e2eDisposablePersonasEnabled, requireEnv } from "./support/env";
import { getE2EServiceClient } from "./support/db";
import {
  FIXTURE,
  futureDateString,
  resetDisposablePersona,
  seedServiceWeek,
  teardownFixtures,
} from "./support/fixtures";
import { signInAs, signInAsEmail } from "./support/auth";

// Issue #82 / #72: guest invitation flow end to end — existing-user path
// (Test A) and new-user path (Test B).
test.describe("guest invitation", () => {
  test.skip(!e2eAuthEnabled, "requires staging E2E secrets — see tests/e2e/support/env.ts");

  test("existing-user path — inviting a guest who already has a users row leaves their role unchanged", async ({
    page,
  }) => {
    const svc = getE2EServiceClient();
    const serviceDate = futureDateString(12);
    const serviceWeekId = await seedServiceWeek(svc, FIXTURE.churchGroupId, serviceDate);
    let invitationId: string | undefined;

    try {
      await page.goto("/");
      await signInAs(page, "admin");

      const res = await page.request.post("/api/invitations/guest", {
        data: { serviceWeekId, email: requireEnv("E2E_MEMBER_EMAIL") },
      });
      expect(res.status()).toBe(201);
      const body = await res.json();
      invitationId = body.data.invitation.id;

      expect(body.data.isNewUser).toBe(false);
      expect(body.data.guestUserId).toBe(FIXTURE.memberUserId);
      expect(body.data.accountSetupUrl).toBeNull();
      expect(body.data.inviteUrl.endsWith(`/invite/${body.data.invitation.responseToken}`)).toBe(
        true,
      );

      const { data: memberRow } = await svc
        .from("users")
        .select("role")
        .eq("id", FIXTURE.memberUserId)
        .single();
      expect(memberRow?.role).toBe("member");

      const { data: invitationRow } = await svc
        .from("invitations")
        .select("status")
        .eq("id", invitationId!)
        .single();
      expect(invitationRow?.status).toBe("pending");

      // Member accepts via /invite/:token UI, mirroring invitation-accept.spec.ts.
      const { data: tokenRow } = await svc
        .from("invitations")
        .select("response_token")
        .eq("id", invitationId!)
        .single();
      await page.goto(`/invite/${tokenRow?.response_token}`);
      await page.getByRole("button", { name: "Accept", exact: true }).click();
      await expect(page.getByRole("heading", { name: "You're on the schedule" })).toBeVisible();

      const { data: acceptedInvitation } = await svc
        .from("invitations")
        .select("status")
        .eq("id", invitationId!)
        .single();
      expect(acceptedInvitation?.status).toBe("accepted");
    } finally {
      await teardownFixtures(svc, { serviceWeekId, invitationId });
    }
  });

  test("new-user path — a brand-new guest claims their account and accepts the invitation", async ({
    browser,
  }) => {
    test.skip(
      !e2eDisposablePersonasEnabled,
      "requires staging E2E secrets + disposable personas — see tests/e2e/support/env.ts",
    );

    const svc = getE2EServiceClient();
    const guestEmail = requireEnv("E2E_GUEST_EMAIL");
    await resetDisposablePersona(svc, guestEmail);

    const serviceDate = futureDateString(13);
    const serviceWeekId = await seedServiceWeek(svc, FIXTURE.churchGroupId, serviceDate);
    let invitationId: string | undefined;
    let guestUserId: string | undefined;
    let adminContext: Awaited<ReturnType<typeof browser.newContext>> | undefined;
    let guestContext: Awaited<ReturnType<typeof browser.newContext>> | undefined;

    try {
      adminContext = await browser.newContext();
      const adminPage = await adminContext.newPage();
      await adminPage.goto("/");
      await signInAs(adminPage, "admin");
      await adminPage.goto(`/week/${serviceWeekId}`);

      await adminPage.getByLabel("Guest email").fill(guestEmail);
      await adminPage.getByRole("button", { name: "Invite guest" }).click();
      await expect(
        adminPage.getByText(
          "This guest needs this link to create their account (until email delivery is available, #68):",
        ),
      ).toBeVisible();

      const { data: invitationRow } = await svc
        .from("invitations")
        .select("id, user_id, response_token")
        .eq("service_week_id", serviceWeekId)
        .order("created_at", { ascending: false })
        .limit(1)
        .single();
      invitationId = invitationRow?.id as string;
      guestUserId = invitationRow?.user_id as string;
      const responseToken = invitationRow?.response_token as string;
      expect(invitationId).toBeTruthy();
      expect(guestUserId).toBeTruthy();

      const { data: placeholderUser } = await svc
        .from("users")
        .select("clerk_id, role")
        .eq("id", guestUserId)
        .single();
      expect(placeholderUser?.clerk_id.startsWith("pending_guest_")).toBe(true);
      expect(placeholderUser?.role).toBe("guest");

      guestContext = await browser.newContext();
      const guestPage = await guestContext.newPage();
      await guestPage.goto("/");
      await signInAsEmail(guestPage, guestEmail);
      await guestPage.goto(`/guest/${responseToken}`);
      await guestPage.getByRole("button", { name: "Finish setting up your account" }).click();
      await expect(guestPage.getByRole("heading", { name: "You're all set!" })).toBeVisible();

      const { data: claimedUser } = await svc
        .from("users")
        .select("clerk_id, church_group_id")
        .eq("id", guestUserId)
        .single();
      expect(claimedUser?.clerk_id.startsWith("pending_guest_")).toBe(false);
      expect(claimedUser?.church_group_id).toBe(FIXTURE.churchGroupId);

      await guestPage.getByRole("link", { name: "View your invitation" }).click();
      await guestPage.getByRole("button", { name: "Accept", exact: true }).click();
      await expect(guestPage.getByRole("heading", { name: "You're on the schedule" })).toBeVisible();

      const { data: acceptedInvitation } = await svc
        .from("invitations")
        .select("status")
        .eq("id", invitationId)
        .single();
      expect(acceptedInvitation?.status).toBe("accepted");

      // Failure/edge case: re-claiming the same token from the guest session
      // is a 409 CONFLICT (claim_guest_invitation's ALREADY_CLAIMED branch —
      // app/api/invitations/handler.ts claimGuestInvitation).
      const reclaimRes = await guestPage.request.post("/api/invitations/guest/claim", {
        data: { responseToken },
      });
      expect(reclaimRes.status()).toBe(409);
    } finally {
      try {
        await adminContext?.close();
      } catch (err) {
        console.error("guest-invitation cleanup: adminContext.close failed", err);
      }
      try {
        await guestContext?.close();
      } catch (err) {
        console.error("guest-invitation cleanup: guestContext.close failed", err);
      }
      await teardownFixtures(svc, {
        serviceWeekId,
        invitationId,
        userIds: guestUserId ? [guestUserId] : [],
      });
      await resetDisposablePersona(svc, guestEmail);
    }
  });
});
