// Independent tester-stage supplement for GET /api/service-weeks/overview
// (#74). Covers spec-named edge cases and failure paths not exercised by
// the coder's own tests/unit/app/api/service-weeks-overview-route.test.ts:
// tie-breaking on equal created_at, single-bound date filtering, status=all
// applying no is_cancelled filter, explicit invitations column selection,
// and 500 on the two queries (setlists / invitations) the coder's suite
// didn't independently cover with a DB error.

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

const mockAuth = auth as unknown as jest.Mock;
const mockGetSupabaseClient = getSupabaseClient as unknown as jest.Mock;

const JWT = "supabase-jwt";
const USER_ID = "user-1";
const CHURCH_GROUP_ID = "group-1";
const WEEK_1 = "week-1";

function makeReq(opts: { query?: Record<string, string> } = {}): NextRequest {
  const searchParams = new URLSearchParams(opts.query ?? {});
  return { nextUrl: { searchParams } } as unknown as NextRequest;
}

function makeLookup(): UserLookup {
  const ctx: AuthContext = { userId: USER_ID, churchGroupId: CHURCH_GROUP_ID, role: "admin" };
  return async () => ctx;
}

function setUpAuth(jwt: string | null = JWT) {
  mockAuth.mockResolvedValue({
    userId: "clerk_test",
    getToken: jest.fn().mockResolvedValue(jwt),
  });
}

type QueryResult = { data: unknown; error: unknown };

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
];

type Fixtures = {
  service_weeks: QueryResult;
  setlists: QueryResult;
  invitations: QueryResult;
  conflicts: QueryResult;
};

const DEFAULT_FIXTURES: Fixtures = {
  service_weeks: { data: weekRows, error: null },
  setlists: { data: [], error: null },
  invitations: { data: [], error: null },
  conflicts: { data: [], error: null },
};

function makeSupabaseClient(overrides: Partial<Fixtures> = {}) {
  const fixtures: Fixtures = { ...DEFAULT_FIXTURES, ...overrides };
  const chains: Partial<Record<keyof Fixtures, ReturnType<typeof makeChain>>> = {};
  const selectSpies: Partial<Record<keyof Fixtures, jest.Mock>> = {};
  const fromSpy = jest.fn((table: keyof Fixtures) => {
    if (!(table in fixtures)) {
      throw new Error(`Unexpected table: ${table}`);
    }
    const chain = makeChain(fixtures[table]);
    chains[table] = chain;
    const selectSpy = jest.fn(() => chain);
    selectSpies[table] = selectSpy;
    return { select: selectSpy };
  });
  return { from: fromSpy, chains, selectSpies };
}

beforeEach(() => {
  mockAuth.mockReset();
  mockGetSupabaseClient.mockReset();
});

describe("GET /api/service-weeks/overview — tester supplement", () => {
  it("tie-break: on equal created_at, keeps the first encountered row (not the last)", async () => {
    setUpAuth();
    // Both rows share the same created_at; the first one (denied) must win,
    // per the spec's "replace only when strictly greater" rule.
    const client = makeSupabaseClient({
      invitations: {
        data: [
          {
            id: "inv-1",
            service_week_id: WEEK_1,
            user_id: "user-a",
            status: "denied",
            created_at: "2026-07-01T00:00:00Z",
          },
          {
            id: "inv-2",
            service_week_id: WEEK_1,
            user_id: "user-a",
            status: "accepted",
            created_at: "2026-07-01T00:00:00Z",
          },
        ],
        error: null,
      },
    });
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await getServiceWeeksOverview(makeReq(), makeLookup());
    expect(res.status).toBe(200);
    const body = await res.json();
    const data: ServiceWeeksOverviewResponse = body.data;

    // user-a's first-seen row is "denied" (not withdrawn) -> counts toward
    // rosterSize but not confirmedCount, since the tie keeps the first row.
    expect(data.serviceWeeks[0]!.rosterSize).toBe(1);
    expect(data.serviceWeeks[0]!.confirmedCount).toBe(0);
  });

  it("applies only the gte bound when only startDate is supplied (lte not called)", async () => {
    setUpAuth();
    const client = makeSupabaseClient();
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await getServiceWeeksOverview(
      makeReq({ query: { startDate: "2026-07-01" } }),
      makeLookup(),
    );
    expect(res.status).toBe(200);
    expect(client.chains.service_weeks!.gte).toHaveBeenCalledWith("service_date", "2026-07-01");
    expect(client.chains.service_weeks!.lte).not.toHaveBeenCalled();
  });

  it("applies only the lte bound when only endDate is supplied (gte not called)", async () => {
    setUpAuth();
    const client = makeSupabaseClient();
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await getServiceWeeksOverview(
      makeReq({ query: { endDate: "2026-07-31" } }),
      makeLookup(),
    );
    expect(res.status).toBe(200);
    expect(client.chains.service_weeks!.lte).toHaveBeenCalledWith("service_date", "2026-07-31");
    expect(client.chains.service_weeks!.gte).not.toHaveBeenCalled();
  });

  it("status=all (default) never filters on is_cancelled", async () => {
    setUpAuth();
    const client = makeSupabaseClient();
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await getServiceWeeksOverview(makeReq(), makeLookup());
    expect(res.status).toBe(200);
    const eqCalls = (client.chains.service_weeks!.eq as jest.Mock).mock.calls;
    expect(eqCalls.some(([col]) => col === "is_cancelled")).toBe(false);
  });

  it("selects explicit invitation columns only (never a wildcard select)", async () => {
    setUpAuth();
    const client = makeSupabaseClient();
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await getServiceWeeksOverview(makeReq(), makeLookup());
    expect(res.status).toBe(200);
    const selectArg = client.selectSpies.invitations!.mock.calls[0]?.[0] as string;
    expect(selectArg).not.toContain("*");
    expect(selectArg).toBe("id, service_week_id, user_id, status, created_at");
  });

  it("returns 500 INTERNAL when the setlists query errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({ setlists: { data: null, error: { message: "boom" } } }),
    );

    const res = await getServiceWeeksOverview(makeReq(), makeLookup());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
    expect(JSON.stringify(body)).not.toContain("boom");
  });

  it("returns 500 INTERNAL when the invitations query errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({ invitations: { data: null, error: { message: "boom" } } }),
    );

    const res = await getServiceWeeksOverview(makeReq(), makeLookup());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
    expect(JSON.stringify(body)).not.toContain("boom");
  });

  it("rejects an unknown JWT/session edge case: getToken throws is not swallowed as success", async () => {
    // Failure case: auth() itself resolves but getToken rejects — the
    // handler's outer try/catch must still surface a clean error, not a
    // raw stack trace or a 200.
    mockAuth.mockResolvedValue({
      userId: "clerk_test",
      getToken: jest.fn().mockRejectedValue(new Error("token service unavailable")),
    });

    const res = await getServiceWeeksOverview(makeReq(), makeLookup());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("token service unavailable");
  });
});
