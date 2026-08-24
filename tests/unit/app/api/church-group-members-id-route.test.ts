jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({ getSupabaseClient: jest.fn() }));
jest.mock("@/lib/audit/write-audit-log", () => ({ writeAuditLog: jest.fn() }));

import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { getSupabaseClient } from "@/lib/supabase/client";
import { writeAuditLog } from "@/lib/audit/write-audit-log";
import { deleteMember } from "@/app/api/church-group/members/[id]/handler";
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

function makeReq(): NextRequest {
  return {} as unknown as NextRequest;
}

function makeSupabaseRpc(result: { data: unknown; error: unknown }) {
  const rpc = jest.fn().mockResolvedValue(result);
  return { rpc };
}

function setUpAuth() {
  mockAuth.mockResolvedValue({ userId: "clerk_test", getToken: jest.fn().mockResolvedValue(JWT) });
}

const anonymizedRow = {
  id: TARGET_ID,
  clerk_id: `deleted-${TARGET_ID}`,
  church_group_id: CHURCH_GROUP_ID,
  role: "guest",
  name: "Deleted User",
  email: null,
  phone: null,
  sms_opted_in: false,
  anonymized_at: "2026-07-10T00:00:00.000Z",
};

describe("DELETE /api/church-group/members/[id]", () => {
  beforeEach(() => {
    mockAuth.mockReset();
    mockGetSupabaseClient.mockReset();
    mockWriteAuditLog.mockReset();
    mockWriteAuditLog.mockResolvedValue(undefined);
  });

  it("returns 401 UNAUTHENTICATED when Clerk userId is null (lookup never consulted)", async () => {
    mockAuth.mockResolvedValue({ userId: null, getToken: jest.fn() });
    const lookup = jest.fn();

    const res = await deleteMember(makeReq(), TARGET_ID, lookup as unknown as UserLookup);
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

    const res = await deleteMember(makeReq(), TARGET_ID, makeLookup("admin"));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it.each<UserRole>(["set_leader", "member", "guest"])(
    "returns 403 FORBIDDEN for role = '%s' (app-layer check, rpc never called)",
    async (role) => {
      setUpAuth();
      const res = await deleteMember(makeReq(), TARGET_ID, makeLookup(role));
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.code).toBe("FORBIDDEN");
      expect(mockGetSupabaseClient).not.toHaveBeenCalled();
    },
  );

  it("returns 400 VALIDATION_FAILED for a malformed (non-UUID) target id", async () => {
    setUpAuth();
    const res = await deleteMember(makeReq(), "not-a-uuid", makeLookup("admin"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 404 NOT_FOUND when the rpc reports the target is missing / wrong group / already anonymized", async () => {
    setUpAuth();
    const { rpc } = makeSupabaseRpc({ data: null, error: { message: "NOT_FOUND" } });
    mockGetSupabaseClient.mockReturnValue({ rpc });

    const res = await deleteMember(makeReq(), TARGET_ID, makeLookup("admin"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
    expect(mockWriteAuditLog).not.toHaveBeenCalled();
  });

  it("BR-12: returns 422 when removing the sole remaining admin", async () => {
    setUpAuth();
    const { rpc } = makeSupabaseRpc({ data: null, error: { message: "LAST_ADMIN" } });
    mockGetSupabaseClient.mockReturnValue({ rpc });

    const res = await deleteMember(makeReq(), TARGET_ID, makeLookup("admin"));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(mockWriteAuditLog).not.toHaveBeenCalled();
  });

  it("returns 403 FORBIDDEN when the rpc's own caller-role check rejects (defense in depth)", async () => {
    setUpAuth();
    const { rpc } = makeSupabaseRpc({ data: null, error: { message: "FORBIDDEN" } });
    mockGetSupabaseClient.mockReturnValue({ rpc });

    const res = await deleteMember(makeReq(), TARGET_ID, makeLookup("admin"));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("FORBIDDEN");
  });

  it("returns 401 UNAUTHENTICATED when the rpc reports no caller session", async () => {
    setUpAuth();
    const { rpc } = makeSupabaseRpc({ data: null, error: { message: "UNAUTHENTICATED" } });
    mockGetSupabaseClient.mockReturnValue({ rpc });

    const res = await deleteMember(makeReq(), TARGET_ID, makeLookup("admin"));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
  });

  it("returns 500 INTERNAL on an unrecognized rpc error", async () => {
    setUpAuth();
    const { rpc } = makeSupabaseRpc({ data: null, error: { message: "connection refused" } });
    mockGetSupabaseClient.mockReturnValue({ rpc });

    const res = await deleteMember(makeReq(), TARGET_ID, makeLookup("admin"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });

  it("returns 500 INTERNAL when the rpc resolves with no data and no error", async () => {
    setUpAuth();
    const { rpc } = makeSupabaseRpc({ data: null, error: null });
    mockGetSupabaseClient.mockReturnValue({ rpc });

    const res = await deleteMember(makeReq(), TARGET_ID, makeLookup("admin"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
    expect(mockWriteAuditLog).not.toHaveBeenCalled();
  });

  it("200 success — calls rpc with the target id, returns { id }, and writes the audit log", async () => {
    setUpAuth();
    const { rpc } = makeSupabaseRpc({ data: anonymizedRow, error: null });
    mockGetSupabaseClient.mockReturnValue({ rpc });

    const res = await deleteMember(makeReq(), TARGET_ID, makeLookup("admin"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ id: TARGET_ID });
    expect(rpc).toHaveBeenCalledWith("remove_church_group_member", {
      p_target_user_id: TARGET_ID,
    });
    expect(mockWriteAuditLog).toHaveBeenCalledWith(expect.anything(), {
      action: "member.removed",
      entityType: "user",
      entityId: TARGET_ID,
      metadata: {},
    });
  });

  it("returns 500 INTERNAL when writeAuditLog throws, and does not report success", async () => {
    setUpAuth();
    const { rpc } = makeSupabaseRpc({ data: anonymizedRow, error: null });
    mockGetSupabaseClient.mockReturnValue({ rpc });
    mockWriteAuditLog.mockRejectedValue(new Error("audit write failed"));

    const res = await deleteMember(makeReq(), TARGET_ID, makeLookup("admin"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
    expect(body.data).toBeUndefined();
  });
});
