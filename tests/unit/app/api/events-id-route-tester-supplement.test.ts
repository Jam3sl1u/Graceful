// Tester supplement for #62 (Google Calendar event sync — event handlers).
//
// The coder's own changes.md explicitly flagged this as worth extra scrutiny:
//   "Ordering-dependent paths: deleteEvent ... reads Google Calendar sync
//   targets *before* the destructive DB write (because event_attendees
//   cascades/rows disappear after). Worth an integration-style check that
//   the RPC call genuinely happens first, not just that the mocked function
//   was called with the right arguments."
//
// events-id-route.test.ts only asserts unsyncEventFromAttendees was called
// with the right args — it never proves *when* relative to the DB delete.
// This file independently proves real call ordering via a shared marker
// array, plus one genuine failure case: unsyncEventFromAttendees rejecting
// must not block the delete, and must still be invoked before the delete
// call is issued (not after a failed sync short-circuits anything).

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({ getSupabaseClient: jest.fn() }));
jest.mock("@/lib/google-calendar/sync", () => ({
  syncEventToAttendees: jest.fn(),
  unsyncEventFromAttendees: jest.fn(),
  toGoogleEventId: jest.fn((id: string) => `mock-google-id-${id}`),
}));

import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { getSupabaseClient } from "@/lib/supabase/client";
import { deleteEvent } from "@/app/api/events/[id]/handler";
import { unsyncEventFromAttendees } from "@/lib/google-calendar/sync";
import type { AuthContext, UserLookup } from "@/lib/api/auth";

const mockAuth = auth as unknown as jest.Mock;
const mockGetSupabaseClient = getSupabaseClient as unknown as jest.Mock;
const mockUnsyncEventFromAttendees = unsyncEventFromAttendees as unknown as jest.Mock;

const USER_ID = "user-1";
const CHURCH_GROUP_ID = "group-1";
const EVENT_ID = "event-1";
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

// Builds a real (non-generic-chain) supabase fake whose `events.delete()`
// records a marker in `callOrder` the *instant* it's invoked — this proves
// whether the handler called unsync before issuing the delete, rather than
// merely asserting the mocked unsync function's arguments after the fact.
function makeOrderTrackingClient(callOrder: string[]) {
  return {
    from: jest.fn((table: string) => {
      if (table !== "events") throw new Error(`unexpected table: ${table}`);
      return {
        select: jest.fn(() => ({
          eq: jest.fn(() => ({
            eq: jest.fn(() => ({
              maybeSingle: jest.fn(() =>
                Promise.resolve({
                  data: { google_calendar_event_id: GOOGLE_EVENT_ID },
                  error: null,
                }),
              ),
            })),
          })),
        })),
        delete: jest.fn(() => {
          callOrder.push("delete-issued");
          return {
            eq: jest.fn(() => ({
              eq: jest.fn(() => ({
                select: jest.fn(() => ({
                  maybeSingle: jest.fn(() =>
                    Promise.resolve({ data: { id: EVENT_ID }, error: null }),
                  ),
                })),
              })),
            })),
          };
        }),
      };
    }),
  };
}

beforeEach(() => {
  mockAuth.mockReset();
  mockGetSupabaseClient.mockReset();
  mockUnsyncEventFromAttendees.mockReset();
});

describe("tester supplement: DELETE /api/events/[id] — genuine unsync-before-delete ordering", () => {
  it("issues the Google Calendar unsync call before the DB delete is issued, not just with the right args", async () => {
    setUpAuth();
    const callOrder: string[] = [];
    mockUnsyncEventFromAttendees.mockImplementation(async () => {
      callOrder.push("unsync-called");
    });
    mockGetSupabaseClient.mockReturnValue(makeOrderTrackingClient(callOrder));

    const res = await deleteEvent(fakeReq, EVENT_ID, makeLookup());
    expect(res.status).toBe(200);

    // The real assertion the coder's own test doesn't make: unsync must be
    // observed to happen strictly before the DB delete call is issued.
    expect(callOrder).toEqual(["unsync-called", "delete-issued"]);
  });

  it("still issues the DB delete (and returns 200) even when unsyncEventFromAttendees rejects, preserving ordering", async () => {
    setUpAuth();
    const callOrder: string[] = [];
    mockUnsyncEventFromAttendees.mockImplementation(async () => {
      callOrder.push("unsync-called");
      throw new Error("google outage");
    });
    mockGetSupabaseClient.mockReturnValue(makeOrderTrackingClient(callOrder));

    const res = await deleteEvent(fakeReq, EVENT_ID, makeLookup());
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data).toEqual({ deleted: true });
    // Even on a sync failure, the delete must still happen, and only after
    // the (failed) unsync attempt.
    expect(callOrder).toEqual(["unsync-called", "delete-issued"]);
  });
});
