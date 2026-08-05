jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({ getSupabaseClient: jest.fn() }));

import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { getSupabaseClient } from "@/lib/supabase/client";
import {
  getServiceWeeksOverview,
  type ServiceWeeksOverviewResponse,
} from "@/app/api/service-weeks/overview/handler";
import type { AuthContext, UserLookup } from "@/lib/api/auth";
import type { UserRole } from "@/types/domain";

const mockAuth = auth as unknown as jest.Mock;
const mockGetSupabaseClient = getSupabaseClient as unknown as jest.Mock;

const JWT = "supabase-jwt";
const USER_ID = "user-1";
const CHURCH_GROUP_ID = "group-1";
const WEEK_1 = "week-1";
const WEEK_2 = "week-2";

function makeReq(opts: { query?: Record<string, string> } = {}): NextRequest {
  const searchParams = new URLSearchParams(opts.query ?? {});
  return { nextUrl: { searchParams } } as unknown as NextRequest;
}

function makeLookup(role: UserRole = "admin"): UserLookup {
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

// Generic chainable mock — every method returns `chain` itself (so any
// combination of .eq/.gte/.lte/.in/.is/.order can be called in any order),
// and the chain is thenable so `await`-ing it yields `result` (mirrors
// tests/unit/app/api/service-weeks-member-view-route.test.ts).
function makeChain(result: QueryResult) {
  const chain: Record<string, unknown> & PromiseLike<QueryResult> = {
    eq: jest.fn(() => chain),
    gte: jest.fn(() => chain),
    lte: jest.fn(() => chain),
    in: jest.fn(() => chain),
    is: jest.fn(() => chain),
    order: jest.fn(() => chain),
    select: jest.fn(() => chain),
    then: (resolve: (value: QueryResult) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  } as unknown as Record<string, unknown> & PromiseLike<QueryResult>;
  return chain;
}

const weekRows = [
  { id: WEEK_1, service_date: "2026-07-19", title: "Sunday Service", is_cancelled: false },
  { id: WEEK_2, service_date: "2026-07-12", title: null, is_cancelled: true },
];

const setlistRows = [{ service_week_id: WEEK_1, status: "published" }];

// user-b is re-invited (stale denied row + newer accepted row) -> counts once
// as accepted. user-c's latest invitation is withdrawn -> excluded entirely.
const invitationRows = [
  { id: "inv-1", service_week_id: WEEK_1, user_id: "user-a", status: "accepted", created_at: "2026-07-01T00:00:00Z" },
  { id: "inv-2", service_week_id: WEEK_1, user_id: "user-b", status: "denied", created_at: "2026-07-01T00:00:00Z" },
  { id: "inv-3", service_week_id: WEEK_1, user_id: "user-b", status: "accepted", created_at: "2026-07-05T00:00:00Z" },
  { id: "inv-4", service_week_id: WEEK_1, user_id: "user-c", status: "withdrawn", created_at: "2026-07-02T00:00:00Z" },
  { id: "inv-5", service_week_id: WEEK_1, user_id: "user-d", status: "pending", created_at: "2026-07-03T00:00:00Z" },
  { id: "inv-6", service_week_id: WEEK_2, user_id: "user-e", status: "accepted", created_at: "2026-06-01T00:00:00Z" },
];

const conflictRows = [
  { id: "conflict-1", invitation_id: "inv-5" }, // maps to WEEK_1 via user-d's pending invitation
  { id: "conflict-2", invitation_id: "inv-does-not-exist" }, // orphan -> ignored, no crash
];

type Fixtures = {
  service_weeks: QueryResult;
  setlists: QueryResult;
  invitations: QueryResult;
  conflicts: QueryResult;
};

const DEFAULT_FIXTURES: Fixtures = {
  service_weeks: { data: weekRows, error: null },
  setlists: { data: setlistRows, error: null },
  invitations: { data: invitationRows, error: null },
  conflicts: { data: conflictRows, error: null },
};

function makeSupabaseClient(overrides: Partial<Fixtures> = {}) {
  const fixtures: Fixtures = { ...DEFAULT_FIXTURES, ...overrides };
  const chains: Partial<Record<keyof Fixtures, ReturnType<typeof makeChain>>> = {};
  const fromSpy = jest.fn((table: keyof Fixtures) => {
    if (!(table in fixtures)) {
      throw new Error(`Unexpected table: ${table}`);
    }
    const chain = makeChain(fixtures[table]);
    chains[table] = chain;
    return {
      select: jest.fn(() => chain),
    };
  });
  return { from: fromSpy, chains };
}

beforeEach(() => {
  mockAuth.mockReset();
  mockGetSupabaseClient.mockReset();
});

describe("GET /api/service-weeks/overview", () => {
  it("returns 401 UNAUTHENTICATED when Clerk userId is null (lookup never consulted)", async () => {
    mockAuth.mockResolvedValue({ userId: null, getToken: jest.fn() });
    const lookup = jest.fn();

    const res = await getServiceWeeksOverview(makeReq(), lookup as unknown as UserLookup);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each<UserRole>(["member", "guest"])("returns 403 FORBIDDEN for role '%s'", async (role) => {
    setUpAuth();

    const res = await getServiceWeeksOverview(makeReq(), makeLookup(role));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("FORBIDDEN");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 401 UNAUTHENTICATED when getToken yields no JWT", async () => {
    setUpAuth(null);

    const res = await getServiceWeeksOverview(makeReq(), makeLookup());
    expect(res.status).toBe(401);
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 400 VALIDATION_FAILED for an invalid calendar date", async () => {
    setUpAuth();

    const res = await getServiceWeeksOverview(
      makeReq({ query: { startDate: "2026-02-30" } }),
      makeLookup(),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("returns 400 VALIDATION_FAILED when startDate is after endDate", async () => {
    setUpAuth();

    const res = await getServiceWeeksOverview(
      makeReq({ query: { startDate: "2026-07-20", endDate: "2026-07-01" } }),
      makeLookup(),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("returns 400 VALIDATION_FAILED for an unknown status value", async () => {
    setUpAuth();

    const res = await getServiceWeeksOverview(
      makeReq({ query: { status: "bogus" } }),
      makeLookup(),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("returns 200 with serviceWeeks: [] and skips the follow-up queries when there are no weeks", async () => {
    setUpAuth();
    const client = makeSupabaseClient({ service_weeks: { data: [], error: null } });
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await getServiceWeeksOverview(makeReq(), makeLookup());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.serviceWeeks).toEqual([]);
    expect(client.from).not.toHaveBeenCalledWith("setlists");
    expect(client.from).not.toHaveBeenCalledWith("invitations");
    expect(client.from).not.toHaveBeenCalledWith("conflicts");
  });

  it("happy path: aggregates fill rate, setlist status, and open-conflict count per week", async () => {
    setUpAuth();
    const client = makeSupabaseClient();
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await getServiceWeeksOverview(makeReq(), makeLookup());
    expect(res.status).toBe(200);
    const body = await res.json();
    const data: ServiceWeeksOverviewResponse = body.data;

    expect(data.serviceWeeks).toEqual([
      {
        id: WEEK_1,
        serviceDate: "2026-07-19",
        title: "Sunday Service",
        isCancelled: false,
        setlistStatus: "published",
        // user-a accepted, user-b's latest (accepted) wins over its stale
        // denied row, user-c excluded (withdrawn), user-d pending counts the
        // denominator but not the numerator.
        confirmedCount: 2,
        rosterSize: 3,
        openConflictCount: 1,
      },
      {
        id: WEEK_2,
        serviceDate: "2026-07-12",
        title: null,
        isCancelled: true,
        setlistStatus: null,
        confirmedCount: 1,
        rosterSize: 1,
        openConflictCount: 0,
      },
    ]);

    // invitations never leaks response_token / denial_reason columns.
    expect(JSON.stringify(data)).not.toContain("response_token");
    expect(JSON.stringify(data)).not.toContain("denial_reason");
  });

  it("applies status=active by filtering is_cancelled = false", async () => {
    setUpAuth();
    const client = makeSupabaseClient();
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await getServiceWeeksOverview(makeReq({ query: { status: "active" } }), makeLookup());
    expect(res.status).toBe(200);
    expect(client.chains.service_weeks!.eq).toHaveBeenCalledWith("is_cancelled", false);
  });

  it("applies status=cancelled by filtering is_cancelled = true", async () => {
    setUpAuth();
    const client = makeSupabaseClient();
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await getServiceWeeksOverview(
      makeReq({ query: { status: "cancelled" } }),
      makeLookup(),
    );
    expect(res.status).toBe(200);
    expect(client.chains.service_weeks!.eq).toHaveBeenCalledWith("is_cancelled", true);
  });

  it("applies inclusive date bounds via gte/lte when provided", async () => {
    setUpAuth();
    const client = makeSupabaseClient();
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await getServiceWeeksOverview(
      makeReq({ query: { startDate: "2026-07-01", endDate: "2026-07-31" } }),
      makeLookup(),
    );
    expect(res.status).toBe(200);
    expect(client.chains.service_weeks!.gte).toHaveBeenCalledWith("service_date", "2026-07-01");
    expect(client.chains.service_weeks!.lte).toHaveBeenCalledWith("service_date", "2026-07-31");
  });

  it("returns 500 INTERNAL when the service_weeks query errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        service_weeks: { data: null, error: { message: "connection refused" } },
      }),
    );

    const res = await getServiceWeeksOverview(makeReq(), makeLookup());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });

  it("returns 500 INTERNAL when the conflicts query errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        conflicts: { data: null, error: { message: "connection refused" } },
      }),
    );

    const res = await getServiceWeeksOverview(makeReq(), makeLookup());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });
});
