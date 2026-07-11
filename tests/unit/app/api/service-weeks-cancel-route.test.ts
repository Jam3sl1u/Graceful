jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({ getSupabaseClient: jest.fn() }));

import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { getSupabaseClient } from "@/lib/supabase/client";
import { cancelServiceWeek } from "@/app/api/service-weeks/[id]/handler";
import type { AuthContext, UserLookup } from "@/lib/api/auth";
import type { UserRole } from "@/types/domain";

const mockAuth = auth as unknown as jest.Mock;
const mockGetSupabaseClient = getSupabaseClient as unknown as jest.Mock;

const JWT = "supabase-jwt";
const USER_ID = "user-1";
const CHURCH_GROUP_ID = "group-1";
const WEEK_ID = "week-1";

const fakeReq = {} as NextRequest;

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
  insert?: QueryResult;
};

// Generic chainable mock covering:
//   .update(...).eq(...).eq(...).select(...).maybeSingle()   (service_weeks update)
//   .select(...).eq(...).in(...)                             (invitations recipients, resolves via `then`)
//   .insert(...)                                              (notifications, resolves via `then`)
function makeChain(result: QueryResult) {
  const chain: Record<string, unknown> & PromiseLike<QueryResult> = {
    eq: jest.fn(() => chain),
    in: jest.fn(() => chain),
    select: jest.fn(() => chain),
    maybeSingle: jest.fn(() => Promise.resolve(result)),
    then: (resolve: (value: QueryResult) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  } as unknown as Record<string, unknown> & PromiseLike<QueryResult>;
  return chain;
}

const DEFAULT_FIXTURES: Record<string, TableFixture> = {
  service_weeks: {
    update: {
      data: { id: WEEK_ID, church_group_id: CHURCH_GROUP_ID, is_cancelled: true },
      error: null,
    },
  },
  invitations: {
    select: { data: [], error: null },
  },
  notifications: {
    insert: { data: null, error: null },
  },
};

function makeSupabaseClient(
  overrides: Partial<Record<string, TableFixture>> = {},
  hooks?: { onInsert?: (table: string, payload: unknown) => void },
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
        update: jest.fn((_patch: unknown) =>
          makeChain(tableFixture.update ?? { data: null, error: null }),
        ),
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

describe("POST /api/service-weeks/[id]/cancel", () => {
  it("returns 401 UNAUTHENTICATED when Clerk userId is null (lookup never consulted)", async () => {
    mockAuth.mockResolvedValue({ userId: null, getToken: jest.fn() });
    const lookup = jest.fn();

    const res = await cancelServiceWeek(fakeReq, WEEK_ID, lookup as unknown as UserLookup);
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("returns 401 UNAUTHENTICATED when getToken yields no JWT", async () => {
    setUpAuth(null);

    const res = await cancelServiceWeek(fakeReq, WEEK_ID, makeLookup("admin"));
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it.each<UserRole>(["member", "set_leader", "guest"])(
    "returns 403 FORBIDDEN for a '%s' (admin only)",
    async (role) => {
      setUpAuth();
      mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

      const res = await cancelServiceWeek(fakeReq, WEEK_ID, makeLookup(role));
      expect(res.status).toBe(403);

      const body = await res.json();
      expect(body.code).toBe("FORBIDDEN");
      expect(mockGetSupabaseClient).not.toHaveBeenCalled();
    },
  );

  it("returns 404 NOT_FOUND when the update matches no row (or belongs to another tenant)", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({ service_weeks: { update: { data: null, error: null } } }),
    );

    const res = await cancelServiceWeek(fakeReq, "missing-id", makeLookup("admin"));
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });

  it("returns 500 INTERNAL when the update errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        service_weeks: { update: { data: null, error: { message: "connection refused" } } },
      }),
    );

    const res = await cancelServiceWeek(fakeReq, WEEK_ID, makeLookup("admin"));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });

  it("returns 500 INTERNAL when the invitations recipient query errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        invitations: { select: { data: null, error: { message: "connection refused" } } },
      }),
    );

    const res = await cancelServiceWeek(fakeReq, WEEK_ID, makeLookup("admin"));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });

  it("returns 500 INTERNAL when the notifications insert errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        invitations: { select: { data: [{ user_id: "user-2" }], error: null } },
        notifications: { insert: { data: null, error: { message: "insert failed" } } },
      }),
    );

    const res = await cancelServiceWeek(fakeReq, WEEK_ID, makeLookup("admin"));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });

  it("returns 200, sets is_cancelled true, and notifies each unique pending/accepted invitee", async () => {
    setUpAuth();
    let insertedInto: string | undefined;
    let insertedPayload: unknown;
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient(
        {
          invitations: {
            select: {
              data: [{ user_id: "user-2" }, { user_id: "user-3" }],
              error: null,
            },
          },
        },
        {
          onInsert: (table, payload) => {
            insertedInto = table;
            insertedPayload = payload;
          },
        },
      ),
    );

    const res = await cancelServiceWeek(fakeReq, WEEK_ID, makeLookup("admin"));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data.serviceWeek.isCancelled).toBe(true);

    expect(insertedInto).toBe("notifications");
    expect(insertedPayload).toEqual([
      {
        church_group_id: CHURCH_GROUP_ID,
        user_id: "user-2",
        type: "service_week_cancelled",
        title: "Service week cancelled",
        body: null,
        link_entity_type: "service_week",
        link_entity_id: WEEK_ID,
      },
      {
        church_group_id: CHURCH_GROUP_ID,
        user_id: "user-3",
        type: "service_week_cancelled",
        title: "Service week cancelled",
        body: null,
        link_entity_type: "service_week",
        link_entity_id: WEEK_ID,
      },
    ]);
  });

  it("returns 200 with zero pending/accepted invitations and does not attempt a notifications insert", async () => {
    setUpAuth();
    let insertCalled = false;
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient(
        { invitations: { select: { data: [], error: null } } },
        { onInsert: () => (insertCalled = true) },
      ),
    );

    const res = await cancelServiceWeek(fakeReq, WEEK_ID, makeLookup("admin"));
    expect(res.status).toBe(200);
    expect(insertCalled).toBe(false);
  });

  it("de-dupes multiple invitations for the same user_id into a single notification row", async () => {
    setUpAuth();
    let insertedPayload: unknown;
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient(
        {
          invitations: {
            select: {
              data: [{ user_id: "user-2" }, { user_id: "user-2" }],
              error: null,
            },
          },
        },
        { onInsert: (_table, payload) => (insertedPayload = payload) },
      ),
    );

    const res = await cancelServiceWeek(fakeReq, WEEK_ID, makeLookup("admin"));
    expect(res.status).toBe(200);
    expect(Array.isArray(insertedPayload) && insertedPayload.length).toBe(1);
  });

  it("scopes the update to id + church_group_id (tenant isolation)", async () => {
    setUpAuth();
    const capturedEqCalls: unknown[][] = [];
    const client = makeSupabaseClient();
    const originalFrom = client.from;
    client.from = jest.fn((table: string) => {
      const result = originalFrom(table);
      if (table === "service_weeks") {
        const originalUpdate = result.update;
        result.update = jest.fn((patch: unknown) => {
          const chain = originalUpdate(patch);
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

    const res = await cancelServiceWeek(fakeReq, WEEK_ID, makeLookup("admin"));
    expect(res.status).toBe(200);
    expect(capturedEqCalls).toEqual([
      ["id", WEEK_ID],
      ["church_group_id", CHURCH_GROUP_ID],
    ]);
  });
});
