import { test, expect } from "@playwright/test";
import { e2eAuthEnabled } from "./support/env";
import { getE2EServiceClient } from "./support/db";
import { FIXTURE, futureDateString, seedServiceWeek, seedInvitation, teardownFixtures } from "./support/fixtures";
import { signInAs } from "./support/auth";
import {
  googleSyncEnabled,
  e2eCalendarId,
  toGoogleEventId,
  seedGoogleCalendarToken,
  getGoogleAccessToken,
  getGoogleCalendarEvent,
  deleteGoogleCalendarEvent,
} from "./support/google";

// Issue #66 AC #4: an event created by an admin lands on a connected
// member's Google Calendar, and an update to it propagates. Runs for real
// against Google, gated on both the base staging E2E secrets AND the extra
// Google Calendar E2E secrets (documentation/staging-environment.md §7.1) —
// until a human provisions those five secrets, this spec skips (mirroring
// issue #52's precedent of the whole authenticated suite skipping until
// staging Clerk/Supabase secrets existed).
const calendarSyncReady = e2eAuthEnabled && googleSyncEnabled;

test.describe("google calendar event sync", () => {
  test.skip(
    !calendarSyncReady,
    "requires staging E2E secrets plus the Google Calendar E2E secrets (E2E_TOKEN_ENCRYPTION_KEY, E2E_GOOGLE_CLIENT_ID, E2E_GOOGLE_CLIENT_SECRET, E2E_GOOGLE_REFRESH_TOKEN) — see documentation/staging-environment.md §7.1",
  );

  test("an event created by an admin lands on a connected member's Google Calendar, and an update to it propagates", async ({
    browser,
  }) => {
    const svc = getE2EServiceClient();
    const serviceDate = futureDateString(11);
    const serviceWeekId = await seedServiceWeek(svc, FIXTURE.churchGroupId, serviceDate);
    // assignAttendee 422s without an accepted invitation — seed it before
    // creating the event.
    const { id: invitationId } = await seedInvitation(svc, {
      churchGroupId: FIXTURE.churchGroupId,
      serviceWeekId,
      userId: FIXTURE.memberUserId,
      invitedBy: FIXTURE.adminUserId,
      status: "accepted",
    });
    await seedGoogleCalendarToken(svc, FIXTURE.memberUserId);

    let eventId: string | undefined;
    let adminContext: Awaited<ReturnType<typeof browser.newContext>> | undefined;
    try {
      adminContext = await browser.newContext();
      const adminPage = await adminContext.newPage();
      await adminPage.goto("/");
      await signInAs(adminPage, "admin");

      const suffix = crypto.randomUUID().slice(0, 8);
      const name = `E2E Event ${suffix}`;
      const startTime = `${serviceDate}T15:00:00.000Z`;
      const endTime = `${serviceDate}T16:00:00.000Z`;

      const createRes = await adminPage.request.post("/api/events", {
        data: {
          serviceWeekId,
          type: "rehearsal",
          name,
          location: "E2E Hall",
          startTime,
          endTime,
        },
      });
      expect(createRes.status()).toBe(201);
      const createBody = await createRes.json();
      eventId = createBody.data.event.id;

      // Creation alone syncs nothing (a brand-new event has no attendees
      // yet) — this attendee POST is the create-propagation trigger.
      const attendeeRes = await adminPage.request.post(`/api/events/${eventId}/attendees`, {
        data: { userId: FIXTURE.memberUserId },
      });
      expect(attendeeRes.status()).toBe(201);

      const googleEventId = toGoogleEventId(eventId as string);
      const accessToken = await getGoogleAccessToken();
      const calendarId = e2eCalendarId();

      await expect
        .poll(
          async () => (await getGoogleCalendarEvent(accessToken, calendarId, googleEventId)).status,
          { timeout: 30_000, intervals: [1_000, 2_000, 5_000] },
        )
        .toBe(200);

      const created = await getGoogleCalendarEvent(accessToken, calendarId, googleEventId);
      expect(created.body?.summary).toBe(name);
      expect(created.body?.location).toBe("E2E Hall");
      const createdStart = created.body?.start as { dateTime: string };
      expect(new Date(createdStart.dateTime).toISOString()).toBe(startTime);

      const updatedName = `${name} (updated)`;
      const updatedStartTime = `${serviceDate}T17:00:00.000Z`;
      const updatedEndTime = `${serviceDate}T18:00:00.000Z`;
      const updateRes = await adminPage.request.put(`/api/events/${eventId}`, {
        data: { name: updatedName, startTime: updatedStartTime, endTime: updatedEndTime },
      });
      expect(updateRes.ok()).toBe(true);

      await expect
        .poll(
          async () => {
            const event = await getGoogleCalendarEvent(accessToken, calendarId, googleEventId);
            return event.body?.summary as string | undefined;
          },
          { timeout: 30_000, intervals: [1_000, 2_000, 5_000] },
        )
        .toBe(updatedName);

      const updated = await getGoogleCalendarEvent(accessToken, calendarId, googleEventId);
      const updatedStart = updated.body?.start as { dateTime: string };
      expect(new Date(updatedStart.dateTime).toISOString()).toBe(updatedStartTime);
    } finally {
      // Every step here must be individually failure-tolerant so one
      // cleanup error doesn't mask the test result above.
      if (eventId && adminContext) {
        try {
          const adminPage = adminContext.pages()[0] ?? (await adminContext.newPage());
          // Also unsyncs from Google (best-effort, app-side).
          await adminPage.request.delete(`/api/events/${eventId}`);
        } catch (err) {
          console.error("calendar-sync cleanup: DELETE /api/events failed", err);
        }
      }
      if (eventId) {
        try {
          const accessToken = await getGoogleAccessToken();
          await deleteGoogleCalendarEvent(accessToken, e2eCalendarId(), toGoogleEventId(eventId));
        } catch (err) {
          console.error("calendar-sync cleanup: direct Google delete failed", err);
        }
      }
      if (adminContext) {
        try {
          await adminContext.close();
        } catch (err) {
          console.error("calendar-sync cleanup: context.close failed", err);
        }
      }
      await teardownFixtures(svc, {
        serviceWeekId,
        invitationId,
        googleTokenUserIds: [FIXTURE.memberUserId],
      });
    }
  });
});
