jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({ getSupabaseClient: jest.fn() }));
jest.mock("@/lib/google-calendar/sync", () => ({
  syncEventToUser: jest.fn(),
  unsyncEventFromUser: jest.fn(),
}));

import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { getSupabaseClient } from "@/lib/supabase/client";
import {
  assignAttendee,
  removeAttendee,
  toAttendeeResponse,
} from "@/app/api/events/[id]/attendees/handler";
import { syncEventToUser, unsyncEventFromUser } from "@/lib/google-calendar/sync";
import type { AuthContext, UserLookup } from "@/lib/api/auth";
import type { UserRole } from "@/types/domain";

const mockAuth = auth as unknown as jest.Mock;
const mockGetSupabaseClient = getSupabaseClient as unknown as jest.Mock;
const mockSyncEventToUser = syncEventToUser as unknown as jest.Mock;
const mockUnsyncEventFromUser = unsyncEventFromUser as unknown as jest.Mock;

const JWT = "supabase-jwt";
const USER_ID = "user-1";
const CHURCH_GROUP_ID = "group-1";
const WEEK_ID = "week-1";
const EVENT_ID = "event-1";
const TARGET_USER_ID = "22222222-2222-2222-2222-222222222222";
const ATTENDEE_ID = "attendee-1";

const fakeReq = {} as NextRequest;

function makeReq(body?: unknown): NextRequest {
  return {
    json: jest.fn().mockResolvedValue(body),
  } as unknown as NextRequest;
}

function makeLookup(role: UserRole): UserLookup {
  const ctx: AuthContext = {
    userId: USER_ID,
    churchGroupId: CHURCH_GROUP_ID,
    role,
  };
  return async () => ctx;
}

function setUpAuth(jwt: string | null = JWT) {
  mockAuth.mockResolvedValue({
    userId: "clerk_test",
    getToken: jest.fn().mockResolvedValue(jwt),
  });
}

type QueryResult = { data: unknown; error: unknown };
type TableFixture = {
  select?: QueryResult;
  insert?: QueryResult;
  delete?: QueryResult;
};

const eventRow = {
  id: EVENT_ID,
  church_group_id: CHURCH_GROUP_ID,
  service_week_id: WEEK_ID,
};

const invitationRow = { id: "invitation-1" };

const attendeeRow = {
  id: ATTENDEE_ID,
  event_id: EVENT_ID,
  user_id: TARGET_USER_ID,
  created_at: "2026-07-10T00:00:00.000Z",
};

const DEFAULT_FIXTURES: Record<string, TableFixture> = {
  events: {
    select: { data: eventRow, error: null },
  },
  invitations: {
    select: { data: invitationRow, error: null },
  },
  event_attendees: {
    select: { data: null, error: null }, // no existing attendee by default
    insert: { data: attendeeRow, error: null },
    delete: { data: { id: ATTENDEE_ID }, error: null },
  },
};

// Generic chainable mock covering:
//   .select(...).eq(...).eq(...).maybeSingle()
//   .insert(...).select(...).maybeSingle()
//   .delete().eq(...).eq(...).select(...).maybeSingle()
function makeChain(result: QueryResult) {
  const chain: Record<string, unknown> & PromiseLike<QueryResult> = {
    eq: jest.fn(() => chain),
    select: jest.fn(() => chain),
    maybeSingle: jest.fn(() => Promise.resolve(result)),
    then: (resolve: (value: QueryResult) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  } as unknown as Record<string, unknown> & PromiseLike<QueryResult>;
  return chain;
}

function makeSupabaseClient(
  overrides: Partial<Record<string, TableFixture>> = {},
  hooks?: {
    onInsert?: (table: string, payload: unknown) => void;
    onDelete?: (table: string) => void;
  },
) {
  const fixtures: Record<string, TableFixture> = {};
  for (const table of Object.keys(DEFAULT_FIXTURES)) {
    fixtures[table] = { ...DEFAULT_FIXTURES[table], ...overrides[table] };
  }

  return {
    from: jest.fn((table: string) => {
      const tableFixture = fixtures[table] ?? {};
      return {
        select: jest.fn(() => makeChain(tableFixture.select ?? { data: null, error: null })),
        insert: jest.fn((payload: unknown) => {
          hooks?.onInsert?.(table, payload);
          return makeChain(tableFixture.insert ?? { data: null, error: null });
        }),
        delete: jest.fn(() => {
          hooks?.onDelete?.(table);
          return makeChain(tableFixture.delete ?? { data: null, error: null });
        }),
      };
    }),
  };
}

beforeEach(() => {
  mockAuth.mockReset();
  mockGetSupabaseClient.mockReset();
  mockSyncEventToUser.mockReset().mockResolvedValue(undefined);
  mockUnsyncEventFromUser.mockReset().mockResolvedValue(undefined);
});

describe("toAttendeeResponse", () => {
  it("maps a row to camelCase", () => {
    expect(toAttendeeResponse(attendeeRow as never)).toEqual({
      id: ATTENDEE_ID,
      eventId: EVENT_ID,
      userId: TARGET_USER_ID,
      createdAt: "2026-07-10T00:00:00.000Z",
    });
  });
});

describe("POST /api/events/[id]/attendees (assignAttendee)", () => {
  it("returns 201 with the attendee on the happy path", async () => {
    setUpAuth();
    let capturedPayload: unknown;
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({}, { onInsert: (_table, payload) => (capturedPayload = payload) }),
    );

    const res = await assignAttendee(
      makeReq({ userId: TARGET_USER_ID }),
      EVENT_ID,
      makeLookup("admin"),
    );
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.data.attendee).toEqual({
      id: ATTENDEE_ID,
      eventId: EVENT_ID,
      userId: TARGET_USER_ID,
      createdAt: "2026-07-10T00:00:00.000Z",
    });
    expect(capturedPayload).toEqual({ event_id: EVENT_ID, user_id: TARGET_USER_ID });
  });

  it("allows a set_leader to assign", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await assignAttendee(
      makeReq({ userId: TARGET_USER_ID }),
      EVENT_ID,
      makeLookup("set_leader"),
    );
    expect(res.status).toBe(201);
  });

  it("returns 401 UNAUTHENTICATED when Clerk userId is null (lookup never consulted)", async () => {
    mockAuth.mockResolvedValue({ userId: null, getToken: jest.fn() });
    const lookup = jest.fn();

    const res = await assignAttendee(
      makeReq({ userId: TARGET_USER_ID }),
      EVENT_ID,
      lookup as unknown as UserLookup,
    );
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("returns 401 UNAUTHENTICATED when getToken yields no JWT", async () => {
    setUpAuth(null);

    const res = await assignAttendee(
      makeReq({ userId: TARGET_USER_ID }),
      EVENT_ID,
      makeLookup("admin"),
    );
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it.each<UserRole>(["member", "guest"])("returns 403 FORBIDDEN for a '%s'", async (role) => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await assignAttendee(makeReq({ userId: TARGET_USER_ID }), EVENT_ID, makeLookup(role));
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.code).toBe("FORBIDDEN");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 400 VALIDATION_FAILED for a missing userId", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await assignAttendee(makeReq({}), EVENT_ID, makeLookup("admin"));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("returns 400 VALIDATION_FAILED for a non-uuid userId", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await assignAttendee(makeReq({ userId: "not-a-uuid" }), EVENT_ID, makeLookup("admin"));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("returns 400 VALIDATION_FAILED for a malformed/non-JSON body", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await assignAttendee(makeReq(null), EVENT_ID, makeLookup("admin"));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("returns 404 NOT_FOUND when the event is missing or belongs to another tenant, without querying invitations", async () => {
    setUpAuth();
    const client = makeSupabaseClient({ events: { select: { data: null, error: null } } });
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await assignAttendee(
      makeReq({ userId: TARGET_USER_ID }),
      "missing-id",
      makeLookup("admin"),
    );
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");

    const calledTables = (client.from as jest.Mock).mock.calls.map(([t]) => t);
    expect(calledTables).not.toContain("invitations");
  });

  it("returns 500 INTERNAL when the event lookup errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        events: { select: { data: null, error: { message: "connection refused" } } },
      }),
    );

    const res = await assignAttendee(makeReq({ userId: TARGET_USER_ID }), EVENT_ID, makeLookup("admin"));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });

  it("returns 422 VALIDATION_FAILED when the target member has no accepted invitation for this week", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({ invitations: { select: { data: null, error: null } } }),
    );

    const res = await assignAttendee(makeReq({ userId: TARGET_USER_ID }), EVENT_ID, makeLookup("admin"));
    expect(res.status).toBe(422);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("returns 500 INTERNAL when the invitation lookup errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        invitations: { select: { data: null, error: { message: "connection refused" } } },
      }),
    );

    const res = await assignAttendee(makeReq({ userId: TARGET_USER_ID }), EVENT_ID, makeLookup("admin"));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });

  it("returns 409 CONFLICT when the member is already assigned, without attempting an insert", async () => {
    setUpAuth();
    const client = makeSupabaseClient({
      event_attendees: { select: { data: { id: ATTENDEE_ID }, error: null } },
    });
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await assignAttendee(makeReq({ userId: TARGET_USER_ID }), EVENT_ID, makeLookup("admin"));
    expect(res.status).toBe(409);

    const body = await res.json();
    expect(body.code).toBe("CONFLICT");

    const eventAttendeesInstance = (client.from as jest.Mock).mock.results.find(
      (_r, i) => (client.from as jest.Mock).mock.calls[i][0] === "event_attendees",
    );
    // insert should never have been invoked on event_attendees
    expect(eventAttendeesInstance?.value.insert).not.toHaveBeenCalled();
  });

  it("returns 500 INTERNAL when the duplicate-check lookup errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        event_attendees: { select: { data: null, error: { message: "connection refused" } } },
      }),
    );

    const res = await assignAttendee(makeReq({ userId: TARGET_USER_ID }), EVENT_ID, makeLookup("admin"));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });

  it("returns 500 INTERNAL when the insert errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        event_attendees: { insert: { data: null, error: { message: "constraint violation" } } },
      }),
    );

    const res = await assignAttendee(makeReq({ userId: TARGET_USER_ID }), EVENT_ID, makeLookup("admin"));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });

  it("returns 500 INTERNAL when the insert returns no row despite no error", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        event_attendees: { insert: { data: null, error: null } },
      }),
    );

    const res = await assignAttendee(makeReq({ userId: TARGET_USER_ID }), EVENT_ID, makeLookup("admin"));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });

  it("pushes the new attendee's calendar when the event has a google_calendar_event_id (#62)", async () => {
    setUpAuth();
    const syncedEventRow = {
      ...eventRow,
      google_calendar_event_id: "gr-synced-event",
      name: "Full band rehearsal",
      location: "Main hall",
      notes: "Bring in-ears",
      start_time: "2026-07-12T09:00:00.000Z",
      end_time: "2026-07-12T11:00:00.000Z",
    };
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({ events: { select: { data: syncedEventRow, error: null } } }),
    );

    const res = await assignAttendee(
      makeReq({ userId: TARGET_USER_ID }),
      EVENT_ID,
      makeLookup("admin"),
    );
    expect(res.status).toBe(201);

    expect(mockSyncEventToUser).toHaveBeenCalledWith(
      expect.anything(),
      EVENT_ID,
      TARGET_USER_ID,
      expect.objectContaining({ googleEventId: "gr-synced-event", name: "Full band rehearsal" }),
    );
  });

  it("skips the calendar push when the event has no google_calendar_event_id", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await assignAttendee(
      makeReq({ userId: TARGET_USER_ID }),
      EVENT_ID,
      makeLookup("admin"),
    );
    expect(res.status).toBe(201);
    expect(mockSyncEventToUser).not.toHaveBeenCalled();
  });

  it("never fails the assignment when syncEventToUser rejects", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        events: { select: { data: { ...eventRow, google_calendar_event_id: "gr-x" }, error: null } },
      }),
    );
    mockSyncEventToUser.mockRejectedValue(new Error("google outage"));

    const res = await assignAttendee(
      makeReq({ userId: TARGET_USER_ID }),
      EVENT_ID,
      makeLookup("admin"),
    );
    expect(res.status).toBe(201);
  });
});

describe("DELETE /api/events/[id]/attendees/[userId] (removeAttendee)", () => {
  it("returns 200 with { deleted: true } on the happy path", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await removeAttendee(fakeReq, EVENT_ID, TARGET_USER_ID, makeLookup("admin"));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data).toEqual({ deleted: true });
  });

  it("allows a set_leader to remove", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await removeAttendee(fakeReq, EVENT_ID, TARGET_USER_ID, makeLookup("set_leader"));
    expect(res.status).toBe(200);
  });

  it("returns 401 UNAUTHENTICATED when Clerk userId is null (lookup never consulted)", async () => {
    mockAuth.mockResolvedValue({ userId: null, getToken: jest.fn() });
    const lookup = jest.fn();

    const res = await removeAttendee(
      fakeReq,
      EVENT_ID,
      TARGET_USER_ID,
      lookup as unknown as UserLookup,
    );
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("returns 401 UNAUTHENTICATED when getToken yields no JWT", async () => {
    setUpAuth(null);

    const res = await removeAttendee(fakeReq, EVENT_ID, TARGET_USER_ID, makeLookup("admin"));
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it.each<UserRole>(["member", "guest"])("returns 403 FORBIDDEN for a '%s'", async (role) => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await removeAttendee(fakeReq, EVENT_ID, TARGET_USER_ID, makeLookup(role));
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.code).toBe("FORBIDDEN");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 404 NOT_FOUND when the event is missing or belongs to another tenant, without attempting a delete", async () => {
    setUpAuth();
    const client = makeSupabaseClient({ events: { select: { data: null, error: null } } });
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await removeAttendee(fakeReq, "missing-id", TARGET_USER_ID, makeLookup("admin"));
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");

    const calledTables = (client.from as jest.Mock).mock.calls.map(([t]) => t);
    expect(calledTables).not.toContain("event_attendees");
  });

  it("returns 500 INTERNAL when the event lookup errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        events: { select: { data: null, error: { message: "connection refused" } } },
      }),
    );

    const res = await removeAttendee(fakeReq, EVENT_ID, TARGET_USER_ID, makeLookup("admin"));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });

  it("returns 404 NOT_FOUND when the member was not assigned (nothing deleted)", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({ event_attendees: { delete: { data: null, error: null } } }),
    );

    const res = await removeAttendee(fakeReq, EVENT_ID, TARGET_USER_ID, makeLookup("admin"));
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });

  it("returns 500 INTERNAL when the delete errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        event_attendees: { delete: { data: null, error: { message: "fk violation" } } },
      }),
    );

    const res = await removeAttendee(fakeReq, EVENT_ID, TARGET_USER_ID, makeLookup("admin"));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });

  it("unsyncs from the removed attendee's calendar BEFORE deleting the row, when google_calendar_event_id is set (#62)", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        events: { select: { data: { ...eventRow, google_calendar_event_id: "gr-synced-event" }, error: null } },
      }),
    );

    const res = await removeAttendee(fakeReq, EVENT_ID, TARGET_USER_ID, makeLookup("admin"));
    expect(res.status).toBe(200);

    expect(mockUnsyncEventFromUser).toHaveBeenCalledWith(
      expect.anything(),
      EVENT_ID,
      TARGET_USER_ID,
      "gr-synced-event",
    );
  });

  it("skips the calendar unsync when the event has no google_calendar_event_id", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await removeAttendee(fakeReq, EVENT_ID, TARGET_USER_ID, makeLookup("admin"));
    expect(res.status).toBe(200);
    expect(mockUnsyncEventFromUser).not.toHaveBeenCalled();
  });

  it("never fails the removal when unsyncEventFromUser rejects", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        events: { select: { data: { ...eventRow, google_calendar_event_id: "gr-x" }, error: null } },
      }),
    );
    mockUnsyncEventFromUser.mockRejectedValue(new Error("google outage"));

    const res = await removeAttendee(fakeReq, EVENT_ID, TARGET_USER_ID, makeLookup("admin"));
    expect(res.status).toBe(200);
  });
});
