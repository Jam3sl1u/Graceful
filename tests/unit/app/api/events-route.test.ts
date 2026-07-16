jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({ getSupabaseClient: jest.fn() }));
jest.mock("@/lib/google-calendar/sync", () => ({
  syncEventToAttendees: jest.fn(),
  toGoogleEventId: jest.fn((id: string) => `mock-google-id-${id}`),
}));

import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { getSupabaseClient } from "@/lib/supabase/client";
import { listEvents, createEvent, type EventResponse } from "@/app/api/events/handler";
import { syncEventToAttendees, toGoogleEventId } from "@/lib/google-calendar/sync";
import type { AuthContext, UserLookup } from "@/lib/api/auth";
import type { UserRole } from "@/types/domain";

const mockAuth = auth as unknown as jest.Mock;
const mockGetSupabaseClient = getSupabaseClient as unknown as jest.Mock;
const mockSyncEventToAttendees = syncEventToAttendees as unknown as jest.Mock;
const mockToGoogleEventId = toGoogleEventId as unknown as jest.Mock;

const JWT = "supabase-jwt";
const USER_ID = "user-1";
const CHURCH_GROUP_ID = "group-1";
const WEEK_ID = "22222222-2222-2222-2222-222222222222";

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
};

const eventRow = {
  id: "event-1",
  church_group_id: CHURCH_GROUP_ID,
  service_week_id: WEEK_ID,
  type: "rehearsal",
  name: "Full band rehearsal",
  location: "Main hall",
  start_time: "2026-07-12T09:00:00.000Z",
  end_time: "2026-07-12T11:00:00.000Z",
  notes: "Bring in-ears",
  created_by: USER_ID,
  created_at: "2026-07-01T00:00:00Z",
};

const eventResponse: EventResponse = {
  id: "event-1",
  serviceWeekId: WEEK_ID,
  type: "rehearsal",
  name: "Full band rehearsal",
  location: "Main hall",
  startTime: "2026-07-12T09:00:00.000Z",
  endTime: "2026-07-12T11:00:00.000Z",
  notes: "Bring in-ears",
  createdBy: USER_ID,
  createdAt: "2026-07-01T00:00:00Z",
};

const serviceWeekRow = {
  id: WEEK_ID,
  service_date: "2026-07-12",
};

const DEFAULT_FIXTURES: Record<string, TableFixture> = {
  events: {
    select: { data: [eventRow], error: null },
    insert: { data: eventRow, error: null },
  },
  invitations: {
    select: { data: [{ service_week_id: WEEK_ID }], error: null },
  },
  service_weeks: {
    select: { data: serviceWeekRow, error: null },
  },
};

// Generic chainable mock covering:
//   .select(...).eq(...).order(...)
//   .select(...).eq(...).in(...).order(...)
//   .select(...).eq(...)                     (invitations, resolves via `then`)
//   .select(...).eq(...).eq(...).maybeSingle()  (service_weeks lookup)
//   .insert(...).select(...).maybeSingle()
function makeChain(result: QueryResult) {
  const chain: Record<string, unknown> & PromiseLike<QueryResult> = {
    eq: jest.fn(() => chain),
    order: jest.fn(() => chain),
    in: jest.fn(() => chain),
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
      };
    }),
  };
}

beforeEach(() => {
  mockAuth.mockReset();
  mockGetSupabaseClient.mockReset();
  mockSyncEventToAttendees.mockReset().mockResolvedValue(undefined);
  mockToGoogleEventId.mockReset().mockImplementation((id: string) => `mock-google-id-${id}`);
});

describe("GET /api/events", () => {
  it("returns 401 UNAUTHENTICATED when Clerk userId is null (lookup never consulted)", async () => {
    mockAuth.mockResolvedValue({ userId: null, getToken: jest.fn() });
    const lookup = jest.fn();

    const res = await listEvents(fakeReq, lookup as unknown as UserLookup);
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("returns 401 UNAUTHENTICATED when getToken yields no JWT", async () => {
    setUpAuth(null);

    const res = await listEvents(fakeReq, makeLookup("member"));
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns every event in the group for an admin", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await listEvents(fakeReq, makeLookup("admin"));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data.events).toEqual([eventResponse]);
  });

  it("does not expose google_calendar_event_id even if the row has one", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        events: {
          select: {
            data: [{ ...eventRow, google_calendar_event_id: "gcal-123" }],
            error: null,
          },
        },
      }),
    );

    const res = await listEvents(fakeReq, makeLookup("admin"));
    const body = await res.json();
    expect(body.data.events[0]).not.toHaveProperty("googleCalendarEventId");
    expect(body.data.events[0]).not.toHaveProperty("google_calendar_event_id");
  });

  it.each<UserRole>(["set_leader", "member", "guest"])(
    "restricts a '%s' to events for service weeks they're invited to",
    async (role) => {
      setUpAuth();
      mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

      const res = await listEvents(fakeReq, makeLookup(role));
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.events).toEqual([eventResponse]);
    },
  );

  it.each<UserRole>(["set_leader", "member", "guest"])(
    "returns an empty list for a '%s' with zero invitations (never another group's events)",
    async (role) => {
      setUpAuth();
      mockGetSupabaseClient.mockReturnValue(
        makeSupabaseClient({ invitations: { select: { data: [], error: null } } }),
      );

      const res = await listEvents(fakeReq, makeLookup(role));
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.events).toEqual([]);
    },
  );

  it("returns 500 INTERNAL when the events query errors for an admin", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        events: { select: { data: null, error: { message: "connection refused" } } },
      }),
    );

    const res = await listEvents(fakeReq, makeLookup("admin"));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });

  it("returns 500 INTERNAL when the invitations query errors for a non-admin", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        invitations: { select: { data: null, error: { message: "connection refused" } } },
      }),
    );

    const res = await listEvents(fakeReq, makeLookup("member"));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });

  it("returns 500 INTERNAL when the scoped events query errors for a non-admin", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        events: { select: { data: null, error: { message: "connection refused" } } },
      }),
    );

    const res = await listEvents(fakeReq, makeLookup("member"));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });
});

describe("POST /api/events", () => {
  const validBody = {
    serviceWeekId: WEEK_ID,
    type: "rehearsal",
    name: "Full band rehearsal",
    location: "Main hall",
    startTime: "2026-07-12T09:00:00.000Z",
    endTime: "2026-07-12T11:00:00.000Z",
    notes: "Bring in-ears",
  };

  it("returns 401 UNAUTHENTICATED when Clerk userId is null (lookup never consulted)", async () => {
    mockAuth.mockResolvedValue({ userId: null, getToken: jest.fn() });
    const lookup = jest.fn();

    const res = await createEvent(makeReq(validBody), lookup as unknown as UserLookup);
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("returns 401 UNAUTHENTICATED when getToken yields no JWT", async () => {
    setUpAuth(null);

    const res = await createEvent(makeReq(validBody), makeLookup("admin"));
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it.each<UserRole>(["member", "guest"])(
    "returns 403 FORBIDDEN for a '%s'",
    async (role) => {
      setUpAuth();
      mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

      const res = await createEvent(makeReq(validBody), makeLookup(role));
      expect(res.status).toBe(403);

      const body = await res.json();
      expect(body.code).toBe("FORBIDDEN");
      expect(mockGetSupabaseClient).not.toHaveBeenCalled();
    },
  );

  it("allows a set_leader to create", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await createEvent(makeReq(validBody), makeLookup("set_leader"));
    expect(res.status).toBe(201);
  });

  it("returns 400 VALIDATION_FAILED for a malformed/non-JSON body", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await createEvent(makeReq(null), makeLookup("admin"));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("returns 400 VALIDATION_FAILED for a missing name", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const { name: _name, ...bodyWithoutName } = validBody;
    const res = await createEvent(makeReq(bodyWithoutName), makeLookup("admin"));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("returns 400 VALIDATION_FAILED for a bad type enum value", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await createEvent(
      makeReq({ ...validBody, type: "banquet" }),
      makeLookup("admin"),
    );
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("returns 400 VALIDATION_FAILED for a non-uuid serviceWeekId", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await createEvent(
      makeReq({ ...validBody, serviceWeekId: "not-a-uuid" }),
      makeLookup("admin"),
    );
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("returns 400 VALIDATION_FAILED for a non-ISO datetime", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await createEvent(
      makeReq({ ...validBody, startTime: "not-a-date" }),
      makeLookup("admin"),
    );
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("returns 404 NOT_FOUND for an unknown/cross-group serviceWeekId (does not leak existence)", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({ service_weeks: { select: { data: null, error: null } } }),
    );

    const res = await createEvent(makeReq(validBody), makeLookup("admin"));
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });

  it("returns 500 INTERNAL when the service_weeks lookup errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        service_weeks: { select: { data: null, error: { message: "connection refused" } } },
      }),
    );

    const res = await createEvent(makeReq(validBody), makeLookup("admin"));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });

  it("returns 422 VALIDATION_FAILED (BR-10) when end_time equals start_time — syntactically valid body", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await createEvent(
      makeReq({ ...validBody, startTime: "2026-07-12T09:00:00.000Z", endTime: "2026-07-12T09:00:00.000Z" }),
      makeLookup("admin"),
    );
    expect(res.status).toBe(422);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("returns 422 VALIDATION_FAILED (BR-10) when times are more than 72h from service_date", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await createEvent(
      makeReq({
        ...validBody,
        startTime: "2026-07-20T09:00:00.000Z",
        endTime: "2026-07-20T11:00:00.000Z",
      }),
      makeLookup("admin"),
    );
    expect(res.status).toBe(422);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("returns 201 and the created event on success", async () => {
    setUpAuth();
    const capturedInserts: Record<string, unknown> = {};
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({}, { onInsert: (table, payload) => (capturedInserts[table] = payload) }),
    );

    const res = await createEvent(makeReq(validBody), makeLookup("admin"));
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.data.event).toEqual(eventResponse);

    expect(capturedInserts.events).toMatchObject({
      church_group_id: CHURCH_GROUP_ID,
      service_week_id: WEEK_ID,
      type: "rehearsal",
      name: "Full band rehearsal",
      location: "Main hall",
      start_time: "2026-07-12T09:00:00.000Z",
      end_time: "2026-07-12T11:00:00.000Z",
      notes: "Bring in-ears",
      created_by: USER_ID,
    });
  });

  it("stores null for omitted location/notes", async () => {
    setUpAuth();
    const capturedInserts: Record<string, unknown> = {};
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({}, { onInsert: (table, payload) => (capturedInserts[table] = payload) }),
    );

    const { location: _location, notes: _notes, ...bodyWithoutOptional } = validBody;
    const res = await createEvent(makeReq(bodyWithoutOptional), makeLookup("admin"));
    expect(res.status).toBe(201);

    expect(capturedInserts.events).toMatchObject({ location: null, notes: null });
  });

  it("returns 500 INTERNAL when the events insert errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        events: { insert: { data: null, error: { message: "constraint violation" } } },
      }),
    );

    const res = await createEvent(makeReq(validBody), makeLookup("admin"));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });

  it("persists a caller-assigned google_calendar_event_id on insert and best-effort syncs it (#62)", async () => {
    setUpAuth();
    const capturedInserts: Record<string, unknown> = {};
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({}, { onInsert: (table, payload) => (capturedInserts[table] = payload) }),
    );

    const res = await createEvent(makeReq(validBody), makeLookup("admin"));
    expect(res.status).toBe(201);

    const insertPayload = capturedInserts.events as Record<string, unknown>;
    expect(insertPayload.id).toEqual(expect.any(String));
    expect(insertPayload.google_calendar_event_id).toBe(`mock-google-id-${insertPayload.id}`);
    expect(mockToGoogleEventId).toHaveBeenCalledWith(insertPayload.id);
    expect(mockSyncEventToAttendees).toHaveBeenCalledWith(
      expect.anything(),
      eventRow.id,
      expect.objectContaining({ googleEventId: `mock-google-id-${insertPayload.id}` }),
    );
  });

  it("never fails event creation when syncEventToAttendees rejects", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());
    mockSyncEventToAttendees.mockRejectedValue(new Error("google outage"));

    const res = await createEvent(makeReq(validBody), makeLookup("admin"));
    expect(res.status).toBe(201);
  });
});
