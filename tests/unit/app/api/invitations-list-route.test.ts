// Tests for GET /api/invitations?serviceWeekId= (#48 Week View roster). Mock
// scaffolding style mirrors tests/unit/app/api/conflicts-route.test.ts
// (chainable Supabase mock via makeChain/makeSupabaseClient).

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({ getSupabaseClient: jest.fn() }));

import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { getSupabaseClient } from "@/lib/supabase/client";
import { listInvitations, type WeekInvitation } from "@/app/api/invitations/handler";
import type { AuthContext, UserLookup } from "@/lib/api/auth";
import type { UserRole } from "@/types/domain";

const mockAuth = auth as unknown as jest.Mock;
const mockGetSupabaseClient = getSupabaseClient as unknown as jest.Mock;

const JWT = "supabase-jwt";
const USER_ID = "admin-1";
const CHURCH_GROUP_ID = "group-1";
const SERVICE_WEEK_ID = "22222222-2222-4222-8222-222222222222";
const INVITATION_ID = "33333333-3333-4333-8333-333333333333";
const MEMBER_ID = "11111111-1111-4111-8111-111111111111";

function makeReq(searchParams: Record<string, string> = {}): NextRequest {
  return {
    json: jest.fn().mockResolvedValue(undefined),
    nextUrl: { searchParams: new URLSearchParams(searchParams) },
  } as unknown as NextRequest;
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

function makeChain(result: QueryResult) {
  const chain: Record<string, unknown> & PromiseLike<QueryResult> = {
    eq: jest.fn(() => chain),
    order: jest.fn(() => chain),
    select: jest.fn(() => chain),
    then: (resolve: (value: QueryResult) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  } as unknown as Record<string, unknown> & PromiseLike<QueryResult>;
  return chain;
}

function makeSupabaseClient(result: QueryResult, captureSelect?: (columns: string) => void) {
  return {
    from: jest.fn(() => ({
      select: jest.fn((columns: string) => {
        captureSelect?.(columns);
        return makeChain(result);
      }),
    })),
  };
}

const invitationRow = {
  id: INVITATION_ID,
  service_week_id: SERVICE_WEEK_ID,
  user_id: MEMBER_ID,
  role_note: "Lead vocals",
  status: "pending",
  response_deadline: "2026-07-20T00:00:00.000Z",
  created_at: "2026-07-12T00:00:00Z",
};

beforeEach(() => {
  mockAuth.mockReset();
  mockGetSupabaseClient.mockReset();
});

describe("GET /api/invitations", () => {
  it("returns 403 FORBIDDEN when caller role is member", async () => {
    setUpAuth();

    const res = await listInvitations(
      makeReq({ serviceWeekId: SERVICE_WEEK_ID }),
      makeLookup("member"),
    );
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.code).toBe("FORBIDDEN");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 400 VALIDATION_FAILED when serviceWeekId is missing", async () => {
    setUpAuth();

    const res = await listInvitations(makeReq(), makeLookup("admin"));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 400 VALIDATION_FAILED when serviceWeekId is not a uuid", async () => {
    setUpAuth();

    const res = await listInvitations(makeReq({ serviceWeekId: "not-a-uuid" }), makeLookup("admin"));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("returns 401 UNAUTHENTICATED when getToken yields no JWT", async () => {
    setUpAuth(null);

    const res = await listInvitations(
      makeReq({ serviceWeekId: SERVICE_WEEK_ID }),
      makeLookup("set_leader"),
    );
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("happy path: returns week-scoped invitations, never including responseToken", async () => {
    setUpAuth();
    let selectedColumns = "";
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({ data: [invitationRow], error: null }, (columns) => {
        selectedColumns = columns;
      }),
    );

    const res = await listInvitations(
      makeReq({ serviceWeekId: SERVICE_WEEK_ID }),
      makeLookup("set_leader"),
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    const invitations: WeekInvitation[] = body.data.invitations;
    expect(invitations).toHaveLength(1);
    expect(invitations[0]).toEqual({
      id: INVITATION_ID,
      serviceWeekId: SERVICE_WEEK_ID,
      userId: MEMBER_ID,
      roleNote: "Lead vocals",
      status: "pending",
      responseDeadline: "2026-07-20T00:00:00.000Z",
      createdAt: "2026-07-12T00:00:00Z",
    });
    expect(invitations[0]).not.toHaveProperty("responseToken");
    expect(JSON.stringify(invitations[0])).not.toMatch(/responseToken|response_token/);

    // Never select("*") — explicit columns only, and no response_token.
    expect(selectedColumns).not.toBe("*");
    expect(selectedColumns).not.toMatch(/response_token/);
  });

  it("returns { invitations: [] } when there are none for the week", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient({ data: [], error: null }));

    const res = await listInvitations(
      makeReq({ serviceWeekId: SERVICE_WEEK_ID }),
      makeLookup("admin"),
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data.invitations).toEqual([]);
  });

  it("returns 500 INTERNAL when the query errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({ data: null, error: { message: "connection refused" } }),
    );

    const res = await listInvitations(
      makeReq({ serviceWeekId: SERVICE_WEEK_ID }),
      makeLookup("admin"),
    );
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });
});
