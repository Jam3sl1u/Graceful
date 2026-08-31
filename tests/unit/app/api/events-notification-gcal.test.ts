// Coder-stage coverage for #69 OQ2 — the Google Calendar event email trigger
// gating in the event handlers. Per the OQ2 resolution: fire ONLY on a
// material change (start_time / end_time / location) or on attendee
// assignment; never on bare create or a notes-only edit.

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({ getSupabaseClient: jest.fn() }));
jest.mock("@/lib/google-calendar/sync", () => ({
  syncEventToAttendees: jest.fn().mockResolvedValue(undefined),
  unsyncEventFromAttendees: jest.fn().mockResolvedValue(undefined),
  syncEventToUser: jest.fn().mockResolvedValue(undefined),
  unsyncEventFromUser: jest.fn().mockResolvedValue(undefined),
  toGoogleEventId: jest.fn((id: string) => `gr${id}`),
}));
jest.mock("@/lib/notifications/event-email", () => ({
  dispatchGoogleCalendarEventEmail: jest.fn().mockResolvedValue(undefined),
}));

import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { getSupabaseClient } from "@/lib/supabase/client";
import { dispatchGoogleCalendarEventEmail } from "@/lib/notifications/event-email";
import { updateEvent } from "@/app/api/events/[id]/handler";
import { assignAttendee } from "@/app/api/events/[id]/attendees/handler";
import type { AuthContext, UserLookup } from "@/lib/api/auth";

const mockAuth = auth as unknown as jest.Mock;
const mockGetSupabaseClient = getSupabaseClient as unknown as jest.Mock;
const mockEmail = dispatchGoogleCalendarEventEmail as unknown as jest.Mock;

const GROUP_ID = "group-1";
const WEEK_ID = "week-1";
const EVENT_ID = "event-1";
const MEMBER_ID = "11111111-1111-4111-8111-111111111111";

function makeReq(body?: unknown): NextRequest {
  return { json: jest.fn().mockResolvedValue(body) } as unknown as NextRequest;
}
function lookup(): UserLookup {
  const ctx: AuthContext = { userId: "admin-1", churchGroupId: GROUP_ID, role: "admin" };
  return async () => ctx;
}
function setUpAuth() {
  mockAuth.mockResolvedValue({ userId: "clerk", getToken: jest.fn().mockResolvedValue("jwt") });
}

type QueryResult = { data: unknown; error: unknown };

const existingEvent = {
  id: EVENT_ID,
  church_group_id: GROUP_ID,
  service_week_id: WEEK_ID,
  type: "rehearsal",
  name: "Rehearsal",
  location: "Main Hall",
  start_time: "2026-07-12T09:00:00.000Z",
  end_time: "2026-07-12T11:00:00.000Z",
  notes: "Bring in-ears",
  created_by: "admin-1",
  created_at: "2026-07-01T00:00:00Z",
  google_calendar_event_id: "grexisting",
};
const serviceWeekRow = { id: WEEK_ID, service_date: "2026-07-12" };

function chain(result: QueryResult) {
  const c: Record<string, unknown> & PromiseLike<QueryResult> = {
    eq: jest.fn(() => c),
    select: jest.fn(() => c),
    maybeSingle: jest.fn(() => Promise.resolve(result)),
    then: (res: (v: QueryResult) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(res, rej),
  } as unknown as Record<string, unknown> & PromiseLike<QueryResult>;
  return c;
}

// events select -> existing; events update -> updatedRow; service_weeks -> week.
function makeSupabase(updatedRow: Record<string, unknown>, extra: Record<string, QueryResult[]> = {}) {
  const counts: Record<string, number> = {};
  const q: Record<string, QueryResult[]> = {
    events: [{ data: existingEvent, error: null }, { data: updatedRow, error: null }],
    service_weeks: [{ data: serviceWeekRow, error: null }],
    ...extra,
  };
  const next = (t: string) => {
    const arr = q[t] ?? [];
    const i = counts[t] ?? 0;
    counts[t] = i + 1;
    return arr[i] ?? arr[arr.length - 1] ?? { data: null, error: null };
  };
  return {
    from: jest.fn((t: string) => ({
      select: jest.fn(() => chain(next(t))),
      update: jest.fn(() => chain(next(t))),
      insert: jest.fn(() => chain(next(t))),
    })),
  };
}

beforeEach(() => {
  mockAuth.mockReset();
  mockGetSupabaseClient.mockReset();
  mockEmail.mockClear();
  setUpAuth();
});

describe("updateEvent — GCal email gating (OQ2)", () => {
  it("fires on a start_time change", async () => {
    mockGetSupabaseClient.mockReturnValue(
      makeSupabase({ ...existingEvent, start_time: "2026-07-12T10:00:00.000Z" }),
    );

    const res = await updateEvent(
      makeReq({ startTime: "2026-07-12T10:00:00.000Z" }),
      EVENT_ID,
      lookup(),
    );
    expect(res.status).toBe(200);
    expect(mockEmail).toHaveBeenCalledTimes(1);
    expect(mockEmail.mock.calls[0][1]).toMatchObject({ serviceWeekId: WEEK_ID });
  });

  it("fires on a location change", async () => {
    mockGetSupabaseClient.mockReturnValue(
      makeSupabase({ ...existingEvent, location: "Chapel" }),
    );

    await updateEvent(makeReq({ location: "Chapel" }), EVENT_ID, lookup());
    expect(mockEmail).toHaveBeenCalledTimes(1);
  });

  it("does NOT fire on a notes-only edit", async () => {
    mockGetSupabaseClient.mockReturnValue(
      makeSupabase({ ...existingEvent, notes: "New notes" }),
    );

    const res = await updateEvent(makeReq({ notes: "New notes" }), EVENT_ID, lookup());
    expect(res.status).toBe(200);
    expect(mockEmail).not.toHaveBeenCalled();
  });

  it("does NOT fire on a name-only edit", async () => {
    mockGetSupabaseClient.mockReturnValue(
      makeSupabase({ ...existingEvent, name: "Renamed" }),
    );

    await updateEvent(makeReq({ name: "Renamed" }), EVENT_ID, lookup());
    expect(mockEmail).not.toHaveBeenCalled();
  });
});

describe("assignAttendee — GCal email (OQ2)", () => {
  it("emails the newly assigned member only", async () => {
    const counts: Record<string, number> = {};
    const q: Record<string, QueryResult[]> = {
      events: [
        {
          data: {
            service_week_id: WEEK_ID,
            google_calendar_event_id: "grexisting",
            name: "Rehearsal",
            location: "Main Hall",
            notes: null,
            start_time: existingEvent.start_time,
            end_time: existingEvent.end_time,
          },
          error: null,
        },
      ],
      invitations: [{ data: { id: "inv-1" }, error: null }],
      event_attendees: [
        { data: null, error: null }, // existing-attendee check
        { data: { id: "att-1", event_id: EVENT_ID, user_id: MEMBER_ID, created_at: "x" }, error: null }, // insert
      ],
    };
    const next = (t: string) => {
      const arr = q[t] ?? [];
      const i = counts[t] ?? 0;
      counts[t] = i + 1;
      return arr[i] ?? arr[arr.length - 1] ?? { data: null, error: null };
    };
    mockGetSupabaseClient.mockReturnValue({
      from: jest.fn((t: string) => ({
        select: jest.fn(() => chain(next(t))),
        insert: jest.fn(() => chain(next(t))),
      })),
    });

    const res = await assignAttendee(makeReq({ userId: MEMBER_ID }), EVENT_ID, lookup());
    expect(res.status).toBe(201);
    expect(mockEmail).toHaveBeenCalledTimes(1);
    expect(mockEmail.mock.calls[0][1]).toMatchObject({
      serviceWeekId: WEEK_ID,
      recipientUserIds: [MEMBER_ID],
    });
  });
});
