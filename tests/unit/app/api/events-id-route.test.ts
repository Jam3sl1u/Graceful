jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({ getSupabaseClient: jest.fn() }));

import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { getSupabaseClient } from "@/lib/supabase/client";
import { updateEvent, deleteEvent } from "@/app/api/events/[id]/handler";
import type { AuthContext, UserLookup } from "@/lib/api/auth";
import type { UserRole } from "@/types/domain";

const mockAuth = auth as unknown as jest.Mock;
const mockGetSupabaseClient = getSupabaseClient as unknown as jest.Mock;

const JWT = "supabase-jwt";
const USER_ID = "user-1";
const CHURCH_GROUP_ID = "group-1";
const WEEK_ID = "week-1";
const EVENT_ID = "event-1";

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
  update?: QueryResult;
  delete?: QueryResult;
};

const eventRow = {
  id: EVENT_ID,
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

const serviceWeekRow = {
  id: WEEK_ID,
  service_date: "2026-07-12",
};

const DEFAULT_FIXTURES: Record<string, TableFixture> = {
  events: {
    select: { data: eventRow, error: null },
    update: { data: eventRow, error: null },
    delete: { data: { id: EVENT_ID }, error: null },
  },
  service_weeks: {
    select: { data: serviceWeekRow, error: null },
  },
};

// Generic chainable mock covering:
//   .select(...).eq(...).eq(...).maybeSingle()
//   .update(...).eq(...).eq(...).select(...).maybeSingle()
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
    onUpdate?: (table: string, payload: unknown) => void;
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
        update: jest.fn((payload: unknown) => {
          hooks?.onUpdate?.(table, payload);
          return makeChain(tableFixture.update ?? { data: null, error: null });
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
});

describe("PUT /api/events/[id]", () => {
  it("returns 401 UNAUTHENTICATED when Clerk userId is null (lookup never consulted)", async () => {
    mockAuth.mockResolvedValue({ userId: null, getToken: jest.fn() });
    const lookup = jest.fn();

    const res = await updateEvent(
      makeReq({ name: "New name" }),
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

    const res = await updateEvent(makeReq({ name: "New name" }), EVENT_ID, makeLookup("admin"));
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it.each<UserRole>(["member", "guest"])("returns 403 FORBIDDEN for a '%s'", async (role) => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await updateEvent(makeReq({ name: "New name" }), EVENT_ID, makeLookup(role));
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.code).toBe("FORBIDDEN");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("allows a set_leader to update", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await updateEvent(
      makeReq({ name: "New name" }),
      EVENT_ID,
      makeLookup("set_leader"),
    );
    expect(res.status).toBe(200);
  });

  it("returns 400 VALIDATION_FAILED for an empty body {}", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await updateEvent(makeReq({}), EVENT_ID, makeLookup("admin"));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("returns 400 VALIDATION_FAILED for a malformed/non-JSON body", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await updateEvent(makeReq(null), EVENT_ID, makeLookup("admin"));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("returns 400 VALIDATION_FAILED for a bad type enum value", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await updateEvent(makeReq({ type: "banquet" }), EVENT_ID, makeLookup("admin"));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("returns 404 NOT_FOUND when the id does not match any row (or belongs to another tenant)", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({ events: { select: { data: null, error: null } } }),
    );

    const res = await updateEvent(makeReq({ name: "New name" }), "missing-id", makeLookup("admin"));
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });

  it("returns 500 INTERNAL when the existing-event lookup errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        events: { select: { data: null, error: { message: "connection refused" } } },
      }),
    );

    const res = await updateEvent(makeReq({ name: "New name" }), EVENT_ID, makeLookup("admin"));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });

  it("skips the BR-10 re-check when neither startTime nor endTime is present", async () => {
    setUpAuth();
    const client = makeSupabaseClient();
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await updateEvent(makeReq({ name: "New name" }), EVENT_ID, makeLookup("admin"));
    expect(res.status).toBe(200);
    // service_weeks should never be queried when times aren't changing.
    const calledTables = (client.from as jest.Mock).mock.calls.map(([t]) => t);
    expect(calledTables).not.toContain("service_weeks");
  });

  it("re-runs BR-10 using the existing endTime when only startTime is provided, and 422s on violation", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    // existing end_time is 2026-07-12T11:00:00.000Z; pushing start after it
    // should trip the order check even though endTime isn't in the body.
    const res = await updateEvent(
      makeReq({ startTime: "2026-07-12T12:00:00.000Z" }),
      EVENT_ID,
      makeLookup("admin"),
    );
    expect(res.status).toBe(422);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("re-runs BR-10 using the existing startTime when only endTime is provided, and accepts a valid change", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await updateEvent(
      makeReq({ endTime: "2026-07-12T12:00:00.000Z" }),
      EVENT_ID,
      makeLookup("admin"),
    );
    expect(res.status).toBe(200);
  });

  it("returns 422 VALIDATION_FAILED when the new times violate the 72h window", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await updateEvent(
      makeReq({
        startTime: "2026-07-20T09:00:00.000Z",
        endTime: "2026-07-20T11:00:00.000Z",
      }),
      EVENT_ID,
      makeLookup("admin"),
    );
    expect(res.status).toBe(422);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("returns 500 INTERNAL when the parent service_weeks lookup errors during BR-10 re-check", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        service_weeks: { select: { data: null, error: { message: "connection refused" } } },
      }),
    );

    const res = await updateEvent(
      makeReq({ startTime: "2026-07-12T10:00:00.000Z" }),
      EVENT_ID,
      makeLookup("admin"),
    );
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });

  it("writes only the provided fields, mapped to snake_case", async () => {
    setUpAuth();
    let capturedPayload: unknown;
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient(
        {
          events: { update: { data: { ...eventRow, name: "New name" }, error: null } },
        },
        { onUpdate: (table, payload) => (capturedPayload = payload) },
      ),
    );

    const res = await updateEvent(makeReq({ name: "New name" }), EVENT_ID, makeLookup("admin"));
    expect(res.status).toBe(200);

    expect(capturedPayload).toEqual({ name: "New name" });

    const body = await res.json();
    expect(body.data.event.name).toBe("New name");
  });

  it("clears location when explicitly set to null", async () => {
    setUpAuth();
    let capturedPayload: unknown;
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient(
        {
          events: { update: { data: { ...eventRow, location: null }, error: null } },
        },
        { onUpdate: (table, payload) => (capturedPayload = payload) },
      ),
    );

    const res = await updateEvent(makeReq({ location: null }), EVENT_ID, makeLookup("admin"));
    expect(res.status).toBe(200);

    expect(capturedPayload).toEqual({ location: null });

    const body = await res.json();
    expect(body.data.event.location).toBeNull();
  });

  it("leaves location unchanged when omitted from the patch", async () => {
    setUpAuth();
    let capturedPayload: unknown;
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient(
        {},
        { onUpdate: (table, payload) => (capturedPayload = payload) },
      ),
    );

    const res = await updateEvent(makeReq({ name: "New name" }), EVENT_ID, makeLookup("admin"));
    expect(res.status).toBe(200);
    expect(capturedPayload).not.toHaveProperty("location");
  });

  it("returns 404 NOT_FOUND when the update itself matches no row (cross-tenant race)", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({ events: { update: { data: null, error: null } } }),
    );

    const res = await updateEvent(makeReq({ name: "New name" }), EVENT_ID, makeLookup("admin"));
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });

  it("returns 500 INTERNAL when the update errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        events: { update: { data: null, error: { message: "constraint violation" } } },
      }),
    );

    const res = await updateEvent(makeReq({ name: "New name" }), EVENT_ID, makeLookup("admin"));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });
});

describe("DELETE /api/events/[id]", () => {
  it("returns 401 UNAUTHENTICATED when Clerk userId is null (lookup never consulted)", async () => {
    mockAuth.mockResolvedValue({ userId: null, getToken: jest.fn() });
    const lookup = jest.fn();

    const res = await deleteEvent(fakeReq, EVENT_ID, lookup as unknown as UserLookup);
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("returns 401 UNAUTHENTICATED when getToken yields no JWT", async () => {
    setUpAuth(null);

    const res = await deleteEvent(fakeReq, EVENT_ID, makeLookup("admin"));
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it.each<UserRole>(["member", "guest"])("returns 403 FORBIDDEN for a '%s'", async (role) => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await deleteEvent(fakeReq, EVENT_ID, makeLookup(role));
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.code).toBe("FORBIDDEN");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("allows a set_leader to delete", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await deleteEvent(fakeReq, EVENT_ID, makeLookup("set_leader"));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data).toEqual({ deleted: true });
  });

  it("returns 404 NOT_FOUND when the id does not match any row (or belongs to another tenant)", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({ events: { delete: { data: null, error: null } } }),
    );

    const res = await deleteEvent(fakeReq, "missing-id", makeLookup("admin"));
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });

  it("scopes the delete to id + church_group_id (tenant isolation)", async () => {
    setUpAuth();
    const capturedEqCalls: unknown[][] = [];
    const client = makeSupabaseClient();
    const originalFrom = client.from;
    client.from = jest.fn((table: string) => {
      const result = originalFrom(table);
      if (table === "events") {
        const originalDelete = result.delete;
        result.delete = jest.fn(() => {
          const chain = originalDelete();
          const originalEq = chain.eq as jest.Mock;
          chain.eq = jest.fn((...args: unknown[]) => {
            capturedEqCalls.push(args);
            return originalEq(...args);
          });
          return chain;
        });
      }
      return result;
    });
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await deleteEvent(fakeReq, EVENT_ID, makeLookup("admin"));
    expect(res.status).toBe(200);
    expect(capturedEqCalls).toEqual([
      ["id", EVENT_ID],
      ["church_group_id", CHURCH_GROUP_ID],
    ]);
  });

  it("returns 500 INTERNAL when the delete errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        events: { delete: { data: null, error: { message: "fk violation" } } },
      }),
    );

    const res = await deleteEvent(fakeReq, EVENT_ID, makeLookup("admin"));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });
});
