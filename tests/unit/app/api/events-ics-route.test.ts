// Tests for GET /api/events/:id/ics and GET /api/events/ics (#63 iCal export
// fallback). Mock scaffolding style mirrors
// tests/unit/app/api/events-route.test.ts (jest.mock for @clerk/nextjs/server
// and @/lib/supabase/client; fake UserLookup).

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({ getSupabaseClient: jest.fn() }));

import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { getSupabaseClient } from "@/lib/supabase/client";
import { exportEventIcs } from "@/app/api/events/[id]/ics/handler";
import { exportEventsIcs } from "@/app/api/events/ics/handler";
import type { AuthContext, UserLookup } from "@/lib/api/auth";

const mockAuth = auth as unknown as jest.Mock;
const mockGetSupabaseClient = getSupabaseClient as unknown as jest.Mock;

const JWT = "supabase-jwt";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const CHURCH_GROUP_ID = "group-1";
const EVENT_ID = "22222222-2222-4222-8222-222222222222";
const EVENT_ID_2 = "33333333-3333-4333-8333-333333333333";
const SERVICE_WEEK_ID = "44444444-4444-4444-8444-444444444444";

function makeReq(searchParams: Record<string, string> = {}): NextRequest {
  return {
    json: jest.fn().mockResolvedValue(undefined),
    nextUrl: { searchParams: new URLSearchParams(searchParams) },
  } as unknown as NextRequest;
}

function makeLookup(): UserLookup {
  const ctx: AuthContext = { userId: USER_ID, churchGroupId: CHURCH_GROUP_ID, role: "member" };
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
};

const eventRow = {
  id: EVENT_ID,
  name: "Full band rehearsal",
  location: "Main hall",
  notes: "Bring in-ears",
  start_time: "2026-07-12T09:00:00.000Z",
  end_time: "2026-07-12T11:00:00.000Z",
  service_week_id: SERVICE_WEEK_ID,
};

const eventRow2 = {
  id: EVENT_ID_2,
  name: "Sound check",
  location: null,
  notes: null,
  start_time: "2026-07-12T13:00:00.000Z",
  end_time: "2026-07-12T14:00:00.000Z",
  service_week_id: SERVICE_WEEK_ID,
};

const DEFAULT_FIXTURES: Record<string, TableFixture> = {
  event_attendees: {
    select: { data: { id: "attendee-1" }, error: null },
  },
  events: {
    select: { data: eventRow, error: null },
  },
};

// Generic chainable mock covering:
//   .select(...).eq(...).eq(...).maybeSingle()   (single-event attendee/event lookup)
//   .select(...).eq(...)                          (full export attendee rows, resolves via `then`)
//   .select(...).in(...).order(...)               (full export events query)
//   .select(...).in(...).eq(...).order(...)       (full export events query with serviceWeekId)
function makeChain(result: QueryResult) {
  const chain: Record<string, unknown> & PromiseLike<QueryResult> = {
    eq: jest.fn(() => chain),
    in: jest.fn(() => chain),
    order: jest.fn(() => Promise.resolve(result)),
    maybeSingle: jest.fn(() => Promise.resolve(result)),
    then: (resolve: (value: QueryResult) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  } as unknown as Record<string, unknown> & PromiseLike<QueryResult>;
  return chain;
}

function makeSupabaseClient(overrides: Partial<Record<string, TableFixture>> = {}) {
  const fixtures: Record<string, TableFixture> = {};
  for (const table of Object.keys(DEFAULT_FIXTURES)) {
    fixtures[table] = { ...DEFAULT_FIXTURES[table], ...overrides[table] };
  }

  return {
    from: jest.fn((table: string) => {
      const tableFixture = fixtures[table] ?? {};
      return {
        select: jest.fn(() => makeChain(tableFixture.select ?? { data: null, error: null })),
      };
    }),
  };
}

beforeEach(() => {
  mockAuth.mockReset();
  mockGetSupabaseClient.mockReset();
});

describe("GET /api/events/:id/ics", () => {
  it("returns 401 UNAUTHENTICATED when Clerk userId is null (lookup never consulted)", async () => {
    mockAuth.mockResolvedValue({ userId: null, getToken: jest.fn() });
    const lookup = jest.fn();

    const res = await exportEventIcs(makeReq(), EVENT_ID, lookup as unknown as UserLookup);
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("returns 401 UNAUTHENTICATED when getToken yields no JWT", async () => {
    setUpAuth(null);

    const res = await exportEventIcs(makeReq(), EVENT_ID, makeLookup());
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 404 NOT_FOUND when the caller is not an attendee of the event", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({ event_attendees: { select: { data: null, error: null } } }),
    );

    const res = await exportEventIcs(makeReq(), EVENT_ID, makeLookup());
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });

  it("returns 404 NOT_FOUND when the event itself does not exist", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({ events: { select: { data: null, error: null } } }),
    );

    const res = await exportEventIcs(makeReq(), EVENT_ID, makeLookup());
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });

  it("returns 500 INTERNAL when the attendee lookup errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        event_attendees: { select: { data: null, error: { message: "connection refused" } } },
      }),
    );

    const res = await exportEventIcs(makeReq(), EVENT_ID, makeLookup());
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });

  it("returns 500 INTERNAL when the events lookup errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        events: { select: { data: null, error: { message: "connection refused" } } },
      }),
    );

    const res = await exportEventIcs(makeReq(), EVENT_ID, makeLookup());
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });

  it("returns 200 with a single-VEVENT .ics attachment on success", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await exportEventIcs(makeReq(), EVENT_ID, makeLookup());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/calendar; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toBe(
      'attachment; filename="full-band-rehearsal.ics"',
    );

    const body = await res.text();
    expect(body.match(/BEGIN:VEVENT/g)?.length).toBe(1);
    expect(body).toContain(`UID:${EVENT_ID}@graceful.app`);
    expect(body).toContain("SUMMARY:Full band rehearsal");
  });
});

describe("GET /api/events/ics", () => {
  function makeFullExportSupabaseClient(
    overrides: Partial<Record<string, TableFixture>> = {},
  ) {
    return makeSupabaseClient({
      event_attendees: {
        select: {
          data: [{ event_id: EVENT_ID }, { event_id: EVENT_ID_2 }],
          error: null,
        },
      },
      events: { select: { data: [eventRow, eventRow2], error: null } },
      ...overrides,
    });
  }

  it("returns 401 UNAUTHENTICATED when Clerk userId is null (lookup never consulted)", async () => {
    mockAuth.mockResolvedValue({ userId: null, getToken: jest.fn() });
    const lookup = jest.fn();

    const res = await exportEventsIcs(makeReq(), lookup as unknown as UserLookup);
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("returns 401 UNAUTHENTICATED when getToken yields no JWT", async () => {
    setUpAuth(null);

    const res = await exportEventsIcs(makeReq(), makeLookup());
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 400 VALIDATION_FAILED for an invalid serviceWeekId", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeFullExportSupabaseClient());

    const res = await exportEventsIcs(makeReq({ serviceWeekId: "not-a-uuid" }), makeLookup());
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 404 NOT_FOUND when the caller has zero assigned events", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeFullExportSupabaseClient({
        event_attendees: { select: { data: [], error: null } },
      }),
    );

    const res = await exportEventsIcs(makeReq(), makeLookup());
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });

  it("returns 500 INTERNAL when the attendee rows query errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeFullExportSupabaseClient({
        event_attendees: { select: { data: null, error: { message: "connection refused" } } },
      }),
    );

    const res = await exportEventsIcs(makeReq(), makeLookup());
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });

  it("returns 500 INTERNAL when the events query errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeFullExportSupabaseClient({
        events: { select: { data: null, error: { message: "connection refused" } } },
      }),
    );

    const res = await exportEventsIcs(makeReq(), makeLookup());
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });

  it("returns 404 NOT_FOUND when serviceWeekId matches none of the caller's assigned events", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeFullExportSupabaseClient({ events: { select: { data: [], error: null } } }),
    );

    const res = await exportEventsIcs(
      makeReq({ serviceWeekId: "55555555-5555-4555-8555-555555555555" }),
      makeLookup(),
    );
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });

  it("returns 200 with all assigned events as VEVENTs on success", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeFullExportSupabaseClient());

    const res = await exportEventsIcs(makeReq(), makeLookup());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/calendar; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toBe(
      'attachment; filename="graceful-events.ics"',
    );

    const body = await res.text();
    expect(body.match(/BEGIN:VEVENT/g)?.length).toBe(2);
    expect(body).toContain(`UID:${EVENT_ID}@graceful.app`);
    expect(body).toContain(`UID:${EVENT_ID_2}@graceful.app`);
    // Null location/notes on eventRow2 must not emit empty LOCATION/DESCRIPTION lines.
    expect(body).not.toContain("LOCATION:\r\n");
  });

  it("returns 200 scoped to serviceWeekId when provided", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeFullExportSupabaseClient({ events: { select: { data: [eventRow], error: null } } }),
    );

    const res = await exportEventsIcs(
      makeReq({ serviceWeekId: SERVICE_WEEK_ID }),
      makeLookup(),
    );
    expect(res.status).toBe(200);

    const body = await res.text();
    expect(body.match(/BEGIN:VEVENT/g)?.length).toBe(1);
    expect(body).toContain(`UID:${EVENT_ID}@graceful.app`);
  });
});
