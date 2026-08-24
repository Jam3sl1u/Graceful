// Tests for GET /api/conflicts (#47). Mock scaffolding style mirrors
// tests/unit/app/api/invitations-withdraw-route.test.ts (makeReq, makeLookup,
// setUpAuth, chainable Supabase mock), extended with `.is(...)` support for
// the `resolved_at IS NULL` filter used here.

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({ getSupabaseClient: jest.fn() }));

import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { getSupabaseClient } from "@/lib/supabase/client";
import { getOpenConflicts, type OpenConflict } from "@/app/api/conflicts/handler";
import type { AuthContext, UserLookup } from "@/lib/api/auth";
import type { UserRole } from "@/types/domain";

const mockAuth = auth as unknown as jest.Mock;
const mockGetSupabaseClient = getSupabaseClient as unknown as jest.Mock;

const JWT = "supabase-jwt";
const USER_ID = "admin-1";
const CHURCH_GROUP_ID = "group-1";
const CONFLICT_ID = "44444444-4444-4444-8444-444444444444";
const INVITATION_ID = "33333333-3333-4333-8333-333333333333";
const SERVICE_WEEK_ID = "22222222-2222-4222-8222-222222222222";
const MEMBER_ID = "11111111-1111-4111-8111-111111111111";

function makeReq(): NextRequest {
  return { json: jest.fn().mockResolvedValue(undefined) } as unknown as NextRequest;
}

function makeLookup(role: UserRole): UserLookup {
  const ctx: AuthContext = { userId: USER_ID, churchGroupId: CHURCH_GROUP_ID, role };
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
  selects?: QueryResult[];
};

// Chainable mock covering .select(...).eq(...).is(...).order(...) as well as
// .select(...).in(...), resolved either by awaiting the chain directly
// (via `then`) or via `.maybeSingle()`.
function makeChain(result: QueryResult) {
  const chain: Record<string, unknown> & PromiseLike<QueryResult> = {
    eq: jest.fn(() => chain),
    in: jest.fn(() => chain),
    is: jest.fn(() => chain),
    order: jest.fn(() => chain),
    select: jest.fn(() => chain),
    maybeSingle: jest.fn(() => Promise.resolve(result)),
    then: (resolve: (value: QueryResult) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  } as unknown as Record<string, unknown> & PromiseLike<QueryResult>;
  return chain;
}

function makeSupabaseClient(fixtures: Partial<Record<string, TableFixture>> = {}) {
  const selectCallIndex: Record<string, number> = {};
  return {
    from: jest.fn((table: string) => {
      const tableFixture = fixtures[table] ?? {};
      return {
        select: jest.fn(() => {
          const idx = selectCallIndex[table] ?? 0;
          selectCallIndex[table] = idx + 1;
          const selects = tableFixture.selects ?? [{ data: [], error: null }];
          const result = selects[Math.min(idx, selects.length - 1)] ?? { data: [], error: null };
          return makeChain(result);
        }),
      };
    }),
  };
}

const conflictRow = {
  id: CONFLICT_ID,
  church_group_id: CHURCH_GROUP_ID,
  invitation_id: INVITATION_ID,
  triggered_by: null,
  trigger_reason: "double-booked",
  replacement_suggestion_user_id: null,
  resolved_at: null,
  resolution_type: null,
  created_at: "2026-07-12T00:00:00Z",
};

const invitationRow = {
  id: INVITATION_ID,
  user_id: MEMBER_ID,
  service_week_id: SERVICE_WEEK_ID,
  status: "accepted",
  role_note: "Lead vocals",
};

const userRow = { id: MEMBER_ID, name: "Jane Doe" };
const weekRow = { id: SERVICE_WEEK_ID, service_date: "2026-07-19", title: "Sunday Service" };

beforeEach(() => {
  mockAuth.mockReset();
  mockGetSupabaseClient.mockReset();
});

describe("GET /api/conflicts", () => {
  it("returns 403 FORBIDDEN when caller role is member", async () => {
    setUpAuth();

    const res = await getOpenConflicts(makeReq(), makeLookup("member"));
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.code).toBe("FORBIDDEN");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 401 UNAUTHENTICATED when getToken yields no JWT", async () => {
    setUpAuth(null);

    const res = await getOpenConflicts(makeReq(), makeLookup("admin"));
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("happy path: returns open conflicts joined with member/week data", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        conflicts: { selects: [{ data: [conflictRow], error: null }] },
        invitations: { selects: [{ data: [invitationRow], error: null }] },
        users: { selects: [{ data: [userRow], error: null }] },
        service_weeks: { selects: [{ data: [weekRow], error: null }] },
      }),
    );

    const res = await getOpenConflicts(makeReq(), makeLookup("set_leader"));
    expect(res.status).toBe(200);

    const body = await res.json();
    const conflicts: OpenConflict[] = body.data.conflicts;
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toEqual({
      id: CONFLICT_ID,
      invitationId: INVITATION_ID,
      memberId: MEMBER_ID,
      memberName: "Jane Doe",
      serviceWeekId: SERVICE_WEEK_ID,
      serviceDate: "2026-07-19",
      serviceWeekTitle: "Sunday Service",
      roleNote: "Lead vocals",
      invitationStatus: "accepted",
      triggerReason: "double-booked",
      createdAt: "2026-07-12T00:00:00Z",
    });
  });

  it("returns { conflicts: [] } when there are no open conflicts", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        conflicts: { selects: [{ data: [], error: null }] },
      }),
    );

    const res = await getOpenConflicts(makeReq(), makeLookup("admin"));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data.conflicts).toEqual([]);
  });

  it("does not drop a conflict when its joined invitation row is missing, using safe fallbacks", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        conflicts: { selects: [{ data: [conflictRow], error: null }] },
        invitations: { selects: [{ data: [], error: null }] },
        users: { selects: [{ data: [], error: null }] },
        service_weeks: { selects: [{ data: [], error: null }] },
      }),
    );

    const res = await getOpenConflicts(makeReq(), makeLookup("admin"));
    expect(res.status).toBe(200);

    const body = await res.json();
    const conflicts: OpenConflict[] = body.data.conflicts;
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      id: CONFLICT_ID,
      memberId: "",
      memberName: "",
      serviceWeekId: "",
      serviceDate: "",
      roleNote: null,
      invitationStatus: "withdrawn",
    });
  });

  it("returns 500 INTERNAL when the conflicts query errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        conflicts: { selects: [{ data: null, error: { message: "connection refused" } }] },
      }),
    );

    const res = await getOpenConflicts(makeReq(), makeLookup("admin"));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });

  it("returns 500 INTERNAL when a joined query (invitations) errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        conflicts: { selects: [{ data: [conflictRow], error: null }] },
        invitations: { selects: [{ data: null, error: { message: "boom" } }] },
      }),
    );

    const res = await getOpenConflicts(makeReq(), makeLookup("admin"));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });
});
