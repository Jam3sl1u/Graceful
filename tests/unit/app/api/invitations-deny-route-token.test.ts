// Tests for the no-session (responseToken) branch of POST
// /api/invitations/:id/deny added for #49. Mirrors the no-session cases in
// tests/unit/app/api/invitations-accept-route.test.ts. The existing
// authenticated (no-token) path is covered by
// tests/unit/app/api/invitations-deny-route.test.ts and is intentionally not
// duplicated here — this file only exercises the new token branch plus a
// spot-check that the body-parse-before-requireAuth reorder didn't break the
// session path's auth-failure behavior.

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({
  getSupabaseClient: jest.fn(),
  getAnonSupabaseClient: jest.fn(),
}));

import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { getSupabaseClient, getAnonSupabaseClient } from "@/lib/supabase/client";
import { denyInvitation } from "@/app/api/invitations/handler";
import type { UserLookup } from "@/lib/api/auth";

const mockAuth = auth as unknown as jest.Mock;
const mockGetSupabaseClient = getSupabaseClient as unknown as jest.Mock;
const mockGetAnonSupabaseClient = getAnonSupabaseClient as unknown as jest.Mock;

const INVITATION_ID = "33333333-3333-3333-3333-333333333333";
const TOKEN = "a".repeat(64);

function makeReq(body?: unknown): NextRequest {
  return {
    json: jest.fn().mockResolvedValue(body),
  } as unknown as NextRequest;
}

function makeRpcClient(result: { data: unknown; error: unknown }) {
  return { rpc: jest.fn(() => Promise.resolve(result)) };
}

beforeEach(() => {
  mockAuth.mockReset();
  mockGetSupabaseClient.mockReset();
  mockGetAnonSupabaseClient.mockReset();
});

describe("POST /api/invitations/:id/deny — no-session (responseToken) branch", () => {
  it("happy path: 200, status denied, uses getAnonSupabaseClient, never touches Clerk", async () => {
    const client = makeRpcClient({
      data: { status: "denied", already_responded: false },
      error: null,
    });
    mockGetAnonSupabaseClient.mockReturnValue(client);

    const res = await denyInvitation(
      makeReq({ responseToken: TOKEN, reason: "Can't make it" }),
      INVITATION_ID,
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data).toEqual({
      invitationId: INVITATION_ID,
      status: "denied",
      alreadyResponded: false,
    });

    expect(mockGetAnonSupabaseClient).toHaveBeenCalled();
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
    expect(mockAuth).not.toHaveBeenCalled();
    expect(client.rpc).toHaveBeenCalledWith("deny_invitation", {
      p_invitation_id: INVITATION_ID,
      p_response_token: TOKEN,
      p_reason: "Can't make it",
    });
  });

  it("omitted/empty reason is coerced to null (matches acceptInvitation's null coercion)", async () => {
    const client = makeRpcClient({
      data: { status: "denied", already_responded: false },
      error: null,
    });
    mockGetAnonSupabaseClient.mockReturnValue(client);

    await denyInvitation(makeReq({ responseToken: TOKEN }), INVITATION_ID);

    expect(client.rpc).toHaveBeenCalledWith("deny_invitation", {
      p_invitation_id: INVITATION_ID,
      p_response_token: TOKEN,
      p_reason: null,
    });
  });

  it("already responded: 200 with alreadyResponded true and current status", async () => {
    const client = makeRpcClient({
      data: { status: "accepted", already_responded: true },
      error: null,
    });
    mockGetAnonSupabaseClient.mockReturnValue(client);

    const res = await denyInvitation(makeReq({ responseToken: TOKEN }), INVITATION_ID);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data.alreadyResponded).toBe(true);
    expect(body.data.status).toBe("accepted");
  });

  it("returns 400 VALIDATION_FAILED for a malformed responseToken (wrong length)", async () => {
    const res = await denyInvitation(makeReq({ responseToken: "short" }), INVITATION_ID);
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(mockGetAnonSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 400 VALIDATION_FAILED for a malformed responseToken (non-hex)", async () => {
    const res = await denyInvitation(
      makeReq({ responseToken: "z".repeat(64) }),
      INVITATION_ID,
    );
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("returns 400 VALIDATION_FAILED when reason exceeds 200 chars, even with a valid token", async () => {
    const res = await denyInvitation(
      makeReq({ responseToken: TOKEN, reason: "a".repeat(201) }),
      INVITATION_ID,
    );
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(mockGetAnonSupabaseClient).not.toHaveBeenCalled();
  });

  it("maps RPC NOT_FOUND error message to 404", async () => {
    const client = makeRpcClient({ data: null, error: { message: "NOT_FOUND" } });
    mockGetAnonSupabaseClient.mockReturnValue(client);

    const res = await denyInvitation(makeReq({ responseToken: TOKEN }), INVITATION_ID);
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });

  it("maps RPC FORBIDDEN error message to 403 (mismatched token)", async () => {
    const client = makeRpcClient({ data: null, error: { message: "FORBIDDEN" } });
    mockGetAnonSupabaseClient.mockReturnValue(client);

    const res = await denyInvitation(makeReq({ responseToken: TOKEN }), INVITATION_ID);
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.code).toBe("FORBIDDEN");
  });

  it("maps RPC EXPIRED error message to 410", async () => {
    const client = makeRpcClient({ data: null, error: { message: "EXPIRED" } });
    mockGetAnonSupabaseClient.mockReturnValue(client);

    const res = await denyInvitation(makeReq({ responseToken: TOKEN }), INVITATION_ID);
    expect(res.status).toBe(410);

    const body = await res.json();
    expect(body.code).toBe("EXPIRED");
  });

  it("maps any other RPC error message to 500 INTERNAL", async () => {
    const client = makeRpcClient({ data: null, error: { message: "unexpected db error" } });
    mockGetAnonSupabaseClient.mockReturnValue(client);

    const res = await denyInvitation(makeReq({ responseToken: TOKEN }), INVITATION_ID);
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });

  it("does not fall through to the authenticated path when a responseToken is present", async () => {
    const client = makeRpcClient({
      data: { status: "denied", already_responded: false },
      error: null,
    });
    mockGetAnonSupabaseClient.mockReturnValue(client);
    const lookup = jest.fn();

    await denyInvitation(
      makeReq({ responseToken: TOKEN }),
      INVITATION_ID,
      lookup as unknown as UserLookup,
    );

    expect(lookup).not.toHaveBeenCalled();
    expect(mockAuth).not.toHaveBeenCalled();
  });

  it("session path (no responseToken) still requires auth and is unaffected by the reorder", async () => {
    mockAuth.mockResolvedValue({ userId: null, getToken: jest.fn() });
    const lookup = jest.fn();

    const res = await denyInvitation(makeReq({}), INVITATION_ID, lookup as unknown as UserLookup);
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(lookup).not.toHaveBeenCalled();
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
    expect(mockGetAnonSupabaseClient).not.toHaveBeenCalled();
  });
});
