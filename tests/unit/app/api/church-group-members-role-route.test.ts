jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({ getSupabaseClient: jest.fn() }));
jest.mock("@/lib/audit/write-audit-log", () => ({ writeAuditLog: jest.fn() }));

import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { getSupabaseClient } from "@/lib/supabase/client";
import { writeAuditLog } from "@/lib/audit/write-audit-log";
import { patchMemberRole } from "@/app/api/church-group/members/[id]/role/handler";
import type { AuthContext, UserLookup } from "@/lib/api/auth";
import type { UserRole } from "@/types/domain";

const mockAuth = auth as unknown as jest.Mock;
const mockGetSupabaseClient = getSupabaseClient as unknown as jest.Mock;
const mockWriteAuditLog = writeAuditLog as unknown as jest.Mock;

const JWT = "supabase-jwt";
const CHURCH_GROUP_ID = "group-1";
const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_ID = "22222222-2222-4222-8222-222222222222";

function makeLookup(role: UserRole, userId: string = ADMIN_ID): UserLookup {
  const ctx: AuthContext = { userId, churchGroupId: CHURCH_GROUP_ID, role };
  return async () => ctx;
}

function makeReq(body: unknown): NextRequest {
  return { json: jest.fn().mockResolvedValue(body) } as unknown as NextRequest;
}

type QueryResult = { data?: unknown; error?: unknown; count?: number | null };

// Minimal chainable query-builder mock. select/eq/update all return the
// builder itself so any chain shape resolves; maybeSingle() resolves the
// canned result, and the builder is also directly awaitable (thenable) for
// the count query, which has no .maybeSingle() call in the handler.
function makeQueryBuilder(result: QueryResult) {
  const builder: PromiseLike<QueryResult> & Record<string, jest.Mock> = {
    select: jest.fn(() => builder),
    eq: jest.fn(() => builder),
    update: jest.fn(() => builder),
    maybeSingle: jest.fn(() => Promise.resolve(result)),
    then: ((resolve: (value: QueryResult) => void, reject: (reason: unknown) => void) =>
      Promise.resolve(result).then(resolve, reject)) as never,
  } as unknown as PromiseLike<QueryResult> & Record<string, jest.Mock>;
  return builder;
}

// Each entry in `queue` corresponds to one `.from("users")` call, consumed in
// the handler's fixed call order: target lookup -> (admin count) -> update.
function makeSupabaseClient(queue: QueryResult[]) {
  const results = [...queue];
  const from = jest.fn(() => makeQueryBuilder(results.shift() ?? { data: null, error: null }));
  return { from };
}

function setUpAuth() {
  mockAuth.mockResolvedValue({ userId: "clerk_test", getToken: jest.fn().mockResolvedValue(JWT) });
}

describe("PATCH /api/church-group/members/[id]/role", () => {
  beforeEach(() => {
    mockAuth.mockReset();
    mockGetSupabaseClient.mockReset();
    mockWriteAuditLog.mockReset();
    mockWriteAuditLog.mockResolvedValue(undefined);
  });

  it("returns 401 UNAUTHENTICATED when Clerk userId is null (lookup never consulted)", async () => {
    mockAuth.mockResolvedValue({ userId: null, getToken: jest.fn() });
    const lookup = jest.fn();

    const res = await patchMemberRole(
      makeReq({ role: "member" }),
      TARGET_ID,
      lookup as unknown as UserLookup,
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("returns 401 UNAUTHENTICATED when getToken resolves no JWT", async () => {
    mockAuth.mockResolvedValue({
      userId: "clerk_test",
      getToken: jest.fn().mockResolvedValue(null),
    });

    const res = await patchMemberRole(makeReq({ role: "member" }), TARGET_ID, makeLookup("admin"));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it.each<UserRole>(["set_leader", "member", "guest"])(
    "returns 403 FORBIDDEN for role = '%s'",
    async (role) => {
      setUpAuth();
      const res = await patchMemberRole(makeReq({ role: "admin" }), TARGET_ID, makeLookup(role));
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.code).toBe("FORBIDDEN");
      expect(mockGetSupabaseClient).not.toHaveBeenCalled();
    },
  );

  it("returns 400 VALIDATION_FAILED for an invalid role value", async () => {
    setUpAuth();
    const res = await patchMemberRole(
      makeReq({ role: "superadmin" }),
      TARGET_ID,
      makeLookup("admin"),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 400 VALIDATION_FAILED on non-JSON / empty body", async () => {
    setUpAuth();
    const req = {
      json: jest.fn().mockRejectedValue(new SyntaxError("Unexpected end of JSON input")),
    } as unknown as NextRequest;

    const res = await patchMemberRole(req, TARGET_ID, makeLookup("admin"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 400 VALIDATION_FAILED for a malformed (non-UUID) target id", async () => {
    setUpAuth();
    const res = await patchMemberRole(
      makeReq({ role: "member" }),
      "not-a-uuid",
      makeLookup("admin"),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 404 NOT_FOUND when the target user does not exist in the group", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient([{ data: null, error: null }]));

    const res = await patchMemberRole(makeReq({ role: "member" }), TARGET_ID, makeLookup("admin"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
    expect(mockWriteAuditLog).not.toHaveBeenCalled();
  });

  it("returns 404 NOT_FOUND (not 403) when the target belongs to a different church group", async () => {
    // The church_group_id filter + RLS make "wrong group" indistinguishable
    // from "doesn't exist" — the query itself returns no row either way.
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient([{ data: null, error: null }]));

    const res = await patchMemberRole(makeReq({ role: "member" }), TARGET_ID, makeLookup("admin"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });

  it("BR-12: returns 422 when demoting the sole remaining admin", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient([
        { data: { id: TARGET_ID, role: "admin" }, error: null }, // target lookup
        { count: 1, error: null }, // admin count
      ]),
    );

    const res = await patchMemberRole(makeReq({ role: "member" }), TARGET_ID, makeLookup("admin"));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(mockWriteAuditLog).not.toHaveBeenCalled();
  });

  it("BR-12: returns 422 when an admin demotes themselves as the sole remaining admin", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient([
        { data: { id: ADMIN_ID, role: "admin" }, error: null },
        { count: 1, error: null },
      ]),
    );

    const res = await patchMemberRole(
      makeReq({ role: "set_leader" }),
      ADMIN_ID,
      makeLookup("admin", ADMIN_ID),
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(mockWriteAuditLog).not.toHaveBeenCalled();
  });

  it("allows demoting an admin when a co-admin exists, and writes the audit log", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient([
        { data: { id: TARGET_ID, role: "admin" }, error: null },
        { count: 2, error: null },
        { data: { id: TARGET_ID, role: "member" }, error: null }, // update
      ]),
    );

    const res = await patchMemberRole(makeReq({ role: "member" }), TARGET_ID, makeLookup("admin"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ id: TARGET_ID, role: "member" });
    expect(mockWriteAuditLog).toHaveBeenCalledWith(expect.anything(), {
      action: "user.role_changed",
      entityType: "user",
      entityId: TARGET_ID,
      metadata: { old_value: "admin", new_value: "member" },
    });
  });

  it("allows an admin to demote themselves when a co-admin exists", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient([
        { data: { id: ADMIN_ID, role: "admin" }, error: null },
        { count: 2, error: null },
        { data: { id: ADMIN_ID, role: "member" }, error: null },
      ]),
    );

    const res = await patchMemberRole(
      makeReq({ role: "member" }),
      ADMIN_ID,
      makeLookup("admin", ADMIN_ID),
    );
    expect(res.status).toBe(200);
  });

  it("BR-03/BR-04: promoting a member to a second admin succeeds with no special-casing (no admin-count query made)", async () => {
    setUpAuth();
    const client = makeSupabaseClient([
      { data: { id: TARGET_ID, role: "member" }, error: null }, // target lookup
      { data: { id: TARGET_ID, role: "admin" }, error: null }, // update
    ]);
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await patchMemberRole(makeReq({ role: "admin" }), TARGET_ID, makeLookup("admin"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ id: TARGET_ID, role: "admin" });
    // Only 2 `.from("users")` calls: target lookup + update. A 3rd would mean
    // an (unnecessary) admin-count query was made for a promotion.
    expect(client.from).toHaveBeenCalledTimes(2);
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ metadata: { old_value: "member", new_value: "admin" } }),
    );
  });

  it("treats a same-role PATCH as an idempotent success and still writes the audit log", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient([
        { data: { id: TARGET_ID, role: "member" }, error: null },
        { data: { id: TARGET_ID, role: "member" }, error: null },
      ]),
    );

    const res = await patchMemberRole(makeReq({ role: "member" }), TARGET_ID, makeLookup("admin"));
    expect(res.status).toBe(200);
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ metadata: { old_value: "member", new_value: "member" } }),
    );
  });

  it("returns 500 INTERNAL when the target-user lookup errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient([{ data: null, error: { message: "connection refused" } }]),
    );

    const res = await patchMemberRole(makeReq({ role: "member" }), TARGET_ID, makeLookup("admin"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });

  it("returns 500 INTERNAL when the admin-count query errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient([
        { data: { id: TARGET_ID, role: "admin" }, error: null },
        { count: null, error: { message: "connection refused" } },
      ]),
    );

    const res = await patchMemberRole(makeReq({ role: "member" }), TARGET_ID, makeLookup("admin"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });

  it("returns 500 INTERNAL when the update query errors or returns no row", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient([
        { data: { id: TARGET_ID, role: "member" }, error: null },
        { data: null, error: { message: "connection refused" } },
      ]),
    );

    const res = await patchMemberRole(
      makeReq({ role: "set_leader" }),
      TARGET_ID,
      makeLookup("admin"),
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });

  it("returns 500 INTERNAL when writeAuditLog throws, and does not report success", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient([
        { data: { id: TARGET_ID, role: "member" }, error: null },
        { data: { id: TARGET_ID, role: "set_leader" }, error: null },
      ]),
    );
    mockWriteAuditLog.mockRejectedValue(new Error("audit write failed"));

    const res = await patchMemberRole(
      makeReq({ role: "set_leader" }),
      TARGET_ID,
      makeLookup("admin"),
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
    expect(body.data).toBeUndefined();
  });
});
