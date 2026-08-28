jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({ getSupabaseClient: jest.fn() }));

import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { getSupabaseClient } from "@/lib/supabase/client";
import { createInvitation, type InvitationResponse } from "@/app/api/invitations/handler";
import type { AuthContext, UserLookup } from "@/lib/api/auth";
import type { UserRole } from "@/types/domain";

const mockAuth = auth as unknown as jest.Mock;
const mockGetSupabaseClient = getSupabaseClient as unknown as jest.Mock;

const JWT = "supabase-jwt";
const USER_ID = "user-1";
const CHURCH_GROUP_ID = "group-1";
const TARGET_USER_ID = "11111111-1111-4111-8111-111111111111";
const SERVICE_WEEK_ID = "22222222-2222-4222-8222-222222222222";

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
  // service_weeks is queried twice: first the maybeSingle() week lookup,
  // then (only when there are accepted invitations for the target user) the
  // BR-05 collision check. selectSecond lets tests target the second query
  // independently of the first.
  selectSecond?: QueryResult;
};

const serviceWeekRow = {
  id: SERVICE_WEEK_ID,
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

const invitationRow = {
  id: "invitation-1",
  church_group_id: CHURCH_GROUP_ID,
  service_week_id: SERVICE_WEEK_ID,
  user_id: TARGET_USER_ID,
  role_note: null,
  status: "pending",
  response_token: "a".repeat(64),
  responded_at: null,
  denial_reason: null,
  denial_count: 0,
  response_deadline: "2026-07-15T00:00:00Z",
  invited_by: USER_ID,
  created_at: "2026-07-12T00:00:00Z",
};

const invitationResponse: InvitationResponse = {
  id: "invitation-1",
  serviceWeekId: SERVICE_WEEK_ID,
  userId: TARGET_USER_ID,
  roleNote: null,
  status: "pending",
  responseToken: "a".repeat(64),
  responseDeadline: "2026-07-15T00:00:00Z",
  invitedBy: USER_ID,
  createdAt: "2026-07-12T00:00:00Z",
};

// Default fixtures: service week found in the caller's group, no accepted
// invitations for the target user (so no double-booking), invitation insert
// succeeds.
const DEFAULT_FIXTURES: Record<string, TableFixture> = {
  service_weeks: {
    select: { data: serviceWeekRow, error: null },
  },
  invitations: {
    select: { data: [], error: null },
    insert: { data: invitationRow, error: null },
  },
};

// Generic chainable mock covering:
//   .select(...).eq(...).eq(...).maybeSingle()
//   .select(...).eq(...).eq(...).eq(...)                 (awaited directly)
//   .select(...).in(...).eq(...).neq(...)                 (awaited directly)
//   .insert(...).select(...).maybeSingle()
function makeChain(result: QueryResult) {
  const chain: Record<string, unknown> & PromiseLike<QueryResult> = {
    eq: jest.fn(() => chain),
    neq: jest.fn(() => chain),
    in: jest.fn(() => chain),
    order: jest.fn(() => chain),
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

  const selectCallCounts: Record<string, number> = {};

  return {
    from: jest.fn((table: string) => {
      const tableFixture = fixtures[table] ?? {};
      return {
        select: jest.fn(() => {
          selectCallCounts[table] = (selectCallCounts[table] ?? 0) + 1;
          const useSecond = table === "service_weeks" && selectCallCounts[table] === 2;
          const result = useSecond
            ? (tableFixture.selectSecond ?? { data: [], error: null })
            : (tableFixture.select ?? { data: null, error: null });
          return makeChain(result);
        }),
        insert: jest.fn((payload: unknown) => {
          hooks?.onInsert?.(table, payload);
          return makeChain(tableFixture.insert ?? { data: null, error: null });
        }),
      };
    }),
    rpc: jest.fn(() => Promise.resolve({ data: null, error: null })),
  };
}

beforeEach(() => {
  mockAuth.mockReset();
  mockGetSupabaseClient.mockReset();
});

describe("POST /api/invitations", () => {
  const validBody = {
    serviceWeekId: SERVICE_WEEK_ID,
    userId: TARGET_USER_ID,
  };

  it("returns 401 UNAUTHENTICATED when Clerk userId is null (lookup never consulted)", async () => {
    mockAuth.mockResolvedValue({ userId: null, getToken: jest.fn() });
    const lookup = jest.fn();

    const res = await createInvitation(makeReq(validBody), lookup as unknown as UserLookup);
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("returns 401 UNAUTHENTICATED when getToken yields no JWT", async () => {
    setUpAuth(null);

    const res = await createInvitation(makeReq(validBody), makeLookup("set_leader"));
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 403 FORBIDDEN for a member", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await createInvitation(makeReq(validBody), makeLookup("member"));
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.code).toBe("FORBIDDEN");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 403 FORBIDDEN for a guest", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await createInvitation(makeReq(validBody), makeLookup("guest"));
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.code).toBe("FORBIDDEN");
  });

  it("returns 400 VALIDATION_FAILED for a malformed/non-JSON body", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await createInvitation(makeReq(null), makeLookup("admin"));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("returns 400 VALIDATION_FAILED when serviceWeekId is missing", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const bodyWithoutField = { ...validBody } as Record<string, unknown>;
    delete bodyWithoutField.serviceWeekId;

    const res = await createInvitation(makeReq(bodyWithoutField), makeLookup("admin"));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("returns 400 VALIDATION_FAILED when userId is missing", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const bodyWithoutField = { ...validBody } as Record<string, unknown>;
    delete bodyWithoutField.userId;

    const res = await createInvitation(makeReq(bodyWithoutField), makeLookup("admin"));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("returns 400 VALIDATION_FAILED for a non-uuid userId", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await createInvitation(
      makeReq({ ...validBody, userId: "not-a-uuid" }),
      makeLookup("admin"),
    );
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("returns 400 VALIDATION_FAILED when roleNote is too long", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await createInvitation(
      makeReq({ ...validBody, roleNote: "a".repeat(501) }),
      makeLookup("admin"),
    );
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("returns 404 NOT_FOUND when the service week is not found", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        service_weeks: { select: { data: null, error: null } },
      }),
    );

    const res = await createInvitation(makeReq(validBody), makeLookup("admin"));
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });

  it("returns 201 happy path with no double-booking", async () => {
    setUpAuth();
    const capturedInserts: Record<string, unknown> = {};
    const rpc = jest.fn(() => Promise.resolve({ data: null, error: null }));
    const client = makeSupabaseClient(
      {},
      { onInsert: (table, payload) => (capturedInserts[table] = payload) },
    );
    client.rpc = rpc;
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await createInvitation(makeReq(validBody), makeLookup("admin"));
    expect(res.status).toBe(201);

    const body = await res.json();
    const invitation: InvitationResponse = body.data.invitation;
    expect(invitation).toEqual(invitationResponse);

    const insertPayload = capturedInserts.invitations as Record<string, unknown>;
    expect(insertPayload).not.toHaveProperty("status");
    expect(insertPayload.invited_by).toBe(USER_ID);
    expect(insertPayload.response_token).toMatch(/^[0-9a-f]{64}$/);

    const deadline = new Date(insertPayload.response_deadline as string).getTime();
    const expected = Date.now() + 72 * 60 * 60 * 1000;
    expect(Math.abs(deadline - expected)).toBeLessThan(60_000);

    expect(rpc).toHaveBeenCalledWith(
      "write_audit_log",
      expect.objectContaining({ p_action: "invitation.sent" }),
    );
  });

  it("returns 409 CONFLICT when a double-booking exists and acknowledgeConflict is absent", async () => {
    setUpAuth();
    let invitationsInsertCalled = false;
    const client = makeSupabaseClient(
      {
        invitations: {
          select: { data: [{ service_week_id: "other-week" }], error: null },
        },
        service_weeks: {
          select: { data: serviceWeekRow, error: null },
          // BR-05 collision check: another accepted week on the same date.
          selectSecond: { data: [{ id: "other-week" }], error: null },
        },
      },
      {
        onInsert: (table) =>
          (invitationsInsertCalled = invitationsInsertCalled || table === "invitations"),
      },
    );
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await createInvitation(makeReq(validBody), makeLookup("admin"));
    expect(res.status).toBe(409);

    const body = await res.json();
    expect(body.code).toBe("CONFLICT");
    expect(invitationsInsertCalled).toBe(false);
  });

  it("returns 201 when the same double-booking exists but acknowledgeConflict is true", async () => {
    setUpAuth();
    let invitationsInsertCalled = false;
    const client = makeSupabaseClient(
      {
        invitations: {
          select: { data: [{ service_week_id: "other-week" }], error: null },
          insert: { data: invitationRow, error: null },
        },
        service_weeks: {
          select: { data: serviceWeekRow, error: null },
          selectSecond: { data: [{ id: "other-week" }], error: null },
        },
      },
      {
        onInsert: (table) =>
          (invitationsInsertCalled = invitationsInsertCalled || table === "invitations"),
      },
    );
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await createInvitation(
      makeReq({ ...validBody, acknowledgeConflict: true }),
      makeLookup("admin"),
    );
    expect(res.status).toBe(201);
    expect(invitationsInsertCalled).toBe(true);
  });

  it("returns 500 INTERNAL when the invitation insert errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        invitations: {
          select: { data: [], error: null },
          insert: { data: null, error: { message: "constraint violation" } },
        },
      }),
    );

    const res = await createInvitation(makeReq(validBody), makeLookup("admin"));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });
});
