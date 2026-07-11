jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({ getSupabaseClient: jest.fn() }));

import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { getSupabaseClient } from "@/lib/supabase/client";
import { deleteServiceWeek } from "@/app/api/service-weeks/[id]/handler";
import type { AuthContext, UserLookup } from "@/lib/api/auth";
import type { UserRole } from "@/types/domain";

const mockAuth = auth as unknown as jest.Mock;
const mockGetSupabaseClient = getSupabaseClient as unknown as jest.Mock;

const JWT = "supabase-jwt";
const USER_ID = "user-1";
const CHURCH_GROUP_ID = "group-1";
const WEEK_ID = "week-1";

const fakeReq = {} as NextRequest;

// Computed relative to the real clock (not hardcoded) so this suite stays
// valid regardless of when it's run.
function daysFromToday(offset: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}
const FUTURE_DATE = daysFromToday(30);
const PAST_DATE = daysFromToday(-30);
const TODAY = daysFromToday(0);

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
  delete?: QueryResult;
};

// Generic chainable mock covering:
//   .select(...).eq(...).eq(...).maybeSingle()   (service_weeks lookup)
//   .select(...).eq(...).eq(...)                 (invitations count, no maybeSingle — resolves via `then`)
//   .delete().eq(...).eq(...)                    (resolves via `then`)
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

const DEFAULT_FIXTURES: Record<string, TableFixture> = {
  service_weeks: {
    select: { data: { id: WEEK_ID, service_date: FUTURE_DATE }, error: null },
    delete: { data: null, error: null },
  },
  invitations: {
    select: { data: [], error: null },
  },
};

function makeSupabaseClient(
  overrides: Partial<Record<string, TableFixture>> = {},
  hooks?: { onDelete?: (table: string) => void },
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

describe("DELETE /api/service-weeks/[id]", () => {
  it("returns 401 UNAUTHENTICATED when Clerk userId is null (lookup never consulted)", async () => {
    mockAuth.mockResolvedValue({ userId: null, getToken: jest.fn() });
    const lookup = jest.fn();

    const res = await deleteServiceWeek(fakeReq, WEEK_ID, lookup as unknown as UserLookup);
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("returns 401 UNAUTHENTICATED when getToken yields no JWT", async () => {
    setUpAuth(null);

    const res = await deleteServiceWeek(fakeReq, WEEK_ID, makeLookup("admin"));
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it.each<UserRole>(["member", "set_leader", "guest"])(
    "returns 403 FORBIDDEN for a '%s' (admin only — unlike PUT, set_leader is not allowed)",
    async (role) => {
      setUpAuth();
      mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

      const res = await deleteServiceWeek(fakeReq, WEEK_ID, makeLookup(role));
      expect(res.status).toBe(403);

      const body = await res.json();
      expect(body.code).toBe("FORBIDDEN");
      expect(mockGetSupabaseClient).not.toHaveBeenCalled();
    },
  );

  it("returns 404 NOT_FOUND when the id does not match any row (or belongs to another tenant)", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({ service_weeks: { select: { data: null, error: null } } }),
    );

    const res = await deleteServiceWeek(fakeReq, "missing-id", makeLookup("admin"));
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

    const res = await deleteServiceWeek(fakeReq, WEEK_ID, makeLookup("admin"));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });

  it("returns 409 CONFLICT with a pointer to /cancel when service_date is in the past", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        service_weeks: { select: { data: { id: WEEK_ID, service_date: PAST_DATE }, error: null } },
      }),
    );

    const res = await deleteServiceWeek(fakeReq, WEEK_ID, makeLookup("admin"));
    expect(res.status).toBe(409);

    const body = await res.json();
    expect(body.code).toBe("CONFLICT");
    expect(body.error).toContain("/api/service-weeks/:id/cancel");
  });

  it("returns 409 CONFLICT when service_date is today (today does not count as 'in the future')", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        service_weeks: { select: { data: { id: WEEK_ID, service_date: TODAY }, error: null } },
      }),
    );

    const res = await deleteServiceWeek(fakeReq, WEEK_ID, makeLookup("admin"));
    expect(res.status).toBe(409);

    const body = await res.json();
    expect(body.code).toBe("CONFLICT");
  });

  it("returns 409 CONFLICT with a pointer to /cancel when an accepted invitation exists", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        invitations: { select: { data: [{ id: "invitation-1" }], error: null } },
      }),
    );

    const res = await deleteServiceWeek(fakeReq, WEEK_ID, makeLookup("admin"));
    expect(res.status).toBe(409);

    const body = await res.json();
    expect(body.code).toBe("CONFLICT");
    expect(body.error).toContain("/api/service-weeks/:id/cancel");
  });

  it("returns 500 INTERNAL when the invitations query errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        invitations: { select: { data: null, error: { message: "connection refused" } } },
      }),
    );

    const res = await deleteServiceWeek(fakeReq, WEEK_ID, makeLookup("admin"));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });

  it("returns 200 and hard-deletes when only pending/denied/withdrawn invitations exist (BR-16 checks accepted only)", async () => {
    setUpAuth();
    let deletedFrom: string | undefined;
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient(
        {
          // The invitations query itself is pre-filtered to status=accepted in
          // the handler, so returning [] here (as the default fixture already
          // does) simulates "pending/denied/withdrawn rows exist but none are
          // accepted." This is the exact case the original plan's "zero
          // invitations exist" wording would have wrongly blocked.
          invitations: { select: { data: [], error: null } },
        },
        { onDelete: (table) => (deletedFrom = table) },
      ),
    );

    const res = await deleteServiceWeek(fakeReq, WEEK_ID, makeLookup("admin"));
    expect(res.status).toBe(200);
    expect(deletedFrom).toBe("service_weeks");

    const body = await res.json();
    expect(body.data).toEqual({ deleted: true });
  });

  it("scopes the delete to id + church_group_id (tenant isolation)", async () => {
    setUpAuth();
    const capturedEqCalls: unknown[][] = [];
    const client = makeSupabaseClient();
    const originalFrom = client.from;
    client.from = jest.fn((table: string) => {
      const result = originalFrom(table);
      if (table === "service_weeks") {
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

    const res = await deleteServiceWeek(fakeReq, WEEK_ID, makeLookup("admin"));
    expect(res.status).toBe(200);
    expect(capturedEqCalls).toEqual([
      ["id", WEEK_ID],
      ["church_group_id", CHURCH_GROUP_ID],
    ]);
  });

  it("returns 500 INTERNAL when the delete itself errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        service_weeks: { delete: { data: null, error: { message: "fk violation" } } },
      }),
    );

    const res = await deleteServiceWeek(fakeReq, WEEK_ID, makeLookup("admin"));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });
});
