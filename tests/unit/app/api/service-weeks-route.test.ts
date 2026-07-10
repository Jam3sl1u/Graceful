jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({ getSupabaseClient: jest.fn() }));

import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { getSupabaseClient } from "@/lib/supabase/client";
import {
  listServiceWeeks,
  createServiceWeek,
  type ServiceWeekResponse,
} from "@/app/api/service-weeks/handler";
import type { AuthContext, UserLookup } from "@/lib/api/auth";
import type { UserRole } from "@/types/domain";

const mockAuth = auth as unknown as jest.Mock;
const mockGetSupabaseClient = getSupabaseClient as unknown as jest.Mock;

const JWT = "supabase-jwt";
const USER_ID = "user-1";
const CHURCH_GROUP_ID = "group-1";

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

const serviceWeekRow = {
  id: "week-1",
  church_group_id: CHURCH_GROUP_ID,
  service_date: "2026-07-12",
  title: "Sunday Service",
  sermon_topic: "Grace",
  sermon_scripture: "Eph 2:8-9",
  speaker_name: "Pastor Kim",
  notes: null,
  is_cancelled: false,
  created_by: USER_ID,
  created_at: "2026-07-01T00:00:00Z",
};

const serviceWeekResponse: ServiceWeekResponse = {
  id: "week-1",
  serviceDate: "2026-07-12",
  title: "Sunday Service",
  sermonTopic: "Grace",
  sermonScripture: "Eph 2:8-9",
  speakerName: "Pastor Kim",
  notes: null,
  isCancelled: false,
  createdBy: USER_ID,
  createdAt: "2026-07-01T00:00:00Z",
};

const DEFAULT_FIXTURES: Record<string, TableFixture> = {
  service_weeks: {
    select: { data: [serviceWeekRow], error: null },
    insert: { data: serviceWeekRow, error: null },
  },
  invitations: {
    select: { data: [{ service_week_id: "week-1" }], error: null },
  },
  setlists: {
    insert: { data: null, error: null },
  },
};

// Generic chainable mock covering:
//   .select(...).eq(...).order(...)
//   .select(...).eq(...).in(...).order(...)
//   .eq(...).eq(...).maybeSingle()
//   .insert(...).select(...).maybeSingle()
//   .insert(...)                            (no further chaining, awaited directly)
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
});

describe("GET /api/service-weeks", () => {
  it("returns 401 UNAUTHENTICATED when Clerk userId is null (lookup never consulted)", async () => {
    mockAuth.mockResolvedValue({ userId: null, getToken: jest.fn() });
    const lookup = jest.fn();

    const res = await listServiceWeeks(fakeReq, lookup as unknown as UserLookup);
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("returns 401 UNAUTHENTICATED when getToken yields no JWT", async () => {
    setUpAuth(null);

    const res = await listServiceWeeks(fakeReq, makeLookup("member"));
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns all weeks in the group for a member/leader/admin", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await listServiceWeeks(fakeReq, makeLookup("member"));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data.serviceWeeks).toEqual([serviceWeekResponse]);
  });

  it("restricts a guest to weeks they have an invitation for", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await listServiceWeeks(fakeReq, makeLookup("guest"));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data.serviceWeeks).toEqual([serviceWeekResponse]);
  });

  it("returns an empty list for a guest with zero invitations", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({ invitations: { select: { data: [], error: null } } }),
    );

    const res = await listServiceWeeks(fakeReq, makeLookup("guest"));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data.serviceWeeks).toEqual([]);
  });

  it("returns 500 INTERNAL when the service_weeks query errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        service_weeks: { select: { data: null, error: { message: "connection refused" } } },
      }),
    );

    const res = await listServiceWeeks(fakeReq, makeLookup("member"));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });

  it("returns 500 INTERNAL when the guest invitations query errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        invitations: { select: { data: null, error: { message: "connection refused" } } },
      }),
    );

    const res = await listServiceWeeks(fakeReq, makeLookup("guest"));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });
});

describe("POST /api/service-weeks", () => {
  const validBody = {
    serviceDate: "2026-07-12",
    title: "Sunday Service",
    sermonTopic: "Grace",
    sermonScripture: "Eph 2:8-9",
    speakerName: "Pastor Kim",
  };

  it("returns 401 UNAUTHENTICATED when Clerk userId is null (lookup never consulted)", async () => {
    mockAuth.mockResolvedValue({ userId: null, getToken: jest.fn() });
    const lookup = jest.fn();

    const res = await createServiceWeek(makeReq(validBody), lookup as unknown as UserLookup);
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("returns 401 UNAUTHENTICATED when getToken yields no JWT", async () => {
    setUpAuth(null);

    const res = await createServiceWeek(makeReq(validBody), makeLookup("admin"));
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 403 FORBIDDEN for a member", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await createServiceWeek(makeReq(validBody), makeLookup("member"));
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.code).toBe("FORBIDDEN");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 403 FORBIDDEN for a guest", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await createServiceWeek(makeReq(validBody), makeLookup("guest"));
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.code).toBe("FORBIDDEN");
  });

  it.each(["title", "sermonTopic", "sermonScripture", "speakerName"])(
    "returns 400 VALIDATION_FAILED when %s is missing",
    async (field) => {
      setUpAuth();
      mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

      const bodyWithoutField = { ...validBody };
      delete (bodyWithoutField as Record<string, unknown>)[field];

      const res = await createServiceWeek(makeReq(bodyWithoutField), makeLookup("admin"));
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.code).toBe("VALIDATION_FAILED");
    },
  );

  it("returns 400 VALIDATION_FAILED when a field is empty/whitespace-only", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await createServiceWeek(
      makeReq({ ...validBody, title: "   " }),
      makeLookup("admin"),
    );
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("returns 400 VALIDATION_FAILED for a bad serviceDate format", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await createServiceWeek(
      makeReq({ ...validBody, serviceDate: "07/12/2026" }),
      makeLookup("admin"),
    );
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("returns 400 VALIDATION_FAILED for a malformed/non-JSON body", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await createServiceWeek(makeReq(null), makeLookup("admin"));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("returns 201, auto-creates a draft setlist", async () => {
    setUpAuth();
    const capturedInserts: Record<string, unknown> = {};
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({}, { onInsert: (table, payload) => (capturedInserts[table] = payload) }),
    );

    const res = await createServiceWeek(makeReq(validBody), makeLookup("admin"));
    expect(res.status).toBe(201);

    const body = await res.json();
    const serviceWeek: ServiceWeekResponse = body.data.serviceWeek;
    expect(serviceWeek).toEqual(serviceWeekResponse);

    expect(capturedInserts.service_weeks).toMatchObject({
      church_group_id: CHURCH_GROUP_ID,
      service_date: "2026-07-12",
      title: "Sunday Service",
      sermon_topic: "Grace",
      sermon_scripture: "Eph 2:8-9",
      speaker_name: "Pastor Kim",
      created_by: USER_ID,
    });

    expect(capturedInserts.setlists).toEqual({
      church_group_id: CHURCH_GROUP_ID,
      service_week_id: "week-1",
      created_by: USER_ID,
    });
    expect(capturedInserts.setlists).not.toHaveProperty("status");
  });

  it("returns 500 INTERNAL when the service_weeks insert errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        service_weeks: { insert: { data: null, error: { message: "constraint violation" } } },
      }),
    );

    const res = await createServiceWeek(makeReq(validBody), makeLookup("admin"));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });

  it("returns 500 INTERNAL when the setlist auto-insert errors after the week insert succeeds", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        setlists: { insert: { data: null, error: { message: "constraint violation" } } },
      }),
    );

    const res = await createServiceWeek(makeReq(validBody), makeLookup("admin"));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });
});
