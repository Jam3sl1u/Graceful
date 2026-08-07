jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({ getSupabaseClient: jest.fn() }));

import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { getSupabaseClient } from "@/lib/supabase/client";
import { getServiceWeek, updateServiceWeek } from "@/app/api/service-weeks/[id]/handler";
import type { ServiceWeekResponse } from "@/app/api/service-weeks/handler";
import type { AuthContext, UserLookup } from "@/lib/api/auth";
import type { UserRole } from "@/types/domain";

const mockAuth = auth as unknown as jest.Mock;
const mockGetSupabaseClient = getSupabaseClient as unknown as jest.Mock;

const JWT = "supabase-jwt";
const USER_ID = "user-1";
const CHURCH_GROUP_ID = "group-1";
const WEEK_ID = "week-1";

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
};

const serviceWeekRow = {
  id: WEEK_ID,
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
  id: WEEK_ID,
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
    select: { data: serviceWeekRow, error: null },
    update: { data: serviceWeekRow, error: null },
  },
  invitations: {
    select: { data: [{ id: "invitation-1" }], error: null },
  },
};

// Generic chainable mock covering:
//   .select(...).eq(...).eq(...).maybeSingle()
//   .select(...).eq(...).eq(...).in(...).limit(1)  (guestHasWeekAccess, #72; awaited directly)
//   .update(...).eq(...).eq(...).select(...).maybeSingle()
function makeChain(result: QueryResult) {
  const chain: Record<string, unknown> & PromiseLike<QueryResult> = {
    eq: jest.fn(() => chain),
    in: jest.fn(() => chain),
    limit: jest.fn(() => chain),
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
      };
    }),
  };
}

beforeEach(() => {
  mockAuth.mockReset();
  mockGetSupabaseClient.mockReset();
});

describe("GET /api/service-weeks/[id]", () => {
  it("returns 401 UNAUTHENTICATED when Clerk userId is null (lookup never consulted)", async () => {
    mockAuth.mockResolvedValue({ userId: null, getToken: jest.fn() });
    const lookup = jest.fn();

    const res = await getServiceWeek(fakeReq, WEEK_ID, lookup as unknown as UserLookup);
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("returns 401 UNAUTHENTICATED when getToken yields no JWT", async () => {
    setUpAuth(null);

    const res = await getServiceWeek(fakeReq, WEEK_ID, makeLookup("member"));
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 200 for a member/leader/admin", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await getServiceWeek(fakeReq, WEEK_ID, makeLookup("member"));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data.serviceWeek).toEqual(serviceWeekResponse);
  });

  it("returns 200 for a guest with a matching invitation", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await getServiceWeek(fakeReq, WEEK_ID, makeLookup("guest"));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data.serviceWeek).toEqual(serviceWeekResponse);
  });

  it("returns 404 NOT_FOUND for a guest with no invitation for that week (not 403)", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({ invitations: { select: { data: null, error: null } } }),
    );

    const res = await getServiceWeek(fakeReq, WEEK_ID, makeLookup("guest"));
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });

  it("returns 404 NOT_FOUND when the id does not match any row (or belongs to another tenant)", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({ service_weeks: { select: { data: null, error: null } } }),
    );

    const res = await getServiceWeek(fakeReq, "missing-id", makeLookup("member"));
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });

  it("returns 500 INTERNAL when the service_weeks query errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        service_weeks: { select: { data: null, error: { message: "connection refused" } } },
      }),
    );

    const res = await getServiceWeek(fakeReq, WEEK_ID, makeLookup("member"));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });

  it("returns 500 INTERNAL when the guest invitation query errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        invitations: { select: { data: null, error: { message: "connection refused" } } },
      }),
    );

    const res = await getServiceWeek(fakeReq, WEEK_ID, makeLookup("guest"));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });
});

describe("PUT /api/service-weeks/[id]", () => {
  it("returns 401 UNAUTHENTICATED when Clerk userId is null (lookup never consulted)", async () => {
    mockAuth.mockResolvedValue({ userId: null, getToken: jest.fn() });
    const lookup = jest.fn();

    const res = await updateServiceWeek(
      makeReq({ title: "New title" }),
      WEEK_ID,
      lookup as unknown as UserLookup,
    );
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("returns 401 UNAUTHENTICATED when getToken yields no JWT", async () => {
    setUpAuth(null);

    const res = await updateServiceWeek(
      makeReq({ title: "New title" }),
      WEEK_ID,
      makeLookup("admin"),
    );
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 403 FORBIDDEN for a member", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await updateServiceWeek(
      makeReq({ title: "New title" }),
      WEEK_ID,
      makeLookup("member"),
    );
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.code).toBe("FORBIDDEN");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 403 FORBIDDEN for a guest", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await updateServiceWeek(
      makeReq({ title: "New title" }),
      WEEK_ID,
      makeLookup("guest"),
    );
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.code).toBe("FORBIDDEN");
  });

  it("returns 400 VALIDATION_FAILED for an empty body {}", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await updateServiceWeek(makeReq({}), WEEK_ID, makeLookup("admin"));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("returns 400 VALIDATION_FAILED for a malformed/non-JSON body", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await updateServiceWeek(makeReq(null), WEEK_ID, makeLookup("admin"));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("returns 400 VALIDATION_FAILED for a bad serviceDate format", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await updateServiceWeek(
      makeReq({ serviceDate: "07/12/2026" }),
      WEEK_ID,
      makeLookup("admin"),
    );
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("writes only the provided fields, mapped to snake_case", async () => {
    setUpAuth();
    let capturedPayload: unknown;
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient(
        {
          service_weeks: {
            update: { data: { ...serviceWeekRow, title: "New title" }, error: null },
          },
        },
        { onUpdate: (table, payload) => (capturedPayload = payload) },
      ),
    );

    const res = await updateServiceWeek(
      makeReq({ title: "New title" }),
      WEEK_ID,
      makeLookup("admin"),
    );
    expect(res.status).toBe(200);

    expect(capturedPayload).toEqual({ title: "New title" });

    const body = await res.json();
    expect(body.data.serviceWeek.title).toBe("New title");
  });

  it("returns 404 NOT_FOUND when no row matched the id + tenant", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({ service_weeks: { update: { data: null, error: null } } }),
    );

    const res = await updateServiceWeek(
      makeReq({ title: "New title" }),
      "missing-id",
      makeLookup("admin"),
    );
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });

  it("returns 500 INTERNAL when the update errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        service_weeks: { update: { data: null, error: { message: "constraint violation" } } },
      }),
    );

    const res = await updateServiceWeek(
      makeReq({ title: "New title" }),
      WEEK_ID,
      makeLookup("admin"),
    );
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });
});
