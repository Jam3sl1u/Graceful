jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({
  getSupabaseClient: jest.fn(),
  getAnonSupabaseClient: jest.fn(),
}));

import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { getSupabaseClient, getAnonSupabaseClient } from "@/lib/supabase/client";
import { acceptInvitation } from "@/app/api/invitations/handler";
import type { AuthContext, UserLookup } from "@/lib/api/auth";

const mockAuth = auth as unknown as jest.Mock;
const mockGetSupabaseClient = getSupabaseClient as unknown as jest.Mock;
const mockGetAnonSupabaseClient = getAnonSupabaseClient as unknown as jest.Mock;

const JWT = "supabase-jwt";
const USER_ID = "user-1";
const CHURCH_GROUP_ID = "group-1";
const INVITATION_ID = "11111111-1111-1111-1111-111111111111";
const TOKEN = "a".repeat(64);

function makeReq(body?: unknown): NextRequest {
  return {
    json: jest.fn().mockResolvedValue(body),
  } as unknown as NextRequest;
}

function makeLookup(): UserLookup {
  const ctx: AuthContext = {
    userId: USER_ID,
    churchGroupId: CHURCH_GROUP_ID,
    role: "member",
  };
  return async () => ctx;
}

function setUpAuth(jwt: string | null = JWT) {
  mockAuth.mockResolvedValue({
    userId: "clerk_test",
    getToken: jest.fn().mockResolvedValue(jwt),
  });
}

function makeRpcClient(result: { data: unknown; error: unknown }) {
  return { rpc: jest.fn(() => Promise.resolve(result)) };
}

beforeEach(() => {
  mockAuth.mockReset();
  mockGetSupabaseClient.mockReset();
  mockGetAnonSupabaseClient.mockReset();
});

describe("POST /api/invitations/:id/accept", () => {
  it("happy path (token, no session): 200, status accepted, uses getAnonSupabaseClient", async () => {
    const client = makeRpcClient({
      data: { status: "accepted", already_responded: false, attendees_added: 2 },
      error: null,
    });
    mockGetAnonSupabaseClient.mockReturnValue(client);

    const res = await acceptInvitation(makeReq({ responseToken: TOKEN }), INVITATION_ID);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data).toEqual({
      invitationId: INVITATION_ID,
      status: "accepted",
      alreadyResponded: false,
      attendeesAdded: 2,
    });

    expect(mockGetAnonSupabaseClient).toHaveBeenCalled();
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
    expect(client.rpc).toHaveBeenCalledWith("accept_invitation", {
      p_invitation_id: INVITATION_ID,
      p_response_token: TOKEN,
    });
  });

  it("happy path (session, in-app member): 200, uses getSupabaseClient with p_response_token null", async () => {
    setUpAuth();
    const client = makeRpcClient({
      data: { status: "accepted", already_responded: false, attendees_added: 1 },
      error: null,
    });
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await acceptInvitation(makeReq({}), INVITATION_ID, makeLookup());
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data.status).toBe("accepted");
    expect(body.data.alreadyResponded).toBe(false);

    expect(mockGetSupabaseClient).toHaveBeenCalledWith(JWT);
    expect(mockGetAnonSupabaseClient).not.toHaveBeenCalled();
    expect(client.rpc).toHaveBeenCalledWith("accept_invitation", {
      p_invitation_id: INVITATION_ID,
      p_response_token: null,
    });
  });

  it("already responded: 200 with alreadyResponded true and current status", async () => {
    const client = makeRpcClient({
      data: { status: "denied", already_responded: true, attendees_added: 0 },
      error: null,
    });
    mockGetAnonSupabaseClient.mockReturnValue(client);

    const res = await acceptInvitation(makeReq({ responseToken: TOKEN }), INVITATION_ID);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data.alreadyResponded).toBe(true);
    expect(body.data.status).toBe("denied");
    expect(body.data.attendeesAdded).toBe(0);
  });

  it("returns 400 VALIDATION_FAILED for a non-uuid id", async () => {
    const res = await acceptInvitation(makeReq({}), "not-a-uuid", makeLookup());
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(mockGetAnonSupabaseClient).not.toHaveBeenCalled();
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 400 VALIDATION_FAILED for a malformed responseToken (wrong length)", async () => {
    const res = await acceptInvitation(makeReq({ responseToken: "short" }), INVITATION_ID);
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(mockGetAnonSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 400 VALIDATION_FAILED for a malformed responseToken (non-hex)", async () => {
    const res = await acceptInvitation(
      makeReq({ responseToken: "z".repeat(64) }),
      INVITATION_ID,
    );
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("returns 401 UNAUTHENTICATED when no token and no session", async () => {
    mockAuth.mockResolvedValue({ userId: null, getToken: jest.fn() });
    const lookup = jest.fn();

    const res = await acceptInvitation(makeReq({}), INVITATION_ID, lookup as unknown as UserLookup);
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(lookup).not.toHaveBeenCalled();
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 401 UNAUTHENTICATED when getToken yields no JWT", async () => {
    setUpAuth(null);

    const res = await acceptInvitation(makeReq({}), INVITATION_ID, makeLookup());
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("maps RPC NOT_FOUND error message to 404", async () => {
    const client = makeRpcClient({ data: null, error: { message: "NOT_FOUND" } });
    mockGetAnonSupabaseClient.mockReturnValue(client);

    const res = await acceptInvitation(makeReq({ responseToken: TOKEN }), INVITATION_ID);
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });

  it("maps RPC FORBIDDEN error message to 403 (mismatched token)", async () => {
    const client = makeRpcClient({ data: null, error: { message: "FORBIDDEN" } });
    mockGetAnonSupabaseClient.mockReturnValue(client);

    const res = await acceptInvitation(makeReq({ responseToken: TOKEN }), INVITATION_ID);
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.code).toBe("FORBIDDEN");
  });

  it("maps RPC FORBIDDEN error message to 403 (session, someone else's invitation)", async () => {
    setUpAuth();
    const client = makeRpcClient({ data: null, error: { message: "FORBIDDEN" } });
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await acceptInvitation(makeReq({}), INVITATION_ID, makeLookup());
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.code).toBe("FORBIDDEN");
  });

  it("maps RPC EXPIRED error message to 410", async () => {
    const client = makeRpcClient({ data: null, error: { message: "EXPIRED" } });
    mockGetAnonSupabaseClient.mockReturnValue(client);

    const res = await acceptInvitation(makeReq({ responseToken: TOKEN }), INVITATION_ID);
    expect(res.status).toBe(410);

    const body = await res.json();
    expect(body.code).toBe("EXPIRED");
  });

  it("maps any other RPC error message to 500 INTERNAL", async () => {
    const client = makeRpcClient({ data: null, error: { message: "unexpected db error" } });
    mockGetAnonSupabaseClient.mockReturnValue(client);

    const res = await acceptInvitation(makeReq({ responseToken: TOKEN }), INVITATION_ID);
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });

  it("does not attempt a conflicts insert / does not reference conflicts on accept (BR-05 deferred)", async () => {
    const client = makeRpcClient({
      data: { status: "accepted", already_responded: false, attendees_added: 0 },
      error: null,
    });
    mockGetAnonSupabaseClient.mockReturnValue(client);

    await acceptInvitation(makeReq({ responseToken: TOKEN }), INVITATION_ID);

    // The handler only ever calls the single accept_invitation RPC — no
    // separate conflicts-table write is attempted from the route layer.
    expect(client.rpc).toHaveBeenCalledTimes(1);
    expect(client.rpc).toHaveBeenCalledWith("accept_invitation", expect.anything());
  });
});
