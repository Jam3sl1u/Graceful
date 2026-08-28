// Tester supplement for #62 (Google Calendar event sync — attendee handlers).
//
// Same concern as events-id-route-tester-supplement.test.ts: the coder's own
// changes.md flags removeAttendee as another ordering-dependent path (unsync
// must be read/pushed BEFORE the event_attendees row is deleted, since
// get_event_sync_targets joins on event_attendees). events-id-attendees-
// route.test.ts only asserts unsyncEventFromUser was called with the right
// args, never that it happened first. This file proves real ordering via a
// shared marker array.
//
// It also independently verifies the signature deviation documented in
// changes.md ("syncEventToUser`/`unsyncEventFromUser` take an additional
// eventId parameter") is actually what the handler passes — a real spec
// consistency check, not just a mock-call assertion already in the main
// suite.

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({ getSupabaseClient: jest.fn() }));
jest.mock("@/lib/google-calendar/sync", () => ({
  syncEventToUser: jest.fn(),
  unsyncEventFromUser: jest.fn(),
}));

import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { getSupabaseClient } from "@/lib/supabase/client";
import { removeAttendee } from "@/app/api/events/[id]/attendees/handler";
import { unsyncEventFromUser } from "@/lib/google-calendar/sync";
import type { AuthContext, UserLookup } from "@/lib/api/auth";

const mockAuth = auth as unknown as jest.Mock;
const mockGetSupabaseClient = getSupabaseClient as unknown as jest.Mock;
const mockUnsyncEventFromUser = unsyncEventFromUser as unknown as jest.Mock;

const USER_ID = "user-1";
const CHURCH_GROUP_ID = "group-1";
const EVENT_ID = "event-1";
const TARGET_USER_ID = "22222222-2222-4222-8222-222222222222";
const GOOGLE_EVENT_ID = "gr-real-ordering-check";

const fakeReq = {} as NextRequest;

function makeLookup(): UserLookup {
  const ctx: AuthContext = { userId: USER_ID, churchGroupId: CHURCH_GROUP_ID, role: "admin" };
  return async () => ctx;
}

function setUpAuth() {
  mockAuth.mockResolvedValue({
    userId: "clerk_test",
    getToken: jest.fn().mockResolvedValue("supabase-jwt"),
  });
}

function makeOrderTrackingClient(callOrder: string[]) {
  return {
    from: jest.fn((table: string) => {
      if (table === "events") {
        return {
          select: jest.fn(() => ({
            eq: jest.fn(() => ({
              eq: jest.fn(() => ({
                maybeSingle: jest.fn(() =>
                  Promise.resolve({
                    data: { id: EVENT_ID, google_calendar_event_id: GOOGLE_EVENT_ID },
                    error: null,
                  }),
                ),
              })),
            })),
          })),
        };
      }
      if (table === "event_attendees") {
        return {
          delete: jest.fn(() => {
            callOrder.push("attendee-delete-issued");
            return {
              eq: jest.fn(() => ({
                eq: jest.fn(() => ({
                  select: jest.fn(() => ({
                    maybeSingle: jest.fn(() =>
                      Promise.resolve({ data: { id: "attendee-1" }, error: null }),
                    ),
                  })),
                })),
              })),
            };
          }),
        };
      }
      throw new Error(`unexpected table: ${table}`);
    }),
  };
}

beforeEach(() => {
  mockAuth.mockReset();
  mockGetSupabaseClient.mockReset();
  mockUnsyncEventFromUser.mockReset();
});

describe("tester supplement: DELETE /api/events/[id]/attendees/[userId] — genuine unsync-before-delete ordering", () => {
  it("issues the Google Calendar unsync call before the attendee-row delete is issued", async () => {
    setUpAuth();
    const callOrder: string[] = [];
    mockUnsyncEventFromUser.mockImplementation(async () => {
      callOrder.push("unsync-called");
    });
    mockGetSupabaseClient.mockReturnValue(makeOrderTrackingClient(callOrder));

    const res = await removeAttendee(fakeReq, EVENT_ID, TARGET_USER_ID, makeLookup());
    expect(res.status).toBe(200);

    expect(callOrder).toEqual(["unsync-called", "attendee-delete-issued"]);
  });

  it("passes (supabase, eventId, userId, googleEventId) — the spec-deviation signature documented in changes.md", async () => {
    setUpAuth();
    const callOrder: string[] = [];
    mockUnsyncEventFromUser.mockResolvedValue(undefined);
    mockGetSupabaseClient.mockReturnValue(makeOrderTrackingClient(callOrder));

    await removeAttendee(fakeReq, EVENT_ID, TARGET_USER_ID, makeLookup());

    expect(mockUnsyncEventFromUser).toHaveBeenCalledWith(
      expect.anything(),
      EVENT_ID,
      TARGET_USER_ID,
      GOOGLE_EVENT_ID,
    );
  });

  it("still issues the attendee delete (and returns 200) even when unsyncEventFromUser rejects, preserving ordering", async () => {
    setUpAuth();
    const callOrder: string[] = [];
    mockUnsyncEventFromUser.mockImplementation(async () => {
      callOrder.push("unsync-called");
      throw new Error("google outage");
    });
    mockGetSupabaseClient.mockReturnValue(makeOrderTrackingClient(callOrder));

    const res = await removeAttendee(fakeReq, EVENT_ID, TARGET_USER_ID, makeLookup());
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data).toEqual({ deleted: true });
    expect(callOrder).toEqual(["unsync-called", "attendee-delete-issued"]);
  });
});
