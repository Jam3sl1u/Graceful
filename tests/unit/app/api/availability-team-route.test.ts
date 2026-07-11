jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({ getSupabaseClient: jest.fn() }));

import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { getSupabaseClient } from "@/lib/supabase/client";
import {
  getTeamAvailability,
  type TeamAvailabilityMember,
} from "@/app/api/availability/team/handler";
import type { AuthContext, UserLookup } from "@/lib/api/auth";
import type { UserRole } from "@/types/domain";

const mockAuth = auth as unknown as jest.Mock;
const mockGetSupabaseClient = getSupabaseClient as unknown as jest.Mock;

const JWT = "supabase-jwt";
const USER_ID = "user-1";
const CHURCH_GROUP_ID = "group-1";

function makeReq(opts: { query?: Record<string, string> } = {}): NextRequest {
  const searchParams = new URLSearchParams(opts.query ?? {});
  return { nextUrl: { searchParams } } as unknown as NextRequest;
}

function makeLookup(role: UserRole = "set_leader"): UserLookup {
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

function makeSupabaseClientForGet(result: QueryResult) {
  const order = jest.fn().mockResolvedValue(result);
  const lte = jest.fn(() => ({ order }));
  const gte = jest.fn(() => ({ lte }));
  const eq = jest.fn(() => ({ gte }));
  const select = jest.fn(() => ({ eq }));
  const from = jest.fn(() => ({ select }));
  return { from, select, eq, gte, lte, order };
}

const RANGE = { startDate: "2026-01-05", endDate: "2026-01-18" };

describe("GET /api/availability/team", () => {
  beforeEach(() => {
    mockAuth.mockReset();
    mockGetSupabaseClient.mockReset();
  });

  it("returns 401 UNAUTHENTICATED when Clerk userId is null (lookup never consulted)", async () => {
    mockAuth.mockResolvedValue({ userId: null, getToken: jest.fn() });
    const lookup = jest.fn();

    const res = await getTeamAvailability(
      makeReq({ query: RANGE }),
      lookup as unknown as UserLookup,
    );
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each<UserRole>(["member", "guest"])("returns 403 FORBIDDEN for role '%s'", async (role) => {
    setUpAuth();

    const res = await getTeamAvailability(makeReq({ query: RANGE }), makeLookup(role));
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.code).toBe("FORBIDDEN");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 401 UNAUTHENTICATED when getToken yields no JWT", async () => {
    setUpAuth(null);

    const res = await getTeamAvailability(makeReq({ query: RANGE }), makeLookup());
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 400 VALIDATION_FAILED when startDate/endDate are missing", async () => {
    setUpAuth();

    const res = await getTeamAvailability(makeReq(), makeLookup());
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("returns 400 VALIDATION_FAILED for an invalid calendar date", async () => {
    setUpAuth();

    const res = await getTeamAvailability(
      makeReq({ query: { startDate: "2026-02-30", endDate: "2026-03-01" } }),
      makeLookup(),
    );
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("returns 400 VALIDATION_FAILED when startDate is after endDate", async () => {
    setUpAuth();

    const res = await getTeamAvailability(
      makeReq({ query: { startDate: "2026-02-10", endDate: "2026-01-01" } }),
      makeLookup(),
    );
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("returns 400 VALIDATION_FAILED when the range exceeds MAX_TEAM_RANGE_DAYS", async () => {
    setUpAuth();

    const res = await getTeamAvailability(
      makeReq({ query: { startDate: "2026-01-01", endDate: "2026-12-31" } }),
      makeLookup(),
    );
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it.each<UserRole>(["set_leader", "admin"])(
    "returns 200 grouped by member for role '%s', scoped to the caller's church group",
    async (role) => {
      setUpAuth();
      const otherId = "user-2";
      const rows = [
        { user_id: USER_ID, date: "2026-01-05", is_available: true, note: null },
        { user_id: USER_ID, date: "2026-01-10", is_available: false, note: "Out of town" },
        { user_id: otherId, date: "2026-01-06", is_available: true, note: null },
      ];
      const client = makeSupabaseClientForGet({ data: rows, error: null });
      mockGetSupabaseClient.mockReturnValue(client);

      const res = await getTeamAvailability(makeReq({ query: RANGE }), makeLookup(role));
      expect(res.status).toBe(200);
      expect(client.eq).toHaveBeenCalledWith("church_group_id", CHURCH_GROUP_ID);
      expect(client.gte).toHaveBeenCalledWith("date", RANGE.startDate);
      expect(client.lte).toHaveBeenCalledWith("date", RANGE.endDate);

      const body = await res.json();
      expect(body.data.startDate).toBe(RANGE.startDate);
      expect(body.data.endDate).toBe(RANGE.endDate);
      const members: TeamAvailabilityMember[] = body.data.members;
      expect(members).toEqual([
        {
          userId: USER_ID,
          entries: [
            { date: "2026-01-05", isAvailable: true, note: null },
            { date: "2026-01-10", isAvailable: false, note: "Out of town" },
          ],
        },
        {
          userId: otherId,
          entries: [{ date: "2026-01-06", isAvailable: true, note: null }],
        },
      ]);
    },
  );

  it("returns 500 INTERNAL when the select returns an error", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClientForGet({ data: null, error: { message: "connection refused" } }),
    );

    const res = await getTeamAvailability(makeReq({ query: RANGE }), makeLookup());
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });

  it("returns 200 with members: [] when there are no stored rows", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClientForGet({ data: [], error: null }));

    const res = await getTeamAvailability(makeReq({ query: RANGE }), makeLookup());
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data.members).toEqual([]);
  });

  it("handles ~30 members over a 6-week range in a single query (volume smoke test)", async () => {
    setUpAuth();
    const MEMBER_COUNT = 30;
    const DAY_COUNT = 42; // 6 weeks
    const dates: string[] = [];
    const cursor = new Date("2026-01-01T00:00:00Z");
    for (let d = 0; d < DAY_COUNT; d++) {
      dates.push(cursor.toISOString().slice(0, 10));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    const rows: { user_id: string; date: string; is_available: boolean; note: string | null }[] =
      [];
    for (let m = 0; m < MEMBER_COUNT; m++) {
      for (const date of dates) {
        rows.push({ user_id: `member-${m}`, date, is_available: true, note: null });
      }
    }
    const client = makeSupabaseClientForGet({ data: rows, error: null });
    mockGetSupabaseClient.mockReturnValue(client);

    const rangeStart = dates.at(0) as string;
    const rangeEnd = dates.at(-1) as string;
    const res = await getTeamAvailability(
      makeReq({ query: { startDate: rangeStart, endDate: rangeEnd } }),
      makeLookup(),
    );
    expect(res.status).toBe(200);
    expect(client.from).toHaveBeenCalledTimes(1);

    const body = await res.json();
    const members: TeamAvailabilityMember[] = body.data.members;
    expect(members).toHaveLength(MEMBER_COUNT);
    for (const member of members) {
      expect(member.entries).toHaveLength(DAY_COUNT);
    }
  });
});
