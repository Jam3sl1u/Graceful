// Tests for POST /api/google-calendar/connect (#61).

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("next/headers", () => ({ cookies: jest.fn() }));

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { cookies } from "next/headers";
import { connect } from "@/app/api/google-calendar/connect/handler";
import type { AuthContext, UserLookup } from "@/lib/api/auth";

const mockAuth = auth as unknown as jest.Mock;
const mockCookies = cookies as unknown as jest.Mock;

const USER_ID = "user-1";
const CHURCH_GROUP_ID = "group-1";

function makeReq(): NextRequest {
  return {} as unknown as NextRequest;
}

function makeLookup(): UserLookup {
  const ctx: AuthContext = { userId: USER_ID, churchGroupId: CHURCH_GROUP_ID, role: "member" };
  return async () => ctx;
}

function setUpAuth(clerkUserId: string | null = "clerk_test") {
  mockAuth.mockResolvedValue({ userId: clerkUserId, getToken: jest.fn() });
}

describe("POST /api/google-calendar/connect", () => {
  const originalEnv = { ...process.env };
  let setCookie: jest.Mock;

  beforeEach(() => {
    mockAuth.mockReset();
    setCookie = jest.fn();
    mockCookies.mockResolvedValue({ set: setCookie });
    process.env.GOOGLE_CLIENT_ID = "client-id-123";
    process.env.GOOGLE_REDIRECT_URI = "https://app.example.com/api/google-calendar/callback";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns 401 UNAUTHENTICATED when Clerk userId is null (lookup never consulted)", async () => {
    setUpAuth(null);
    const lookup = jest.fn();

    const res = await connect(makeReq(), lookup as unknown as UserLookup);
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(lookup).not.toHaveBeenCalled();
    expect(setCookie).not.toHaveBeenCalled();
  });

  it("returns 200 with an authUrl and sets an httpOnly, sameSite=lax state cookie", async () => {
    setUpAuth();

    const res = await connect(makeReq(), makeLookup());
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(typeof body.data.authUrl).toBe("string");
    const authUrl = new URL(body.data.authUrl);
    expect(authUrl.origin + authUrl.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(authUrl.searchParams.get("scope")).toBe(
      "https://www.googleapis.com/auth/calendar.events",
    );

    expect(setCookie).toHaveBeenCalledTimes(1);
    const [name, value, options] = setCookie.mock.calls[0];
    expect(name).toBe("gcal_oauth_state");
    expect(typeof value).toBe("string");
    expect(value.length).toBeGreaterThan(0);
    expect(authUrl.searchParams.get("state")).toBe(value);
    expect(options).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 600,
    });
  });

  it("returns 500 INTERNAL when required Google env vars are missing", async () => {
    setUpAuth();
    delete process.env.GOOGLE_CLIENT_ID;

    const res = await connect(makeReq(), makeLookup());
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });
});
