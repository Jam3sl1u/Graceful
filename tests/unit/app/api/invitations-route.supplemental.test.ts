// Supplemental independent tests for POST /api/invitations (issue #40),
// written by the Tester stage to cross-check the spec's edge cases that
// weren't exercised by the coder's own test file. Reuses the same mock
// scaffolding style as tests/unit/app/api/invitations-route.test.ts.

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({ getSupabaseClient: jest.fn() }));

import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { getSupabaseClient } from "@/lib/supabase/client";
import { createInvitation } from "@/app/api/invitations/handler";
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

const DEFAULT_FIXTURES: Record<string, TableFixture> = {
  service_weeks: {
    select: { data: serviceWeekRow, error: null },
  },
  invitations: {
    select: { data: [], error: null },
    insert: { data: invitationRow, error: null },
  },
};

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
    rpc?: jest.Mock;
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
    rpc: hooks?.rpc ?? jest.fn(() => Promise.resolve({ data: null, error: null })),
  };
}

beforeEach(() => {
  mockAuth.mockReset();
  mockGetSupabaseClient.mockReset();
});

describe("POST /api/invitations — supplemental tester coverage", () => {
  const validBody = {
    serviceWeekId: SERVICE_WEEK_ID,
    userId: TARGET_USER_ID,
  };

  it("returns 400 VALIDATION_FAILED when roleNote is whitespace-only", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await createInvitation(
      makeReq({ ...validBody, roleNote: "   " }),
      makeLookup("admin"),
    );
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("returns 404 NOT_FOUND (not 403) when the service week belongs to another group", async () => {
    // The handler's own church_group_id filter means a cross-group week is
    // indistinguishable from a missing one, so the fixture models it as null.
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        service_weeks: { select: { data: null, error: null } },
      }),
    );

    const res = await createInvitation(makeReq(validBody), makeLookup("set_leader"));
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });

  it("returns 500 INTERNAL when the service_weeks lookup query errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        service_weeks: { select: { data: null, error: { message: "connection refused" } } },
      }),
    );

    const res = await createInvitation(makeReq(validBody), makeLookup("admin"));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });

  it("returns 500 INTERNAL when the accepted-invitations (BR-05 first) query errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        invitations: {
          select: { data: null, error: { message: "connection refused" } },
          insert: { data: invitationRow, error: null },
        },
      }),
    );

    const res = await createInvitation(makeReq(validBody), makeLookup("admin"));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });

  it("returns 500 INTERNAL when the colliding service_weeks (BR-05 second) query errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        invitations: {
          select: { data: [{ service_week_id: "other-week" }], error: null },
        },
        service_weeks: {
          select: { data: serviceWeekRow, error: null },
          selectSecond: { data: null, error: { message: "connection refused" } },
        },
      }),
    );

    const res = await createInvitation(makeReq(validBody), makeLookup("admin"));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });

  it("does not treat the current serviceWeekId's own accepted invitation as a collision (excludes via neq)", async () => {
    // The target user already has an ACCEPTED invitation for THIS SAME week
    // (re-invite scenario). The BR-05 query must exclude serviceWeekId from
    // the collision check, so this must NOT 409.
    setUpAuth();
    const client = makeSupabaseClient({
      invitations: {
        select: { data: [{ service_week_id: SERVICE_WEEK_ID }], error: null },
      },
      service_weeks: {
        select: { data: serviceWeekRow, error: null },
        // Simulates a real Supabase .neq() filter: since the only candidate
        // week is the current serviceWeekId, the "excluding current week"
        // filter leaves zero rows.
        selectSecond: { data: [], error: null },
      },
    });
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await createInvitation(makeReq(validBody), makeLookup("admin"));
    expect(res.status).toBe(201);
  });

  it("writes an audit log with the exact expected action, entityType, and metadata shape", async () => {
    setUpAuth();
    const rpc = jest.fn(() => Promise.resolve({ data: null, error: null }));
    const client = makeSupabaseClient({}, { rpc });
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await createInvitation(
      makeReq({ ...validBody, roleNote: "Lead vocals" }),
      makeLookup("set_leader"),
    );
    expect(res.status).toBe(201);

    expect(rpc).toHaveBeenCalledWith("write_audit_log", {
      p_action: "invitation.sent",
      p_entity_type: "invitation",
      p_entity_id: invitationRow.id,
      p_metadata: {
        service_week_id: SERVICE_WEEK_ID,
        user_id: TARGET_USER_ID,
        acknowledged_conflict: false,
      },
    });
  });

  it("returns 500 INTERNAL when writeAuditLog's rpc call errors (outer try/catch surfaces it)", async () => {
    setUpAuth();
    const rpc = jest.fn(() => Promise.resolve({ data: null, error: { message: "rpc failed" } }));
    const client = makeSupabaseClient({}, { rpc });
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await createInvitation(makeReq(validBody), makeLookup("admin"));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });

  it("generates a distinct response_token per invitation (no collisions across two calls)", async () => {
    setUpAuth();
    const capturedInserts: unknown[] = [];
    const client = makeSupabaseClient(
      {},
      {
        rpc: jest.fn(() => Promise.resolve({ data: null, error: null })),
      },
    );
    // Wrap insert to capture payloads across two sequential calls.
    const originalFrom = client.from;
    client.from = jest.fn((table: string) => {
      const wrapped = (originalFrom as jest.Mock)(table);
      const originalInsert = wrapped.insert;
      wrapped.insert = jest.fn((payload: unknown) => {
        if (table === "invitations") capturedInserts.push(payload);
        return originalInsert(payload);
      });
      return wrapped;
    });
    mockGetSupabaseClient.mockReturnValue(client);

    await createInvitation(makeReq(validBody), makeLookup("admin"));
    await createInvitation(makeReq(validBody), makeLookup("admin"));

    expect(capturedInserts).toHaveLength(2);
    const tokenA = (capturedInserts[0] as Record<string, unknown>).response_token;
    const tokenB = (capturedInserts[1] as Record<string, unknown>).response_token;
    expect(tokenA).not.toBe(tokenB);
    expect(tokenA).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenB).toMatch(/^[0-9a-f]{64}$/);
  });
});
