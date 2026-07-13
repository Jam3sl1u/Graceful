// Tests for DELETE /api/invitations/:id (#43, withdraw invitation). Mock
// scaffolding style mirrors tests/unit/app/api/invitations-deny-route.test.ts
// (makeReq, makeLookup, setUpAuth, makeChain/makeSupabaseClient,
// pendingInvitationRow, jest.mock of @clerk/nextjs/server +
// @/lib/supabase/client).

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({ getSupabaseClient: jest.fn() }));

import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { getSupabaseClient } from "@/lib/supabase/client";
import { withdrawInvitation, type InvitationResponse } from "@/app/api/invitations/handler";
import type { AuthContext, UserLookup } from "@/lib/api/auth";
import type { UserRole } from "@/types/domain";

const mockAuth = auth as unknown as jest.Mock;
const mockGetSupabaseClient = getSupabaseClient as unknown as jest.Mock;

const JWT = "supabase-jwt";
const USER_ID = "admin-1";
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

function withdrawnUpdateRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    ...pendingInvitationRow,
    status: "withdrawn",
    ...overrides,
  };
}

// Generic chainable mock covering:
//   .select(...).eq(...).eq(...).maybeSingle()
//   .update(...).eq(...).eq(...).select(...).maybeSingle()
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
    onInsert?: (table: string, payload: unknown) => void;
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
        insert: jest.fn((payload: unknown) => {
          hooks?.onInsert?.(table, payload);
          return makeChain(tableFixture.insert ?? { data: null, error: null });
        }),
      };
    }),
    rpc: hooks?.rpc ?? jest.fn(() => Promise.resolve({ data: null, error: null })),
  };
}

beforeEach(() => {
  mockAuth.mockReset();
  mockGetSupabaseClient.mockReset();
});

describe("DELETE /api/invitations/:id (withdraw)", () => {
  it("returns 403 FORBIDDEN when caller role is member", async () => {
    setUpAuth();

    const res = await withdrawInvitation(makeReq(), INVITATION_ID, makeLookup("member"));
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.code).toBe("FORBIDDEN");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 401 UNAUTHENTICATED when getToken yields no JWT", async () => {
    setUpAuth(null);

    const res = await withdrawInvitation(makeReq(), INVITATION_ID, makeLookup("admin"));
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 404 NOT_FOUND when the invitation does not exist / is not in the caller's group", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        invitations: { selects: [{ data: null, error: null }] },
      }),
    );

    const res = await withdrawInvitation(makeReq(), INVITATION_ID, makeLookup("set_leader"));
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });

  it("returns 409 CONFLICT when status is accepted", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        invitations: {
          selects: [{ data: { ...pendingInvitationRow, status: "accepted" }, error: null }],
        },
      }),
    );

    const res = await withdrawInvitation(makeReq(), INVITATION_ID, makeLookup("admin"));
    expect(res.status).toBe(409);

    const body = await res.json();
    expect(body.code).toBe("CONFLICT");
  });

  it("returns 409 CONFLICT when status is denied", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        invitations: {
          selects: [{ data: { ...pendingInvitationRow, status: "denied" }, error: null }],
        },
      }),
    );

    const res = await withdrawInvitation(makeReq(), INVITATION_ID, makeLookup("set_leader"));
    expect(res.status).toBe(409);

    const body = await res.json();
    expect(body.code).toBe("CONFLICT");
  });

  it("returns 500 INTERNAL when the invitation lookup query errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        invitations: { selects: [{ data: null, error: { message: "connection refused" } }] },
      }),
    );

    const res = await withdrawInvitation(makeReq(), INVITATION_ID, makeLookup("admin"));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });

  it("happy path: pending -> withdrawn, notifies the member, and writes audit", async () => {
    setUpAuth();
    const rpc = jest.fn(() => Promise.resolve({ data: null, error: null }));
    let updatePayload: Record<string, unknown> | undefined;
    let insertPayload: Record<string, unknown> | undefined;
    const client = makeSupabaseClient(
      {
        invitations: {
          selects: [{ data: pendingInvitationRow, error: null }],
          update: { data: withdrawnUpdateRow(), error: null },
        },
        notifications: {
          insert: { data: null, error: null },
        },
      },
      {
        rpc,
        onUpdate: (_table, payload) => (updatePayload = payload as Record<string, unknown>),
        onInsert: (table, payload) => {
          if (table === "notifications") insertPayload = payload as Record<string, unknown>;
        },
      },
    );
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await withdrawInvitation(makeReq(), INVITATION_ID, makeLookup("admin"));
    expect(res.status).toBe(200);

    const body = await res.json();
    const invitation: InvitationResponse = body.data.invitation;
    expect(invitation.status).toBe("withdrawn");

    expect(updatePayload).toEqual({ status: "withdrawn" });
    expect(updatePayload?.responded_at).toBeUndefined();

    expect(insertPayload).toMatchObject({
      user_id: TARGET_USER_ID,
      type: "invitation_withdrawn",
      church_group_id: CHURCH_GROUP_ID,
      link_entity_type: "invitation",
      link_entity_id: INVITATION_ID,
    });

    expect(rpc).toHaveBeenCalledWith(
      "write_audit_log",
      expect.objectContaining({
        p_action: "invitation.withdrawn",
        p_entity_id: INVITATION_ID,
        p_metadata: expect.objectContaining({
          service_week_id: SERVICE_WEEK_ID,
          user_id: TARGET_USER_ID,
        }),
      }),
    );
  });

  it("returns 500 INTERNAL when the notification insert errors", async () => {
    setUpAuth();
    const client = makeSupabaseClient({
      invitations: {
        selects: [{ data: pendingInvitationRow, error: null }],
        update: { data: withdrawnUpdateRow(), error: null },
      },
      notifications: {
        insert: { data: null, error: { message: "insert failed" } },
      },
    });
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await withdrawInvitation(makeReq(), INVITATION_ID, makeLookup("admin"));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });
});
