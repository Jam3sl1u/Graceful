// Tests for DELETE /api/google-calendar/disconnect (#61).

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({ getSupabaseClient: jest.fn() }));
jest.mock("@/lib/google-calendar/oauth", () => ({
  revokeToken: jest.fn(),
}));

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { getSupabaseClient } from "@/lib/supabase/client";
import { revokeToken } from "@/lib/google-calendar/oauth";
import { encryptToken } from "@/lib/google-calendar/token-crypto";
import { disconnect } from "@/app/api/google-calendar/disconnect/handler";
import type { AuthContext, UserLookup } from "@/lib/api/auth";

const mockAuth = auth as unknown as jest.Mock;
const mockGetSupabaseClient = getSupabaseClient as unknown as jest.Mock;
const mockRevokeToken = revokeToken as unknown as jest.Mock;

const USER_ID = "user-1";
const CHURCH_GROUP_ID = "group-1";

function makeReq(): NextRequest {
  return {} as unknown as NextRequest;
}

function makeLookup(): UserLookup {
  const ctx: AuthContext = { userId: USER_ID, churchGroupId: CHURCH_GROUP_ID, role: "member" };
  return async () => ctx;
}

function setUpAuth(clerkUserId: string | null = "clerk_test", jwt: string | null = "supabase-jwt") {
  mockAuth.mockResolvedValue({
    userId: clerkUserId,
    getToken: jest.fn().mockResolvedValue(jwt),
  });
}

type QueryResult = { data: unknown; error: unknown };

function makeSupabaseClient(selectResult: QueryResult, deleteError: unknown = null) {
  const deleteEq = jest.fn(() => Promise.resolve({ error: deleteError }));
  return {
    from: jest.fn(() => ({
      select: jest.fn(() => ({
        eq: jest.fn(() => ({
          maybeSingle: jest.fn(() => Promise.resolve(selectResult)),
        })),
      })),
      delete: jest.fn(() => ({ eq: deleteEq })),
    })),
    _deleteEq: deleteEq,
  };
}

describe("DELETE /api/google-calendar/disconnect", () => {
  beforeEach(() => {
    mockAuth.mockReset();
    mockGetSupabaseClient.mockReset();
    mockRevokeToken.mockReset();
    mockRevokeToken.mockResolvedValue(undefined);
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
  });

  it("returns 401 UNAUTHENTICATED when Clerk userId is null", async () => {
    setUpAuth(null);
    const lookup = jest.fn();

    const res = await disconnect(makeReq(), lookup as unknown as UserLookup);
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("returns 401 UNAUTHENTICATED when getToken yields no JWT", async () => {
    setUpAuth("clerk_test", null);

    const res = await disconnect(makeReq(), makeLookup());
    expect(res.status).toBe(401);
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("revokes and deletes the row, returning success, when a row exists", async () => {
    setUpAuth();
    const refreshTokenEncrypted = encryptToken("refresh-token-value");
    const client = makeSupabaseClient({
      data: {
        refresh_token_encrypted: refreshTokenEncrypted,
        access_token_encrypted: encryptToken("access-token-value"),
      },
      error: null,
    });
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await disconnect(makeReq(), makeLookup());
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data).toEqual({ disconnected: true });

    expect(mockRevokeToken).toHaveBeenCalledWith("refresh-token-value");
    expect(client._deleteEq).toHaveBeenCalledWith("user_id", USER_ID);
  });

  it("is idempotent: returns success without calling revoke/delete when no row exists", async () => {
    setUpAuth();
    const client = makeSupabaseClient({ data: null, error: null });
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await disconnect(makeReq(), makeLookup());
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data).toEqual({ disconnected: true });
    expect(mockRevokeToken).not.toHaveBeenCalled();
    expect(client._deleteEq).not.toHaveBeenCalled();
  });

  it("still succeeds and deletes the row when the Google revoke fails", async () => {
    setUpAuth();
    mockRevokeToken.mockResolvedValue(undefined); // revokeToken never throws by contract
    const client = makeSupabaseClient({
      data: {
        refresh_token_encrypted: encryptToken("refresh-token-value"),
        access_token_encrypted: encryptToken("access-token-value"),
      },
      error: null,
    });
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await disconnect(makeReq(), makeLookup());
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data).toEqual({ disconnected: true });
    expect(client._deleteEq).toHaveBeenCalledWith("user_id", USER_ID);
  });

  it("returns 500 INTERNAL when the select query returns an error", async () => {
    setUpAuth();
    const client = makeSupabaseClient({ data: null, error: { message: "connection refused" } });
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await disconnect(makeReq(), makeLookup());
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });

  it("returns 500 INTERNAL when the delete returns an error", async () => {
    setUpAuth();
    const client = makeSupabaseClient(
      {
        data: {
          refresh_token_encrypted: encryptToken("refresh-token-value"),
          access_token_encrypted: encryptToken("access-token-value"),
        },
        error: null,
      },
      { message: "constraint violation" },
    );
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await disconnect(makeReq(), makeLookup());
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });
});
