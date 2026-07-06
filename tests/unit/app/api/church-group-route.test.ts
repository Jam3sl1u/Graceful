jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn(), currentUser: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({ getSupabaseClient: jest.fn() }));

import type { NextRequest } from "next/server";
import { auth, currentUser } from "@clerk/nextjs/server";
import { getSupabaseClient } from "@/lib/supabase/client";
import { GET, PUT } from "@/app/api/church-group/route";

const mockAuth = auth as unknown as jest.Mock;
const mockCurrentUser = currentUser as unknown as jest.Mock;
const mockGetSupabaseClient = getSupabaseClient as unknown as jest.Mock;

function fakeReq(body: unknown): NextRequest {
  return {
    json: async () => {
      if (body === "__MALFORMED__") {
        throw new SyntaxError("Unexpected end of JSON input");
      }
      return body;
    },
  } as unknown as NextRequest;
}

const VALID_BODY = {
  name: "Grace Church",
  timezone: "America/New_York",
  denomination: "Baptist",
  logo_url: "https://example.com/logo.png",
};

const GROUP_ROW = {
  id: "group-uuid-1",
  name: "Grace Church",
  denomination: "Baptist",
  timezone: "America/New_York",
  logo_url: "https://example.com/logo.png",
  invite_code: "AB3D5F7H",
  created_at: "2026-07-06T00:00:00.000Z",
  updated_at: "2026-07-06T00:00:00.000Z",
};

function mockAuthenticated(jwt: string | null = "supabase-jwt") {
  mockAuth.mockResolvedValue({
    userId: "clerk_test_123",
    getToken: jest.fn().mockResolvedValue(jwt),
  });
}

describe("PUT /api/church-group", () => {
  beforeEach(() => {
    mockAuth.mockReset();
    mockCurrentUser.mockReset();
    mockGetSupabaseClient.mockReset();
    mockCurrentUser.mockResolvedValue({
      firstName: "Jane",
      lastName: "Doe",
      username: "janedoe",
      primaryEmailAddress: { emailAddress: "jane@example.com" },
      emailAddresses: [{ emailAddress: "jane@example.com" }],
    });
  });

  it("happy path — valid body → 201 with created group, RPC called with mapped params", async () => {
    mockAuthenticated();
    const rpc = jest.fn().mockResolvedValue({ data: GROUP_ROW, error: null });
    mockGetSupabaseClient.mockReturnValue({ rpc });

    const res = await PUT(fakeReq(VALID_BODY));
    expect(res.status).toBe(201);

    const json = await res.json();
    expect(json.data).toEqual(GROUP_ROW);

    expect(mockGetSupabaseClient).toHaveBeenCalledWith("supabase-jwt");
    expect(rpc).toHaveBeenCalledWith("create_church_group", {
      p_name: "Grace Church",
      p_timezone: "America/New_York",
      p_denomination: "Baptist",
      p_logo_url: "https://example.com/logo.png",
      p_user_name: "Jane Doe",
      p_user_email: "jane@example.com",
    });
  });

  it("omitted timezone defaults to America/Chicago", async () => {
    mockAuthenticated();
    const rpc = jest.fn().mockResolvedValue({ data: GROUP_ROW, error: null });
    mockGetSupabaseClient.mockReturnValue({ rpc });

    const res = await PUT(fakeReq({ name: "Grace Church" }));
    expect(res.status).toBe(201);
    expect(rpc).toHaveBeenCalledWith(
      "create_church_group",
      expect.objectContaining({ p_timezone: "America/Chicago" }),
    );
  });

  it("omitted denomination/logo_url → nulls passed to RPC", async () => {
    mockAuthenticated();
    const rpc = jest.fn().mockResolvedValue({ data: GROUP_ROW, error: null });
    mockGetSupabaseClient.mockReturnValue({ rpc });

    const res = await PUT(fakeReq({ name: "Grace Church", timezone: "America/New_York" }));
    expect(res.status).toBe(201);
    expect(rpc).toHaveBeenCalledWith(
      "create_church_group",
      expect.objectContaining({ p_denomination: null, p_logo_url: null }),
    );
  });

  it("missing name → 400 VALIDATION_FAILED (RPC never called)", async () => {
    mockAuthenticated();
    const rpc = jest.fn();
    mockGetSupabaseClient.mockReturnValue({ rpc });

    const res = await PUT(fakeReq({ timezone: "America/New_York" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("blank name → 400 VALIDATION_FAILED", async () => {
    mockAuthenticated();
    mockGetSupabaseClient.mockReturnValue({ rpc: jest.fn() });

    const res = await PUT(fakeReq({ name: "   " }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("non-IANA timezone → 400 VALIDATION_FAILED", async () => {
    mockAuthenticated();
    mockGetSupabaseClient.mockReturnValue({ rpc: jest.fn() });

    const res = await PUT(fakeReq({ name: "Grace Church", timezone: "Not/AZone" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("malformed/empty JSON body → 400 VALIDATION_FAILED, does not throw", async () => {
    mockAuthenticated();
    mockGetSupabaseClient.mockReturnValue({ rpc: jest.fn() });

    const res = await PUT(fakeReq("__MALFORMED__"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("no Clerk session (clerkId null) → 401 UNAUTHENTICATED, body never parsed", async () => {
    mockAuth.mockResolvedValue({ userId: null, getToken: jest.fn() });
    const rpc = jest.fn();
    mockGetSupabaseClient.mockReturnValue({ rpc });

    const req = fakeReq(VALID_BODY);
    const jsonSpy = jest.spyOn(req, "json");

    const res = await PUT(req);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(jsonSpy).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("missing Supabase JWT template → 401 UNAUTHENTICATED", async () => {
    mockAuthenticated(null);
    const rpc = jest.fn();
    mockGetSupabaseClient.mockReturnValue({ rpc });

    const res = await PUT(fakeReq(VALID_BODY));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("RPC returns GR001 error → 409 CONFLICT", async () => {
    mockAuthenticated();
    const rpc = jest.fn().mockResolvedValue({ data: null, error: { code: "GR001" } });
    mockGetSupabaseClient.mockReturnValue({ rpc });

    const res = await PUT(fakeReq(VALID_BODY));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("CONFLICT");
  });

  it("RPC returns any other error → 500 INTERNAL", async () => {
    mockAuthenticated();
    const rpc = jest
      .fn()
      .mockResolvedValue({ data: null, error: { code: "23505", message: "boom" } });
    mockGetSupabaseClient.mockReturnValue({ rpc });

    const res = await PUT(fakeReq(VALID_BODY));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });

  it("derives name from username when first/last name absent", async () => {
    mockAuthenticated();
    mockCurrentUser.mockResolvedValue({
      firstName: null,
      lastName: null,
      username: "janedoe",
      primaryEmailAddress: null,
      emailAddresses: [],
    });
    const rpc = jest.fn().mockResolvedValue({ data: GROUP_ROW, error: null });
    mockGetSupabaseClient.mockReturnValue({ rpc });

    await PUT(fakeReq(VALID_BODY));
    expect(rpc).toHaveBeenCalledWith(
      "create_church_group",
      expect.objectContaining({ p_user_name: "janedoe", p_user_email: null }),
    );
  });

  it("falls back to 'Admin' when no name info is available at all", async () => {
    mockAuthenticated();
    mockCurrentUser.mockResolvedValue({
      firstName: null,
      lastName: null,
      username: null,
      primaryEmailAddress: null,
      emailAddresses: [],
    });
    const rpc = jest.fn().mockResolvedValue({ data: GROUP_ROW, error: null });
    mockGetSupabaseClient.mockReturnValue({ rpc });

    await PUT(fakeReq(VALID_BODY));
    expect(rpc).toHaveBeenCalledWith(
      "create_church_group",
      expect.objectContaining({ p_user_name: "Admin" }),
    );
  });
});

describe("GET /api/church-group", () => {
  it("returns 501 NOT_IMPLEMENTED stub", async () => {
    const res = await GET({} as NextRequest);
    expect(res.status).toBe(501);
    const body = await res.json();
    expect(body.code).toBe("NOT_IMPLEMENTED");
  });
});
