// Tester-stage supplemental coverage for issue #77 Change 3: the new
// googleCalendarCallbackQuerySchema.safeParse gate in the callback handler.
// Independent of tests/unit/app/api/google-calendar-callback-route.test.ts
// (which the spec says must not be modified and must keep passing).

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("next/headers", () => ({ cookies: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({ getSupabaseClient: jest.fn() }));
jest.mock("@/lib/google-calendar/oauth", () => ({
  exchangeCode: jest.fn(),
}));
jest.mock("@/lib/google-calendar/sync", () => ({
  syncAllEventsForUser: jest.fn(),
}));

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { cookies } from "next/headers";
import { exchangeCode } from "@/lib/google-calendar/oauth";
import { callback } from "@/app/api/google-calendar/callback/handler";
import type { AuthContext, UserLookup } from "@/lib/api/auth";

const mockAuth = auth as unknown as jest.Mock;
const mockCookies = cookies as unknown as jest.Mock;
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

function setUpAuth() {
  mockAuth.mockResolvedValue({
    userId: "clerk_test",
    getToken: jest.fn().mockResolvedValue("supabase-jwt"),
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

beforeEach(() => {
  mockAuth.mockReset();
  mockExchangeCode.mockReset();
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
});

describe("GET /api/google-calendar/callback — query schema validation (issue #77)", () => {
  it("redirects to error (never JSON) when code exceeds 2048 chars, and never reaches exchangeCode", async () => {
    setUpAuth();
    const deleteCookie = setUpCookies(STATE);

    const res = await callback(
      makeReq({ code: "a".repeat(2049), state: STATE }),
      makeLookup(),
    );

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://app.example.com/profile?calendar=error");
    expect(mockExchangeCode).not.toHaveBeenCalled();
    expect(deleteCookie).toHaveBeenCalledWith("gcal_oauth_state");
    // Never returns JSON on any failure path -- a redirect Response has no
    // JSON content-type (unlike fail()'s JSON responses elsewhere in the
    // API), confirming this route's "always redirect, never JSON" contract.
    expect(res.headers.get("content-type")).toBeNull();
  });

  it("redirects to error when state exceeds 512 chars, and never reaches exchangeCode", async () => {
    setUpAuth();
    setUpCookies("a".repeat(513));

    const res = await callback(
      makeReq({ code: "abc", state: "a".repeat(513) }),
      makeLookup(),
    );

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://app.example.com/profile?calendar=error");
    expect(mockExchangeCode).not.toHaveBeenCalled();
  });

  it("redirects to error when error exceeds 200 chars", async () => {
    setUpAuth();
    setUpCookies(STATE);

    const res = await callback(makeReq({ error: "e".repeat(201) }), makeLookup());

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://app.example.com/profile?calendar=error");
    expect(mockExchangeCode).not.toHaveBeenCalled();
  });

  it("redirects to error when code is present but empty (min(1) violated)", async () => {
    setUpAuth();
    setUpCookies(STATE);

    const res = await callback(makeReq({ code: "", state: STATE }), makeLookup());

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://app.example.com/profile?calendar=error");
    expect(mockExchangeCode).not.toHaveBeenCalled();
  });

  it("still accepts code:'abc' unchanged (existing passing case)", async () => {
    setUpAuth();
    setUpCookies(STATE);
    mockExchangeCode.mockRejectedValue(new Error("stub - only checking we got past validation"));

    await callback(makeReq({ code: "abc", state: STATE }), makeLookup());
    expect(mockExchangeCode).toHaveBeenCalledWith("abc");
  });

  it("still accepts error:'access_denied' unchanged (existing passing case)", async () => {
    setUpAuth();
    setUpCookies(STATE);

    const res = await callback(makeReq({ error: "access_denied" }), makeLookup());
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://app.example.com/profile?calendar=error");
    expect(mockExchangeCode).not.toHaveBeenCalled();
  });

  it("accepts code at exactly the 2048-char boundary", async () => {
    setUpAuth();
    setUpCookies(STATE);
    mockExchangeCode.mockRejectedValue(new Error("stub - only checking we got past validation"));

    await callback(makeReq({ code: "a".repeat(2048), state: STATE }), makeLookup());
    expect(mockExchangeCode).toHaveBeenCalledWith("a".repeat(2048));
  });
});
