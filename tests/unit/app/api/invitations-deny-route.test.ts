// Tests for POST /api/invitations/:id/deny (#42, BR-08 denial cap), plus the
// BR-08 send-guard added to createInvitation. Mock scaffolding style mirrors
// tests/unit/app/api/invitations-route.test.ts (makeReq, makeLookup,
// setUpAuth, makeChain/makeSupabaseClient, jest.mock of
// @clerk/nextjs/server + @/lib/supabase/client).

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({ getSupabaseClient: jest.fn() }));

import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { getSupabaseClient } from "@/lib/supabase/client";
import {
  createInvitation,
  denyInvitation,
  type InvitationResponse,
} from "@/app/api/invitations/handler";
import type { AuthContext, UserLookup } from "@/lib/api/auth";
import type { UserRole } from "@/types/domain";

const mockAuth = auth as unknown as jest.Mock;
const mockGetSupabaseClient = getSupabaseClient as unknown as jest.Mock;

const JWT = "supabase-jwt";
const USER_ID = "user-1";
const ADMIN_ID = "admin-1";
const CHURCH_GROUP_ID = "group-1";
const SERVICE_WEEK_ID = "22222222-2222-2222-2222-222222222222";
const TARGET_USER_ID = "11111111-1111-1111-1111-111111111111";
const INVITATION_ID = "33333333-3333-3333-3333-333333333333";

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
  // Each call to .select(...) on this table consumes the next entry (the
  // last entry is reused once the array is exhausted).
  selects?: QueryResult[];
  update?: QueryResult;
  insert?: QueryResult;
};

const pendingInvitationRow = {
  id: INVITATION_ID,
  church_group_id: CHURCH_GROUP_ID,
  service_week_id: SERVICE_WEEK_ID,
  user_id: USER_ID,
  role_note: null,
  status: "pending",
  response_token: "a".repeat(64),
  responded_at: null,
  denial_reason: null,
  denial_count: 0,
  response_deadline: "2026-07-15T00:00:00Z",
  invited_by: ADMIN_ID,
  created_at: "2026-07-12T00:00:00Z",
};

function deniedUpdateRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    ...pendingInvitationRow,
    status: "denied",
    denial_reason: null,
    denial_count: 1,
    responded_at: "2026-07-12T01:00:00Z",
    ...overrides,
  };
}

// Generic chainable mock covering:
//   .select(...).eq(...).eq(...).eq(...).maybeSingle()
//   .select(...).eq(...).eq(...).eq(...)                 (awaited directly)
//   .update(...).eq(...).eq(...).eq(...).select(...).maybeSingle()
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
  fixtures: Partial<Record<string, TableFixture>> = {},
  hooks?: {
    rpc?: jest.Mock;
    onUpdate?: (table: string, payload: unknown) => void;
  },
) {
  const selectCallIndex: Record<string, number> = {};

  return {
    from: jest.fn((table: string) => {
      const tableFixture = fixtures[table] ?? {};
      return {
        select: jest.fn(() => {
          const idx = selectCallIndex[table] ?? 0;
          selectCallIndex[table] = idx + 1;
          const selects = tableFixture.selects ?? [{ data: null, error: null }];
          const result = selects[Math.min(idx, selects.length - 1)] ?? { data: null, error: null };
          return makeChain(result);
        }),
        update: jest.fn((payload: unknown) => {
          hooks?.onUpdate?.(table, payload);
          return makeChain(tableFixture.update ?? { data: null, error: null });
        }),
        insert: jest.fn(() => makeChain(tableFixture.insert ?? { data: null, error: null })),
      };
    }),
    rpc: hooks?.rpc ?? jest.fn(() => Promise.resolve({ data: null, error: null })),
  };
}

beforeEach(() => {
  mockAuth.mockReset();
  mockGetSupabaseClient.mockReset();
});

describe("POST /api/invitations/:id/deny", () => {
  it("returns 401 UNAUTHENTICATED when getToken yields no JWT", async () => {
    setUpAuth(null);

    const res = await denyInvitation(makeReq({}), INVITATION_ID, makeLookup("member"));
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 401 UNAUTHENTICATED when Clerk userId is null (lookup never consulted)", async () => {
    mockAuth.mockResolvedValue({ userId: null, getToken: jest.fn() });
    const lookup = jest.fn();

    const res = await denyInvitation(makeReq({}), INVITATION_ID, lookup as unknown as UserLookup);
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("returns 404 NOT_FOUND when the invitation does not exist / is not owned by the caller", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        invitations: { selects: [{ data: null, error: null }] },
      }),
    );

    const res = await denyInvitation(makeReq({}), INVITATION_ID, makeLookup("member"));
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });

  it("returns 400 VALIDATION_FAILED when reason exceeds 200 chars", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        invitations: { selects: [{ data: pendingInvitationRow, error: null }] },
      }),
    );

    const res = await denyInvitation(
      makeReq({ reason: "a".repeat(201) }),
      INVITATION_ID,
      makeLookup("member"),
    );
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("returns 400 VALIDATION_FAILED when reason is not a string", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await denyInvitation(
      makeReq({ reason: 123 }),
      INVITATION_ID,
      makeLookup("member"),
    );
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("happy path: pending -> denied sets status/denial_reason/denial_count=1 and writes audit", async () => {
    setUpAuth();
    const rpc = jest.fn(() => Promise.resolve({ data: null, error: null }));
    let updatePayload: Record<string, unknown> | undefined;
    const client = makeSupabaseClient(
      {
        invitations: {
          selects: [
            { data: pendingInvitationRow, error: null }, // fetch own invitation
            { data: [], error: null }, // priorDenied count for member+week
          ],
          update: { data: deniedUpdateRow({ denial_reason: "Family conflict" }), error: null },
        },
      },
      {
        rpc,
        onUpdate: (_table, payload) => (updatePayload = payload as Record<string, unknown>),
      },
    );
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await denyInvitation(
      makeReq({ reason: "Family conflict" }),
      INVITATION_ID,
      makeLookup("member"),
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    const invitation: InvitationResponse = body.data.invitation;
    expect(invitation.status).toBe("denied");

    expect(updatePayload).toMatchObject({
      status: "denied",
      denial_reason: "Family conflict",
      denial_count: 1,
    });
    expect(updatePayload?.responded_at).toEqual(expect.any(String));

    expect(rpc).toHaveBeenCalledWith(
      "write_audit_log",
      expect.objectContaining({
        p_action: "invitation.denied",
        p_entity_id: INVITATION_ID,
        p_metadata: expect.objectContaining({
          service_week_id: SERVICE_WEEK_ID,
          denial_count: 1,
          reason_provided: true,
        }),
      }),
    );
  });

  it("empty body deny: reason is coerced to null and stored as null", async () => {
    setUpAuth();
    let updatePayload: Record<string, unknown> | undefined;
    const client = makeSupabaseClient(
      {
        invitations: {
          selects: [
            { data: pendingInvitationRow, error: null },
            { data: [], error: null },
          ],
          update: { data: deniedUpdateRow(), error: null },
        },
      },
      { onUpdate: (_table, payload) => (updatePayload = payload as Record<string, unknown>) },
    );
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await denyInvitation(makeReq(undefined), INVITATION_ID, makeLookup("member"));
    expect(res.status).toBe(200);
    expect(updatePayload?.denial_reason).toBeNull();
  });

  it("whitespace-only reason is coerced to null (not a 400)", async () => {
    setUpAuth();
    let updatePayload: Record<string, unknown> | undefined;
    const client = makeSupabaseClient(
      {
        invitations: {
          selects: [
            { data: pendingInvitationRow, error: null },
            { data: [], error: null },
          ],
          update: { data: deniedUpdateRow(), error: null },
        },
      },
      { onUpdate: (_table, payload) => (updatePayload = payload as Record<string, unknown>) },
    );
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await denyInvitation(
      makeReq({ reason: "   " }),
      INVITATION_ID,
      makeLookup("member"),
    );
    expect(res.status).toBe(200);
    expect(updatePayload?.denial_reason).toBeNull();
  });

  it("idempotent: already-denied invitation returns 200 with current status, no update/audit", async () => {
    setUpAuth();
    const rpc = jest.fn(() => Promise.resolve({ data: null, error: null }));
    const alreadyDenied = { ...pendingInvitationRow, status: "denied", denial_count: 2 };
    let updateCalled = false;
    const client = {
      from: jest.fn((table: string) => {
        expect(table).toBe("invitations");
        return {
          select: jest.fn(() => makeChain({ data: alreadyDenied, error: null })),
          update: jest.fn(() => {
            updateCalled = true;
            return makeChain({ data: null, error: null });
          }),
        };
      }),
      rpc,
    };
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await denyInvitation(makeReq({}), INVITATION_ID, makeLookup("member"));
    expect(res.status).toBe(200);

    const body = await res.json();
    const invitation: InvitationResponse = body.data.invitation;
    expect(invitation.status).toBe("denied");
    expect(updateCalled).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("denial_count becomes 2 when one prior denied row exists for member+week", async () => {
    setUpAuth();
    let updatePayload: Record<string, unknown> | undefined;
    const client = makeSupabaseClient(
      {
        invitations: {
          selects: [
            { data: pendingInvitationRow, error: null },
            { data: [{ id: "prior-denied-1" }], error: null },
          ],
          update: { data: deniedUpdateRow({ denial_count: 2 }), error: null },
        },
      },
      { onUpdate: (_table, payload) => (updatePayload = payload as Record<string, unknown>) },
    );
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await denyInvitation(makeReq({}), INVITATION_ID, makeLookup("member"));
    expect(res.status).toBe(200);
    expect(updatePayload?.denial_count).toBe(2);
  });

  it("returns 500 INTERNAL when the invitation lookup query errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        invitations: { selects: [{ data: null, error: { message: "connection refused" } }] },
      }),
    );

    const res = await denyInvitation(makeReq({}), INVITATION_ID, makeLookup("member"));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });
});

describe("POST /api/invitations — BR-08 send guard", () => {
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
    created_by: ADMIN_ID,
    created_at: "2026-07-01T00:00:00Z",
  };

  const validBody = {
    serviceWeekId: SERVICE_WEEK_ID,
    userId: TARGET_USER_ID,
  };

  it("returns 409 CONFLICT when 3 denied rows already exist for member+week", async () => {
    setUpAuth();
    const client = makeSupabaseClient({
      service_weeks: { selects: [{ data: serviceWeekRow, error: null }] },
      invitations: {
        selects: [
          {
            data: [{ id: "d1" }, { id: "d2" }, { id: "d3" }],
            error: null,
          },
        ],
      },
    });
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await createInvitation(makeReq(validBody), makeLookup("admin"));
    expect(res.status).toBe(409);

    const body = await res.json();
    expect(body.code).toBe("CONFLICT");
  });

  it("returns 201 (BR-08 guard does not block) when fewer than 3 denied rows exist for member+week", async () => {
    setUpAuth();
    const insertedInvitationRow = {
      id: "invitation-new",
      church_group_id: CHURCH_GROUP_ID,
      service_week_id: SERVICE_WEEK_ID,
      user_id: TARGET_USER_ID,
      role_note: null,
      status: "pending",
      response_token: "b".repeat(64),
      responded_at: null,
      denial_reason: null,
      denial_count: 0,
      response_deadline: "2026-07-15T00:00:00Z",
      invited_by: ADMIN_ID,
      created_at: "2026-07-12T00:00:00Z",
    };
    const client = makeSupabaseClient({
      service_weeks: { selects: [{ data: serviceWeekRow, error: null }] },
      invitations: {
        selects: [
          { data: [{ id: "d1" }, { id: "d2" }], error: null }, // deniedForWeek (BR-08): only 2
          { data: [], error: null }, // acceptedInvitations (BR-05): none, no collision
        ],
        insert: { data: insertedInvitationRow, error: null },
      },
    });
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await createInvitation(makeReq(validBody), makeLookup("admin"));
    expect(res.status).toBe(201);
  });
});
