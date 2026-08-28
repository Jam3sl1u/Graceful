// Tests for POST /api/invitations/guest/claim (#72). Mock scaffolding
// mirrors tests/unit/app/api/church-group-join-route.test.ts: this endpoint
// deliberately does not call requireAuth (the claimer has no `users` row
// yet), so auth() + currentUser() are mocked directly rather than via a
// UserLookup fake.

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn(), currentUser: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({ getSupabaseClient: jest.fn() }));

import { auth, currentUser } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { getSupabaseClient } from "@/lib/supabase/client";
import { claimGuestInvitation } from "@/app/api/invitations/handler";

const mockAuth = auth as unknown as jest.Mock;
const mockCurrentUser = currentUser as unknown as jest.Mock;
const mockGetSupabaseClient = getSupabaseClient as unknown as jest.Mock;

const CLERK_ID = "user_clerk123";
const JWT = "supabase-jwt";
const VALID_TOKEN = "a".repeat(64);

function makeReq(body?: unknown): NextRequest {
  return {
    json: jest.fn().mockResolvedValue(body),
  } as unknown as NextRequest;
}

function makeSupabaseRpc(result: { data: unknown; error: unknown }) {
  return { rpc: jest.fn().mockResolvedValue(result) };
}

const claimSuccessData = {
  user_id: "guest-user-1",
  church_group_id: "group-1",
  invitation_id: "invitation-1",
  service_week_id: "week-1",
  already_claimed: false,
};

beforeEach(() => {
  mockAuth.mockReset();
  mockCurrentUser.mockReset();
  mockGetSupabaseClient.mockReset();
});

describe("POST /api/invitations/guest/claim", () => {
  it("returns 401 UNAUTHENTICATED when there is no Clerk session", async () => {
    mockAuth.mockResolvedValue({ userId: null, getToken: jest.fn() });

    const res = await claimGuestInvitation(makeReq({ responseToken: VALID_TOKEN }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 401 UNAUTHENTICATED when getToken yields no JWT", async () => {
    mockAuth.mockResolvedValue({ userId: CLERK_ID, getToken: jest.fn().mockResolvedValue(null) });

    const res = await claimGuestInvitation(makeReq({ responseToken: VALID_TOKEN }));
    expect(res.status).toBe(401);
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 400 VALIDATION_FAILED for a malformed token", async () => {
    mockAuth.mockResolvedValue({ userId: CLERK_ID, getToken: jest.fn().mockResolvedValue(JWT) });

    const res = await claimGuestInvitation(makeReq({ responseToken: "not-a-token" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 400 VALIDATION_FAILED for a missing body", async () => {
    mockAuth.mockResolvedValue({ userId: CLERK_ID, getToken: jest.fn().mockResolvedValue(JWT) });

    const res = await claimGuestInvitation(makeReq(null));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it.each([
    ["NOT_FOUND", 404, "NOT_FOUND"],
    ["ALREADY_CLAIMED", 409, "CONFLICT"],
    ["NOT_CLAIMABLE", 409, "CONFLICT"],
    ["USER_ALREADY_IN_GROUP", 409, "CONFLICT"],
  ] as const)("maps RPC error %s to %i %s", async (rpcMessage, status, code) => {
    mockAuth.mockResolvedValue({ userId: CLERK_ID, getToken: jest.fn().mockResolvedValue(JWT) });
    mockCurrentUser.mockResolvedValue(null);
    const { rpc } = makeSupabaseRpc({ data: null, error: { message: rpcMessage } });
    mockGetSupabaseClient.mockReturnValue({ rpc });

    const res = await claimGuestInvitation(makeReq({ responseToken: VALID_TOKEN }));
    expect(res.status).toBe(status);
    const body = await res.json();
    expect(body.code).toBe(code);
  });

  it("returns 500 INTERNAL for an unmapped RPC error", async () => {
    mockAuth.mockResolvedValue({ userId: CLERK_ID, getToken: jest.fn().mockResolvedValue(JWT) });
    mockCurrentUser.mockResolvedValue(null);
    const { rpc } = makeSupabaseRpc({ data: null, error: { message: "connection refused" } });
    mockGetSupabaseClient.mockReturnValue({ rpc });

    const res = await claimGuestInvitation(makeReq({ responseToken: VALID_TOKEN }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });

  it("happy path: 201 with the RPC's claim result", async () => {
    mockAuth.mockResolvedValue({ userId: CLERK_ID, getToken: jest.fn().mockResolvedValue(JWT) });
    mockCurrentUser.mockResolvedValue({
      fullName: "Guest Person",
      firstName: "Guest",
      lastName: "Person",
      username: "guestperson",
      primaryEmailAddress: { emailAddress: "guest@example.com" },
    });
    const { rpc } = makeSupabaseRpc({ data: claimSuccessData, error: null });
    mockGetSupabaseClient.mockReturnValue({ rpc });

    const res = await claimGuestInvitation(makeReq({ responseToken: VALID_TOKEN }));
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.data).toEqual({
      guest: { userId: "guest-user-1", churchGroupId: "group-1" },
      invitationId: "invitation-1",
      serviceWeekId: "week-1",
      alreadyClaimed: false,
    });

    expect(rpc).toHaveBeenCalledWith("claim_guest_invitation", {
      p_response_token: VALID_TOKEN,
      p_name: "Guest Person",
    });
  });

  it("alreadyClaimed: true passes through unchanged", async () => {
    mockAuth.mockResolvedValue({ userId: CLERK_ID, getToken: jest.fn().mockResolvedValue(JWT) });
    mockCurrentUser.mockResolvedValue(null);
    const { rpc } = makeSupabaseRpc({
      data: { ...claimSuccessData, already_claimed: true },
      error: null,
    });
    mockGetSupabaseClient.mockReturnValue({ rpc });

    const res = await claimGuestInvitation(makeReq({ responseToken: VALID_TOKEN }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.alreadyClaimed).toBe(true);
  });

  it("derives p_name as null when no Clerk name is available", async () => {
    mockAuth.mockResolvedValue({ userId: CLERK_ID, getToken: jest.fn().mockResolvedValue(JWT) });
    mockCurrentUser.mockResolvedValue(null);
    const { rpc } = makeSupabaseRpc({ data: claimSuccessData, error: null });
    mockGetSupabaseClient.mockReturnValue({ rpc });

    await claimGuestInvitation(makeReq({ responseToken: VALID_TOKEN }));

    expect(rpc).toHaveBeenCalledWith(
      "claim_guest_invitation",
      expect.objectContaining({ p_name: null }),
    );
  });
});
