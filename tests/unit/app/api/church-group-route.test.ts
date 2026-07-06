jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn(), currentUser: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({ getSupabaseClient: jest.fn() }));

import { auth, currentUser } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { getSupabaseClient } from "@/lib/supabase/client";
import { PUT } from "@/app/api/church-group/route";

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

const groupRow = {
  id: "group-1",
  name: "Grace Church",
  denomination: null,
  timezone: "America/Chicago",
  logo_url: null,
  invite_code: "ABCD2345",
  created_at: "2026-07-06T00:00:00.000Z",
  updated_at: "2026-07-06T00:00:00.000Z",
};

describe("PUT /api/church-group", () => {
  beforeEach(() => {
    mockAuth.mockReset();
    mockCurrentUser.mockReset();
    mockGetSupabaseClient.mockReset();
  });

  it("201 happy path — calls rpc with correct params, returns group incl. invite_code", async () => {
    const mockGetToken = jest.fn().mockResolvedValue(JWT);
    mockAuth.mockResolvedValue({ userId: CLERK_ID, getToken: mockGetToken });
    mockCurrentUser.mockResolvedValue({
      fullName: "Jane Admin",
      firstName: "Jane",
      lastName: "Admin",
      username: "janeadmin",
      primaryEmailAddress: { emailAddress: "jane@example.com" },
    });
    const { rpc } = makeSupabaseRpc({ data: groupRow, error: null });
    mockGetSupabaseClient.mockReturnValue({ rpc });

    const req = makeReq({ name: "Grace Church", timezone: "America/Chicago" });
    const res = await PUT(req);

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toEqual({ data: groupRow });
    expect(mockGetSupabaseClient).toHaveBeenCalledWith(JWT);
    expect(rpc).toHaveBeenCalledWith("create_church_group", {
      p_name: "Grace Church",
      p_timezone: "America/Chicago",
      p_denomination: null,
      p_logo_url: null,
      p_creator_name: "Jane Admin",
      p_creator_email: "jane@example.com",
    });
  });

  it("400 on missing name", async () => {
    const mockGetToken = jest.fn().mockResolvedValue(JWT);
    mockAuth.mockResolvedValue({ userId: CLERK_ID, getToken: mockGetToken });

    const req = makeReq({ timezone: "America/Chicago" });
    const res = await PUT(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("400 on invalid timezone", async () => {
    const mockGetToken = jest.fn().mockResolvedValue(JWT);
    mockAuth.mockResolvedValue({ userId: CLERK_ID, getToken: mockGetToken });

    const req = makeReq({ name: "Grace Church", timezone: "Mars/Phobos" });
    const res = await PUT(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("401 when no Clerk userId", async () => {
    mockAuth.mockResolvedValue({ userId: null, getToken: jest.fn() });

    const req = makeReq({ name: "Grace Church" });
    const res = await PUT(req);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("401 when getToken returns no JWT", async () => {
    const mockGetToken = jest.fn().mockResolvedValue(null);
    mockAuth.mockResolvedValue({ userId: CLERK_ID, getToken: mockGetToken });

    const req = makeReq({ name: "Grace Church" });
    const res = await PUT(req);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("409 when rpc returns USER_ALREADY_IN_GROUP error", async () => {
    const mockGetToken = jest.fn().mockResolvedValue(JWT);
    mockAuth.mockResolvedValue({ userId: CLERK_ID, getToken: mockGetToken });
    mockCurrentUser.mockResolvedValue(null);
    const { rpc } = makeSupabaseRpc({
      data: null,
      error: { message: "USER_ALREADY_IN_GROUP" },
    });
    mockGetSupabaseClient.mockReturnValue({ rpc });

    const req = makeReq({ name: "Grace Church" });
    const res = await PUT(req);

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("CONFLICT");
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

    const req = makeReq({ name: "Grace Church" });
    const res = await PUT(req);

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });

  it("falls back to 'Admin' when no name is available from Clerk", async () => {
    const mockGetToken = jest.fn().mockResolvedValue(JWT);
    mockAuth.mockResolvedValue({ userId: CLERK_ID, getToken: mockGetToken });
    mockCurrentUser.mockResolvedValue(null);
    const { rpc } = makeSupabaseRpc({ data: groupRow, error: null });
    mockGetSupabaseClient.mockReturnValue({ rpc });

    const req = makeReq({ name: "Grace Church" });
    await PUT(req);

    expect(rpc).toHaveBeenCalledWith(
      "create_church_group",
      expect.objectContaining({ p_creator_name: "Admin", p_creator_email: null }),
    );
  });
});
