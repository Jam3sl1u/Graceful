jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({ getSupabaseClient: jest.fn() }));

import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { getSupabaseClient } from "@/lib/supabase/client";
import { getAuditLog, type AuditLogItem } from "@/app/api/church-group/audit-log/handler";
import type { AuthContext, UserLookup } from "@/lib/api/auth";
import type { UserRole } from "@/types/domain";

const mockAuth = auth as unknown as jest.Mock;
const mockGetSupabaseClient = getSupabaseClient as unknown as jest.Mock;

const JWT = "supabase-jwt";
const CHURCH_GROUP_ID = "group-1";

function makeReq(query: Record<string, string> = {}): NextRequest {
  const searchParams = new URLSearchParams(query);
  return {
    nextUrl: { searchParams },
  } as unknown as NextRequest;
}

function makeLookup(role: UserRole): UserLookup {
  const ctx: AuthContext = {
    userId: "user-1",
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

const auditRows = [
  {
    id: "log-2",
    action: "user.role_changed",
    entity_type: "user",
    entity_id: "user-2",
    user_id: "user-1",
    metadata: { old_value: "member", new_value: "set_leader" },
    created_at: "2026-07-07T00:00:01.000Z",
  },
  {
    id: "log-1",
    action: "group.created",
    entity_type: "church_group",
    entity_id: CHURCH_GROUP_ID,
    user_id: null,
    metadata: {},
    created_at: "2026-07-06T00:00:00.000Z",
  },
];

type QueryResult = { data: unknown; error: unknown; count?: number | null };

function makeSupabaseClient(result: QueryResult = { data: auditRows, error: null, count: 2 }) {
  const range = jest.fn().mockResolvedValue(result);
  const order2 = jest.fn(() => ({ range }));
  const order1 = jest.fn(() => ({ order: order2 }));
  const select = jest.fn(() => ({ order: order1 }));
  const from = jest.fn(() => ({ select }));
  return { from, select, order1, order2, range };
}

describe("GET /api/church-group/audit-log", () => {
  beforeEach(() => {
    mockAuth.mockReset();
    mockGetSupabaseClient.mockReset();
  });

  it("returns 401 UNAUTHENTICATED when Clerk userId is null (lookup never consulted)", async () => {
    mockAuth.mockResolvedValue({ userId: null, getToken: jest.fn() });
    const lookup = jest.fn();

    const res = await getAuditLog(makeReq(), lookup as unknown as UserLookup);
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("returns 401 UNAUTHENTICATED when there is no matching users row (requireAuth)", async () => {
    mockAuth.mockResolvedValue({ userId: "clerk_test", getToken: jest.fn() });
    const lookup: UserLookup = async () => null;

    const res = await getAuditLog(makeReq(), lookup);
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
  });

  it.each<UserRole>(["member", "set_leader", "guest"])(
    "returns 403 FORBIDDEN for role = '%s'",
    async (role) => {
      setUpAuth();
      mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

      const res = await getAuditLog(makeReq(), makeLookup(role));
      expect(res.status).toBe(403);

      const body = await res.json();
      expect(body.code).toBe("FORBIDDEN");
      expect(mockGetSupabaseClient).not.toHaveBeenCalled();
    },
  );

  it("returns 401 UNAUTHENTICATED when getToken yields no JWT (does not build a client)", async () => {
    setUpAuth(null);

    const res = await getAuditLog(makeReq(), makeLookup("admin"));
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 400 VALIDATION_FAILED for a negative page", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await getAuditLog(makeReq({ page: "-1" }), makeLookup("admin"));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 400 VALIDATION_FAILED when pageSize > 100", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await getAuditLog(makeReq({ pageSize: "101" }), makeLookup("admin"));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("returns 400 VALIDATION_FAILED for a non-numeric page", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await getAuditLog(makeReq({ page: "not-a-number" }), makeLookup("admin"));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("200 for admin: maps rows to camelCase AuditLogItem[] with pagination, newest first as returned by the query", async () => {
    setUpAuth();
    const client = makeSupabaseClient({ data: auditRows, error: null, count: 2 });
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await getAuditLog(makeReq(), makeLookup("admin"));
    expect(res.status).toBe(200);

    const body = await res.json();
    const entries: AuditLogItem[] = body.data.entries;
    expect(entries).toEqual([
      {
        id: "log-2",
        action: "user.role_changed",
        entityType: "user",
        entityId: "user-2",
        userId: "user-1",
        metadata: { old_value: "member", new_value: "set_leader" },
        createdAt: "2026-07-07T00:00:01.000Z",
      },
      {
        id: "log-1",
        action: "group.created",
        entityType: "church_group",
        entityId: CHURCH_GROUP_ID,
        userId: null,
        metadata: {},
        createdAt: "2026-07-06T00:00:00.000Z",
      },
    ]);
    expect(body.data.pagination).toEqual({ page: 1, pageSize: 50, total: 2 });
  });

  it("orders by created_at DESC then id DESC (stable tiebreak) and applies range from page/pageSize", async () => {
    setUpAuth();
    const client = makeSupabaseClient({ data: [], error: null, count: 0 });
    mockGetSupabaseClient.mockReturnValue(client);

    await getAuditLog(makeReq({ page: "2", pageSize: "10" }), makeLookup("admin"));

    expect(client.select).toHaveBeenCalledWith(
      "id, action, entity_type, entity_id, user_id, metadata, created_at",
      { count: "exact" },
    );
    expect(client.order1).toHaveBeenCalledWith("created_at", { ascending: false });
    expect(client.order2).toHaveBeenCalledWith("id", { ascending: false });
    expect(client.range).toHaveBeenCalledWith(10, 19); // (page-1)*pageSize .. from+pageSize-1
  });

  it("returns 200 with entries: [] and pagination.total: 0 for zero matching rows", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({ data: [], error: null, count: 0 }),
    );

    const res = await getAuditLog(makeReq(), makeLookup("admin"));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data.entries).toEqual([]);
    expect(body.data.pagination).toEqual({ page: 1, pageSize: 50, total: 0 });
  });

  it("treats a null count as total: 0", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({ data: [], error: null, count: null }),
    );

    const res = await getAuditLog(makeReq(), makeLookup("admin"));
    const body = await res.json();
    expect(body.data.pagination.total).toBe(0);
  });

  it("returns 500 INTERNAL when the DB query returns an error", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({ data: null, error: { message: "connection refused" }, count: null }),
    );

    const res = await getAuditLog(makeReq(), makeLookup("admin"));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });
});
