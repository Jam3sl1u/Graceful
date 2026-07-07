jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn(), currentUser: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({ getSupabaseClient: jest.fn() }));

import { auth, currentUser } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { getSupabaseClient } from "@/lib/supabase/client";
import { POST } from "@/app/api/church-group/join/route";

const mockAuth = auth as unknown as jest.Mock;
const mockCurrentUser = currentUser as unknown as jest.Mock;
const mockGetSupabaseClient = getSupabaseClient as unknown as jest.Mock;

function makeReq(body: unknown): NextRequest {
  return {
    json: jest.fn().mockResolvedValue(body),
  } as unknown as NextRequest;
}

function makeSupabaseRpc(result: { data: unknown; error: unknown }) {
  const rpc = jest.fn().mockResolvedValue(result);
  return { rpc };
}

const CLERK_ID = "user_clerk123";
const JWT = "supabase-jwt";

const userRow = {
  id: "user-1",
  clerk_id: CLERK_ID,
  church_group_id: "group-1",
  role: "member",
  name: "Jane Member",
  email: "jane@example.com",
};

describe("POST /api/church-group/join", () => {
  beforeEach(() => {
    mockAuth.mockReset();
    mockCurrentUser.mockReset();
    mockGetSupabaseClient.mockReset();
  });

  it("201 happy path — calls rpc with correct params, returns membership", async () => {
    const mockGetToken = jest.fn().mockResolvedValue(JWT);
    mockAuth.mockResolvedValue({ userId: CLERK_ID, getToken: mockGetToken });
    mockCurrentUser.mockResolvedValue({
      fullName: "Jane Member",
      firstName: "Jane",
      lastName: "Member",
      username: "janemember",
      primaryEmailAddress: { emailAddress: "jane@example.com" },
    });
    const { rpc } = makeSupabaseRpc({ data: userRow, error: null });
    mockGetSupabaseClient.mockReturnValue({ rpc });

    const req = makeReq({ inviteCode: "ABCD2345" });
    const res = await POST(req);

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toEqual({ data: userRow });
    expect(mockGetSupabaseClient).toHaveBeenCalledWith(JWT);
    expect(rpc).toHaveBeenCalledWith("join_church_group", {
      p_invite_code: "ABCD2345",
      p_member_name: "Jane Member",
      p_member_email: "jane@example.com",
    });
  });

  it("inviteCode is uppercased/trimmed", async () => {
    const mockGetToken = jest.fn().mockResolvedValue(JWT);
    mockAuth.mockResolvedValue({ userId: CLERK_ID, getToken: mockGetToken });
    mockCurrentUser.mockResolvedValue(null);
    const { rpc } = makeSupabaseRpc({ data: userRow, error: null });
    mockGetSupabaseClient.mockReturnValue({ rpc });

    const req = makeReq({ inviteCode: " abcd2345 " });
    const res = await POST(req);

    expect(res.status).toBe(201);
    expect(rpc).toHaveBeenCalledWith(
      "join_church_group",
      expect.objectContaining({ p_invite_code: "ABCD2345" }),
    );
  });

  it("400 INVALID_INVITE_CODE", async () => {
    const mockGetToken = jest.fn().mockResolvedValue(JWT);
    mockAuth.mockResolvedValue({ userId: CLERK_ID, getToken: mockGetToken });
    mockCurrentUser.mockResolvedValue(null);
    const { rpc } = makeSupabaseRpc({
      data: null,
      error: { message: "INVALID_INVITE_CODE" },
    });
    mockGetSupabaseClient.mockReturnValue({ rpc });

    const req = makeReq({ inviteCode: "NOPE0000" });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("400 on missing/empty inviteCode", async () => {
    const mockGetToken = jest.fn().mockResolvedValue(JWT);
    mockAuth.mockResolvedValue({ userId: CLERK_ID, getToken: mockGetToken });

    const req = makeReq({ inviteCode: "" });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("400 on non-JSON/empty body", async () => {
    const mockGetToken = jest.fn().mockResolvedValue(JWT);
    mockAuth.mockResolvedValue({ userId: CLERK_ID, getToken: mockGetToken });

    const req = {
      json: jest.fn().mockRejectedValue(new SyntaxError("Unexpected end of JSON input")),
    } as unknown as NextRequest;
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("409 USER_ALREADY_IN_GROUP", async () => {
    const mockGetToken = jest.fn().mockResolvedValue(JWT);
    mockAuth.mockResolvedValue({ userId: CLERK_ID, getToken: mockGetToken });
    mockCurrentUser.mockResolvedValue(null);
    const { rpc } = makeSupabaseRpc({
      data: null,
      error: { message: "USER_ALREADY_IN_GROUP" },
    });
    mockGetSupabaseClient.mockReturnValue({ rpc });

    const req = makeReq({ inviteCode: "ABCD2345" });
    const res = await POST(req);

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("CONFLICT");
  });

  it("401 when no Clerk userId", async () => {
    mockAuth.mockResolvedValue({ userId: null, getToken: jest.fn() });

    const req = makeReq({ inviteCode: "ABCD2345" });
    const res = await POST(req);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("401 when getToken returns no JWT", async () => {
    const mockGetToken = jest.fn().mockResolvedValue(null);
    mockAuth.mockResolvedValue({ userId: CLERK_ID, getToken: mockGetToken });

    const req = makeReq({ inviteCode: "ABCD2345" });
    const res = await POST(req);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("500 on generic rpc error", async () => {
    const mockGetToken = jest.fn().mockResolvedValue(JWT);
    mockAuth.mockResolvedValue({ userId: CLERK_ID, getToken: mockGetToken });
    mockCurrentUser.mockResolvedValue(null);
    const { rpc } = makeSupabaseRpc({
      data: null,
      error: { message: "connection refused" },
    });
    mockGetSupabaseClient.mockReturnValue({ rpc });

    const req = makeReq({ inviteCode: "ABCD2345" });
    const res = await POST(req);

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });

  it("500 when an unexpected error is thrown (e.g. currentUser rejects)", async () => {
    const mockGetToken = jest.fn().mockResolvedValue(JWT);
    mockAuth.mockResolvedValue({ userId: CLERK_ID, getToken: mockGetToken });
    mockCurrentUser.mockRejectedValue(new Error("Clerk API unavailable"));

    const req = makeReq({ inviteCode: "ABCD2345" });
    const res = await POST(req);

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("falls back to 'Member' when no name is available from Clerk", async () => {
    const mockGetToken = jest.fn().mockResolvedValue(JWT);
    mockAuth.mockResolvedValue({ userId: CLERK_ID, getToken: mockGetToken });
    mockCurrentUser.mockResolvedValue(null);
    const { rpc } = makeSupabaseRpc({ data: userRow, error: null });
    mockGetSupabaseClient.mockReturnValue({ rpc });

    const req = makeReq({ inviteCode: "ABCD2345" });
    await POST(req);

    expect(rpc).toHaveBeenCalledWith(
      "join_church_group",
      expect.objectContaining({ p_member_name: "Member", p_member_email: null }),
    );
  });
});
