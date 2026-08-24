// Tests for POST /api/invitations/guest (#72). Mock scaffolding style
// mirrors tests/unit/app/api/invitations-route.test.ts (makeReq, makeLookup,
// setUpAuth, chainable per-table fixtures) with an ordered `selects` array
// per table (mirrors tests/unit/app/api/invitations-withdraw-route.test.ts)
// since several tables are queried more than once in a single call.

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({ getSupabaseClient: jest.fn() }));

import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { getSupabaseClient } from "@/lib/supabase/client";
import { createGuestInvitation, type GuestInvitationResponse } from "@/app/api/invitations/handler";
import type { AuthContext, UserLookup } from "@/lib/api/auth";
import type { UserRole } from "@/types/domain";

const mockAuth = auth as unknown as jest.Mock;
const mockGetSupabaseClient = getSupabaseClient as unknown as jest.Mock;

const JWT = "supabase-jwt";
const USER_ID = "admin-1";
const CHURCH_GROUP_ID = "group-1";
const SERVICE_WEEK_ID = "22222222-2222-4222-8222-222222222222";
const EXISTING_USER_ID = "11111111-1111-4111-8111-111111111111";
const NEW_GUEST_USER_ID = "33333333-3333-4333-8333-333333333333";

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
  insert?: QueryResult;
  delete?: QueryResult;
};

const serviceWeekRow = {
  id: SERVICE_WEEK_ID,
  church_group_id: CHURCH_GROUP_ID,
  service_date: "2026-07-12",
  title: "Sunday Service",
  is_cancelled: false,
};

function invitationRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "invitation-1",
    church_group_id: CHURCH_GROUP_ID,
    service_week_id: SERVICE_WEEK_ID,
    user_id: EXISTING_USER_ID,
    role_note: null,
    status: "pending",
    response_token: "a".repeat(64),
    responded_at: null,
    denial_reason: null,
    denial_count: 0,
    response_deadline: "2026-07-15T00:00:00Z",
    invited_by: USER_ID,
    created_at: "2026-07-12T00:00:00Z",
    ...overrides,
  };
}

// Default fixtures: service week found; email belongs to an existing user in
// the group; no prior denials, no accepted conflicts; invitation insert
// succeeds against the existing user.
const DEFAULT_FIXTURES: Record<string, TableFixture> = {
  service_weeks: {
    selects: [{ data: serviceWeekRow, error: null }],
  },
  users: {
    selects: [{ data: [{ id: EXISTING_USER_ID }], error: null }],
  },
  invitations: {
    selects: [
      { data: [], error: null }, // BR-08 denied check
      { data: [], error: null }, // BR-05 accepted check
    ],
    insert: { data: invitationRow(), error: null },
  },
};

function makeChain(result: QueryResult) {
  const chain: Record<string, unknown> & PromiseLike<QueryResult> = {
    eq: jest.fn(() => chain),
    neq: jest.fn(() => chain),
    ilike: jest.fn(() => chain),
    in: jest.fn(() => chain),
    is: jest.fn(() => chain),
    limit: jest.fn(() => chain),
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
    rpc?: jest.Mock;
    onInsert?: (table: string, payload: unknown) => void;
    onDelete?: (table: string, id: string) => void;
  },
) {
  const fixtures: Record<string, TableFixture> = {};
  for (const table of Object.keys(DEFAULT_FIXTURES)) {
    fixtures[table] = { ...DEFAULT_FIXTURES[table], ...overrides[table] };
  }
  for (const table of Object.keys(overrides)) {
    if (!(table in fixtures)) fixtures[table] = overrides[table]!;
  }

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
        insert: jest.fn((payload: unknown) => {
          hooks?.onInsert?.(table, payload);
          return makeChain(tableFixture.insert ?? { data: null, error: null });
        }),
        delete: jest.fn(() => {
          const chain: Record<string, unknown> & PromiseLike<QueryResult> = {
            eq: jest.fn((_col: string, id: string) => {
              hooks?.onDelete?.(table, id);
              return Promise.resolve(tableFixture.delete ?? { data: null, error: null });
            }),
          } as unknown as Record<string, unknown> & PromiseLike<QueryResult>;
          return chain;
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

describe("POST /api/invitations/guest", () => {
  const validBody = {
    serviceWeekId: SERVICE_WEEK_ID,
    email: "Guest@Example.com",
  };

  it("returns 401 UNAUTHENTICATED when Clerk userId is null (lookup never consulted)", async () => {
    mockAuth.mockResolvedValue({ userId: null, getToken: jest.fn() });
    const lookup = jest.fn();

    const res = await createGuestInvitation(makeReq(validBody), lookup as unknown as UserLookup);
    expect(res.status).toBe(401);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("returns 403 FORBIDDEN for a member", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await createGuestInvitation(makeReq(validBody), makeLookup("member"));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("FORBIDDEN");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 400 VALIDATION_FAILED for a malformed email", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await createGuestInvitation(
      makeReq({ ...validBody, email: "not-an-email" }),
      makeLookup("admin"),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("returns 404 NOT_FOUND when the service week is not found", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({ service_weeks: { selects: [{ data: null, error: null }] } }),
    );

    const res = await createGuestInvitation(makeReq(validBody), makeLookup("admin"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });

  it("existing-user happy path: isNewUser false, accountSetupUrl null, provision_guest_user never called, role untouched", async () => {
    setUpAuth();
    const rpc = jest.fn(() => Promise.resolve({ data: null, error: null }));
    const capturedInserts: Record<string, unknown> = {};
    const client = makeSupabaseClient(
      {},
      { rpc, onInsert: (table, payload) => (capturedInserts[table] = payload) },
    );
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await createGuestInvitation(makeReq(validBody), makeLookup("admin"));
    expect(res.status).toBe(201);

    const body = await res.json();
    const data: GuestInvitationResponse = body.data;
    expect(data.isNewUser).toBe(false);
    expect(data.accountSetupUrl).toBeNull();
    expect(data.guestUserId).toBe(EXISTING_USER_ID);
    expect(data.invitation.userId).toBe(EXISTING_USER_ID);
    expect(data.inviteUrl).toContain(`/invite/${invitationRow().response_token}`);

    expect(rpc).not.toHaveBeenCalledWith(
      "provision_guest_user",
      expect.anything(),
    );

    const insertPayload = capturedInserts.invitations as Record<string, unknown>;
    expect(insertPayload.user_id).toBe(EXISTING_USER_ID);
  });

  it("existing-user lookup is case-insensitive: a mixed-case stored email still matches a lowercased request email", async () => {
    setUpAuth();
    const rpc = jest.fn(() => Promise.resolve({ data: null, error: null }));
    // Stored row's email has an uppercase char, as it would if it was never
    // normalized on write (join_church_group inserts Clerk's address
    // verbatim) — the request body's email is already lowercased by
    // createGuestInvitationSchema before it reaches the handler.
    const client = makeSupabaseClient(
      { users: { selects: [{ data: [{ id: EXISTING_USER_ID }], error: null }] } },
      { rpc },
    );
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await createGuestInvitation(
      makeReq({ ...validBody, email: "guest@example.com" }),
      makeLookup("admin"),
    );
    expect(res.status).toBe(201);

    const body = await res.json();
    const data: GuestInvitationResponse = body.data;
    expect(data.isNewUser).toBe(false);
    expect(data.guestUserId).toBe(EXISTING_USER_ID);
    expect(rpc).not.toHaveBeenCalledWith("provision_guest_user", expect.anything());
  });

  it("new-user happy path: provisions a guest, isNewUser true, accountSetupUrl ends with /guest/<token>", async () => {
    setUpAuth();
    const newGuestUserRow = {
      id: NEW_GUEST_USER_ID,
      clerk_id: "pending_guest_abc123",
      church_group_id: CHURCH_GROUP_ID,
      role: "guest",
      name: "guest",
      email: "guest@example.com",
      phone: null,
      sms_opted_in: false,
      anonymized_at: null,
    };
    const rpc = jest.fn((fn: string) => {
      if (fn === "provision_guest_user") {
        return Promise.resolve({ data: newGuestUserRow, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
    const capturedInserts: Record<string, unknown> = {};
    const client = makeSupabaseClient(
      {
        users: { selects: [{ data: [], error: null }] },
        invitations: {
          selects: [],
          insert: {
            data: invitationRow({ user_id: NEW_GUEST_USER_ID, response_token: "b".repeat(64) }),
            error: null,
          },
        },
      },
      { rpc, onInsert: (table, payload) => (capturedInserts[table] = payload) },
    );
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await createGuestInvitation(makeReq(validBody), makeLookup("admin"));
    expect(res.status).toBe(201);

    const body = await res.json();
    const data: GuestInvitationResponse = body.data;
    expect(data.isNewUser).toBe(true);
    expect(data.guestUserId).toBe(NEW_GUEST_USER_ID);
    expect(data.accountSetupUrl).not.toBeNull();
    expect(data.accountSetupUrl).toMatch(/\/guest\/b{64}$/);

    expect(rpc).toHaveBeenCalledWith(
      "provision_guest_user",
      expect.objectContaining({ p_email: "guest@example.com" }),
    );

    const insertPayload = capturedInserts.invitations as Record<string, unknown>;
    expect(insertPayload.user_id).toBe(NEW_GUEST_USER_ID);
  });

  it("returns 409 CONFLICT when provision_guest_user reports EMAIL_TAKEN", async () => {
    setUpAuth();
    const rpc = jest.fn((fn: string) => {
      if (fn === "provision_guest_user") {
        return Promise.resolve({ data: null, error: { message: "EMAIL_TAKEN" } });
      }
      return Promise.resolve({ data: null, error: null });
    });
    const client = makeSupabaseClient(
      { users: { selects: [{ data: [], error: null }] } },
      { rpc },
    );
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await createGuestInvitation(makeReq(validBody), makeLookup("admin"));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("CONFLICT");
  });

  it("returns 409 CONFLICT (BR-08) on the existing-user path when the denial cap is reached", async () => {
    setUpAuth();
    const client = makeSupabaseClient({
      invitations: {
        selects: [
          { data: [{ id: "d1" }, { id: "d2" }, { id: "d3" }], error: null }, // 3 denials => cap reached
        ],
      },
    });
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await createGuestInvitation(makeReq(validBody), makeLookup("admin"));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("CONFLICT");
    expect(body.error).toContain("BR-08");
  });

  it("orphan cleanup: deletes the newly-provisioned guest user when the invitation insert fails", async () => {
    setUpAuth();
    const newGuestUserRow = {
      id: NEW_GUEST_USER_ID,
      clerk_id: "pending_guest_abc123",
      church_group_id: CHURCH_GROUP_ID,
      role: "guest",
      name: "guest",
      email: "guest@example.com",
      phone: null,
      sms_opted_in: false,
      anonymized_at: null,
    };
    const rpc = jest.fn((fn: string) => {
      if (fn === "provision_guest_user") {
        return Promise.resolve({ data: newGuestUserRow, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
    let deletedTable: string | undefined;
    let deletedId: string | undefined;
    const client = makeSupabaseClient(
      {
        users: { selects: [{ data: [], error: null }] },
        invitations: {
          selects: [],
          insert: { data: null, error: { message: "constraint violation" } },
        },
      },
      {
        rpc,
        onDelete: (table, id) => {
          deletedTable = table;
          deletedId = id;
        },
      },
    );
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await createGuestInvitation(makeReq(validBody), makeLookup("admin"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL");

    expect(deletedTable).toBe("users");
    expect(deletedId).toBe(NEW_GUEST_USER_ID);
  });

  it("does NOT delete anything when the invitation insert fails on the existing-user path", async () => {
    setUpAuth();
    let deleteCalled = false;
    const client = makeSupabaseClient(
      { invitations: { selects: [{ data: [], error: null }, { data: [], error: null }], insert: { data: null, error: { message: "constraint violation" } } } },
      { onDelete: () => (deleteCalled = true) },
    );
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await createGuestInvitation(makeReq(validBody), makeLookup("admin"));
    expect(res.status).toBe(500);
    expect(deleteCalled).toBe(false);
  });
});
