import { test, expect } from "@playwright/test";
import { e2eDisposablePersonasEnabled, requireEnv } from "./support/env";
import { getE2EServiceClient } from "./support/db";
import {
  futureDateString,
  resetDisposablePersona,
  seedSong,
  teardownFixtures,
} from "./support/fixtures";
import { signInAsEmail } from "./support/auth";

// Issue #82: full admin week-setup flow as one continuous test — create
// group -> invite member -> member joins -> build setlist -> schedule
// events -> invite roster member -> roster shows Pending.
//
// Requires two disposable staging Clerk personas beyond the stable
// E2E_ADMIN_EMAIL/E2E_MEMBER_EMAIL fixture (tests/e2e/support/fixtures.ts),
// because create_church_group/join_church_group both 409
// USER_ALREADY_IN_GROUP for any Clerk identity that already has a `users`
// row (see .pipeline/spec.md OQ1, resolved by provisioning
// E2E_SETUP_ADMIN_EMAIL / E2E_GUEST_EMAIL as GitHub Actions secrets).
test.describe("admin week setup flow", () => {
  test.skip(
    !e2eDisposablePersonasEnabled,
    "requires staging E2E secrets + disposable personas — see tests/e2e/support/env.ts",
  );

  test("admin creates a group, a member joins, and the admin builds a full service week", async ({
    browser,
  }) => {
    const svc = getE2EServiceClient();
    const setupAdminEmail = requireEnv("E2E_SETUP_ADMIN_EMAIL");
    const guestEmail = requireEnv("E2E_GUEST_EMAIL");

    // Defensive: a previous failed run may have left these personas bound to
    // a leftover group.
    await resetDisposablePersona(svc, setupAdminEmail);
    await resetDisposablePersona(svc, guestEmail);

    let adminContext: Awaited<ReturnType<typeof browser.newContext>> | undefined;
    let joinerContext: Awaited<ReturnType<typeof browser.newContext>> | undefined;
    let newChurchGroupId: string | undefined;
    let serviceWeekId: string | undefined;
    let setlistId: string | undefined;
    let songId: string | undefined;

    try {
      adminContext = await browser.newContext();
      const adminPage = await adminContext.newPage();
      await adminPage.goto("/");
      await signInAsEmail(adminPage, setupAdminEmail);

      const createGroupRes = await adminPage.request.put("/api/church-group", {
        data: { name: "E2E Week Setup Church", timezone: "America/Chicago" },
      });
      expect(createGroupRes.status()).toBe(201);
      const createGroupBody = await createGroupRes.json();
      newChurchGroupId = createGroupBody.data.id;
      expect(newChurchGroupId).toBeTruthy();

      const { data: newGroupRow } = await svc
        .from("church_groups")
        .select("invite_code")
        .eq("id", newChurchGroupId!)
        .single();
      const inviteCode = newGroupRow?.invite_code as string;
      expect(inviteCode).toBeTruthy();

      const { data: newAdminRow } = await svc
        .from("users")
        .select("id")
        .eq("church_group_id", newChurchGroupId!)
        .eq("role", "admin")
        .single();
      const newAdminUserId = newAdminRow?.id as string;
      expect(newAdminUserId).toBeTruthy();

      joinerContext = await browser.newContext();
      const joinerPage = await joinerContext.newPage();
      await joinerPage.goto("/");
      await signInAsEmail(joinerPage, guestEmail);
      await joinerPage.goto(`/join/${inviteCode}`);
      await joinerPage.getByRole("button", { name: "Join group" }).click();
      await expect(joinerPage.getByRole("heading", { name: "You're in!" })).toBeVisible();

      const { data: joinerRow } = await svc
        .from("users")
        .select("id, name")
        .eq("church_group_id", newChurchGroupId!)
        .eq("role", "member")
        .single();
      const joinerUserId = joinerRow?.id as string;
      const joinerName = joinerRow?.name as string;
      expect(joinerUserId).toBeTruthy();

      const serviceDate = futureDateString(10);
      const createWeekRes = await adminPage.request.post("/api/service-weeks", {
        data: {
          serviceDate,
          title: "E2E Week Setup Service",
          sermonTopic: "E2E Sermon Topic",
          sermonScripture: "John 3:16",
          speakerName: "E2E Speaker",
        },
      });
      expect(createWeekRes.status()).toBe(201);
      const createWeekBody = await createWeekRes.json();
      serviceWeekId = createWeekBody.data.serviceWeek.id;
      expect(serviceWeekId).toBeTruthy();

      const createSetlistRes = await adminPage.request.post(
        `/api/service-weeks/${serviceWeekId}/setlist`,
      );
      expect(createSetlistRes.status()).toBe(201);
      const createSetlistBody = await createSetlistRes.json();
      setlistId = createSetlistBody.data.setlist.id;
      expect(setlistId).toBeTruthy();

      const song = await seedSong(svc, newChurchGroupId!, { createdBy: newAdminUserId });
      songId = song.id;

      await adminPage.goto(`/setlists/${setlistId}`);
      await adminPage.getByPlaceholder("Search songs").fill(song.title);
      await adminPage.getByRole("button", { name: "Add", exact: true }).click();
      await expect(adminPage.getByText("1 song")).toBeVisible();

      const serviceAnchor = new Date(`${serviceDate}T00:00:00.000Z`);
      const rehearsalStart = new Date(serviceAnchor.getTime() - 24 * 60 * 60 * 1000).toISOString();
      const rehearsalEnd = new Date(serviceAnchor.getTime() - 22 * 60 * 60 * 1000).toISOString();
      const createRehearsalRes = await adminPage.request.post("/api/events", {
        data: {
          serviceWeekId,
          type: "rehearsal",
          name: "E2E Rehearsal",
          startTime: rehearsalStart,
          endTime: rehearsalEnd,
        },
      });
      expect(createRehearsalRes.status()).toBe(201);

      const serviceStart = serviceAnchor.toISOString();
      const serviceEnd = new Date(serviceAnchor.getTime() + 2 * 60 * 60 * 1000).toISOString();
      const createServiceEventRes = await adminPage.request.post("/api/events", {
        data: {
          serviceWeekId,
          type: "service",
          name: "E2E Service",
          startTime: serviceStart,
          endTime: serviceEnd,
        },
      });
      expect(createServiceEventRes.status()).toBe(201);

      const { data: eventRows } = await svc
        .from("events")
        .select("id, type")
        .eq("service_week_id", serviceWeekId!);
      expect((eventRows ?? []).map((e) => e.type).sort()).toEqual(["rehearsal", "service"]);

      await adminPage.goto(`/week/${serviceWeekId}`);
      // The admin's own roster slot also has a "+ Invite" button (they have
      // no invitation for their own week either), so scope to the joiner's
      // roster slot by their name (the div containing the name span and the
      // button — see week-view.tsx's rosterSlot layout).
      const joinerRosterSlot = adminPage.getByText(joinerName, { exact: true }).locator("..");
      await joinerRosterSlot.getByRole("button", { name: "+ Invite" }).click();
      await expect(joinerRosterSlot.getByText("Pending", { exact: true })).toBeVisible();

      const { data: invitationRow } = await svc
        .from("invitations")
        .select("id, status")
        .eq("service_week_id", serviceWeekId!)
        .eq("user_id", joinerUserId)
        .maybeSingle();
      expect(invitationRow?.status).toBe("pending");
    } finally {
      try {
        await adminContext?.close();
      } catch (err) {
        console.error("week-setup-flow cleanup: adminContext.close failed", err);
      }
      try {
        await joinerContext?.close();
      } catch (err) {
        console.error("week-setup-flow cleanup: joinerContext.close failed", err);
      }
      await teardownFixtures(svc, {
        churchGroupIds: newChurchGroupId ? [newChurchGroupId] : [],
        songIds: songId ? [songId] : [],
      });
      await resetDisposablePersona(svc, setupAdminEmail);
      await resetDisposablePersona(svc, guestEmail);
    }
  });
});
