// Tester supplement for #61 (Google Calendar OAuth connect/disconnect).
//
// Independently covers two things the coder's own changes.md flagged as
// under-tested / worth reinforcing:
//   1. disconnect's graceful degradation when decryptToken itself throws
//      (e.g. a corrupted refresh_token_encrypted value) — must still delete
//      the row and return success, and must never call revokeToken with
//      garbage input.
//   2. callback's behavior when TOKEN_ENCRYPTION_KEY is missing/invalid at
//      encrypt time — encryptToken throws, and the handler must redirect to
//      error rather than 500 or partially write a row (this route never
//      returns JSON, so the generic "500 INTERNAL" edge case doesn't apply
//      here the way it does for connect/disconnect).
//
// Also adds one more spec-named failure case not exercised elsewhere: the
// disconnect DELETE row-scoping must be per-user (verified via the eq call)
// and a corrupted stored value must never surface in an error path.

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("next/headers", () => ({ cookies: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({ getSupabaseClient: jest.fn() }));
jest.mock("@/lib/google-calendar/oauth", () => ({
  revokeToken: jest.fn(),
  exchangeCode: jest.fn(),
}));

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { cookies } from "next/headers";
import { getSupabaseClient } from "@/lib/supabase/client";
import { revokeToken, exchangeCode } from "@/lib/google-calendar/oauth";
import { disconnect } from "@/app/api/google-calendar/disconnect/handler";
import { callback } from "@/app/api/google-calendar/callback/handler";
import type { AuthContext, UserLookup } from "@/lib/api/auth";

const mockAuth = auth as unknown as jest.Mock;
const mockCookies = cookies as unknown as jest.Mock;
const mockGetSupabaseClient = getSupabaseClient as unknown as jest.Mock;
const mockRevokeToken = revokeToken as unknown as jest.Mock;
const mockExchangeCode = exchangeCode as unknown as jest.Mock;

const USER_ID = "user-1";
const CHURCH_GROUP_ID = "group-1";
const STATE = "csrf-state-value";
const BASE_URL = "https://app.example.com/api/google-calendar/callback";

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

function makeReq(searchParams: Record<string, string> = {}): NextRequest {
  const url = new URL(BASE_URL);
  for (const [key, value] of Object.entries(searchParams)) {
    url.searchParams.set(key, value);
  }
  return {
    url: url.toString(),
    nextUrl: { searchParams: url.searchParams },
  } as unknown as NextRequest;
}

function setUpCookies(cookieValue: string | undefined) {
  const deleteCookie = jest.fn();
  mockCookies.mockResolvedValue({
    get: jest.fn(() => (cookieValue === undefined ? undefined : { value: cookieValue })),
    delete: deleteCookie,
  });
  return deleteCookie;
}

describe("tester supplement: DELETE /api/google-calendar/disconnect — corrupted stored value", () => {
  beforeEach(() => {
    mockAuth.mockReset();
    mockGetSupabaseClient.mockReset();
    mockRevokeToken.mockReset();
    mockRevokeToken.mockResolvedValue(undefined);
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
  });

  it("still deletes the row and returns success when decryptToken throws on a corrupted refresh_token_encrypted value", async () => {
    setUpAuth();
    const deleteEq = jest.fn(() => Promise.resolve({ error: null }));
    const client = {
      from: jest.fn(() => ({
        select: jest.fn(() => ({
          eq: jest.fn(() => ({
            maybeSingle: jest.fn(() =>
              Promise.resolve({
                data: {
                  // Not valid "iv:authTag:ciphertext" ciphertext — decryptToken
                  // must throw when asked to decrypt this.
                  refresh_token_encrypted: "not-a-valid-ciphertext",
                  access_token_encrypted: "also-not-valid",
                },
                error: null,
              }),
            ),
          })),
        })),
        delete: jest.fn(() => ({ eq: deleteEq })),
      })),
    };
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await disconnect({} as unknown as NextRequest, makeLookup());
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data).toEqual({ disconnected: true });

    // decryptToken threw before revokeToken could be called with a bogus value.
    expect(mockRevokeToken).not.toHaveBeenCalled();
    // Deletion must still happen, scoped to this user.
    expect(deleteEq).toHaveBeenCalledWith("user_id", USER_ID);
  });
});

describe("tester supplement: GET /api/google-calendar/callback — encryption key failure", () => {
  beforeEach(() => {
    mockAuth.mockReset();
    mockGetSupabaseClient.mockReset();
    mockExchangeCode.mockReset();
  });

  it("redirects to error (not a 500 JSON response) when TOKEN_ENCRYPTION_KEY is missing at encrypt time, and never calls Supabase", async () => {
    delete process.env.TOKEN_ENCRYPTION_KEY;
    setUpAuth();
    setUpCookies(STATE);
    mockExchangeCode.mockResolvedValue({
      accessToken: "access-token-value",
      refreshToken: "refresh-token-value",
      expiryDate: "2026-08-01T00:00:00.000Z",
      scope: "https://www.googleapis.com/auth/calendar.events",
    });

    const res = await callback(makeReq({ code: "abc", state: STATE }), makeLookup());

    // Always a redirect, never JSON — even on an unexpected internal failure.
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://app.example.com/profile?calendar=error");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });
});
