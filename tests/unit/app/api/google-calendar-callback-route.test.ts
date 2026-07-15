// Tests for GET /api/google-calendar/callback (#61). Always redirects; never
// returns JSON.

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("next/headers", () => ({ cookies: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({ getSupabaseClient: jest.fn() }));
jest.mock("@/lib/google-calendar/oauth", () => ({
  exchangeCode: jest.fn(),
}));

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { cookies } from "next/headers";
import { getSupabaseClient } from "@/lib/supabase/client";
import { exchangeCode } from "@/lib/google-calendar/oauth";
import { callback } from "@/app/api/google-calendar/callback/handler";
import type { AuthContext, UserLookup } from "@/lib/api/auth";

const mockAuth = auth as unknown as jest.Mock;
const mockCookies = cookies as unknown as jest.Mock;
const mockGetSupabaseClient = getSupabaseClient as unknown as jest.Mock;
const mockExchangeCode = exchangeCode as unknown as jest.Mock;

const BASE_URL = "https://app.example.com/api/google-calendar/callback";
const USER_ID = "user-1";
const CHURCH_GROUP_ID = "group-1";
const STATE = "csrf-state-value";

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

function setUpCookies(cookieValue: string | undefined) {
  const deleteCookie = jest.fn();
  mockCookies.mockResolvedValue({
    get: jest.fn(() => (cookieValue === undefined ? undefined : { value: cookieValue })),
    delete: deleteCookie,
  });
  return deleteCookie;
}

function makeUpsertingSupabase(onUpsert: (payload: unknown, opts: unknown) => void, error: unknown = null) {
  return {
    from: jest.fn(() => ({
      upsert: jest.fn((payload: unknown, opts: unknown) => {
        onUpsert(payload, opts);
        return Promise.resolve({ error });
      }),
    })),
  };
}

describe("GET /api/google-calendar/callback", () => {
  beforeEach(() => {
    mockAuth.mockReset();
    mockGetSupabaseClient.mockReset();
    mockExchangeCode.mockReset();
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  });

  it("redirects to error when unauthenticated", async () => {
    setUpAuth(null);
    setUpCookies(STATE);
    const lookup = jest.fn();

    const res = await callback(makeReq({ code: "abc", state: STATE }), lookup as unknown as UserLookup);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://app.example.com/profile?calendar=error");
  });

  it("redirects to error when Google reports ?error= (user denied consent), storing nothing", async () => {
    setUpAuth();
    setUpCookies(STATE);

    const res = await callback(makeReq({ error: "access_denied" }), makeLookup());
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://app.example.com/profile?calendar=error");
    expect(mockExchangeCode).not.toHaveBeenCalled();
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("redirects to error when code or state is missing", async () => {
    setUpAuth();
    setUpCookies(STATE);

    const res = await callback(makeReq({ code: "abc" }), makeLookup());
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://app.example.com/profile?calendar=error");
  });

  it("redirects to error on state mismatch (CSRF), storing nothing", async () => {
    setUpAuth();
    setUpCookies("a-different-state");

    const res = await callback(makeReq({ code: "abc", state: STATE }), makeLookup());
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://app.example.com/profile?calendar=error");
    expect(mockExchangeCode).not.toHaveBeenCalled();
  });

  it("redirects to error when the state cookie is missing entirely", async () => {
    setUpAuth();
    setUpCookies(undefined);

    const res = await callback(makeReq({ code: "abc", state: STATE }), makeLookup());
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://app.example.com/profile?calendar=error");
  });

  it("redirects to error when exchangeCode throws (Google token exchange failure), storing nothing", async () => {
    setUpAuth();
    setUpCookies(STATE);
    mockExchangeCode.mockRejectedValue(new Error("token exchange failed"));

    const res = await callback(makeReq({ code: "abc", state: STATE }), makeLookup());
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://app.example.com/profile?calendar=error");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("redirects to connected and upserts encrypted tokens with scope=calendar.events and calendar_id=primary on success", async () => {
    setUpAuth();
    const deleteCookie = setUpCookies(STATE);
    mockExchangeCode.mockResolvedValue({
      accessToken: "access-token-value",
      refreshToken: "refresh-token-value",
      expiryDate: "2026-08-01T00:00:00.000Z",
      scope: "https://www.googleapis.com/auth/calendar.events",
    });

    let capturedPayload: Record<string, unknown> | undefined;
    let capturedOpts: unknown;
    mockGetSupabaseClient.mockReturnValue(
      makeUpsertingSupabase((payload, opts) => {
        capturedPayload = payload as Record<string, unknown>;
        capturedOpts = opts;
      }),
    );

    const res = await callback(makeReq({ code: "abc", state: STATE }), makeLookup());
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://app.example.com/profile?calendar=connected");
    expect(deleteCookie).toHaveBeenCalledWith("gcal_oauth_state");

    expect(capturedOpts).toEqual({ onConflict: "user_id" });
    expect(capturedPayload).toBeDefined();
    expect(capturedPayload!.user_id).toBe(USER_ID);
    expect(capturedPayload!.calendar_id).toBe("primary");
    expect(capturedPayload!.scope).toBe("https://www.googleapis.com/auth/calendar.events");
    expect(capturedPayload!.token_expiry).toBe("2026-08-01T00:00:00.000Z");
    // Tokens must be encrypted, never stored/logged in plaintext.
    expect(capturedPayload!.access_token_encrypted).not.toBe("access-token-value");
    expect(capturedPayload!.refresh_token_encrypted).not.toBe("refresh-token-value");
    expect(String(capturedPayload!.access_token_encrypted)).toContain(":");
  });

  it("redirects to error when the upsert returns a Supabase error", async () => {
    setUpAuth();
    setUpCookies(STATE);
    mockExchangeCode.mockResolvedValue({
      accessToken: "access-token-value",
      refreshToken: "refresh-token-value",
      expiryDate: "2026-08-01T00:00:00.000Z",
      scope: "https://www.googleapis.com/auth/calendar.events",
    });
    mockGetSupabaseClient.mockReturnValue(
      makeUpsertingSupabase(() => {}, { message: "constraint violation" }),
    );

    const res = await callback(makeReq({ code: "abc", state: STATE }), makeLookup());
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://app.example.com/profile?calendar=error");
  });
});
