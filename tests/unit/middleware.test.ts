import type { NextRequest, NextResponse } from "next/server";
import { RATE_LIMIT_POLICIES, resetRateLimitStore } from "@/lib/api/rate-limit";

jest.mock("@clerk/nextjs/server", () => ({
  clerkMiddleware: (handler: unknown) => handler,
  createRouteMatcher: () => () => true, // treat everything as public
}));

import middlewareImport from "../../middleware";

// `clerkMiddleware` is mocked as the identity function above, so the default
// export is actually the raw `(auth, req) => ...` handler, not Clerk's
// wrapped middleware. Recast it to that shape for this test file.
type AuthFn = (() => Promise<{ userId: string | null }>) & { protect: jest.Mock };
type MiddlewareHandler = (authFn: AuthFn, req: NextRequest) => Promise<NextResponse | undefined>;
const middleware = middlewareImport as unknown as MiddlewareHandler;

function makeReq(pathname: string, method = "GET", headers: Record<string, string> = {}): NextRequest {
  return {
    nextUrl: { pathname },
    method,
    headers: new Headers(headers),
  } as unknown as NextRequest;
}

function makeAuthFn(): AuthFn {
  return Object.assign(async () => ({ userId: null }), { protect: jest.fn() });
}

function makeSpyAuthFn(): AuthFn {
  return Object.assign(jest.fn(async () => ({ userId: null })), { protect: jest.fn() });
}

describe("middleware rate limiting", () => {
  beforeEach(() => {
    resetRateLimitStore();
  });

  it("does not 429 requests within the sms limit to POST /api/invitations/:id/deny", async () => {
    const authFn = makeAuthFn();
    const req = makeReq(
      "/api/invitations/11111111-1111-1111-1111-111111111111/deny",
      "POST",
      { "x-forwarded-for": "1.2.3.4" },
    );

    for (let i = 0; i < RATE_LIMIT_POLICIES.sms.limit; i++) {
      const res = await middleware(authFn, req);
      expect(res?.status).not.toBe(429);
    }
  });

  it("returns 429 with Retry-After and RATE_LIMITED on the first request past the sms limit", async () => {
    const authFn = makeAuthFn();
    const req = makeReq(
      "/api/invitations/11111111-1111-1111-1111-111111111111/deny",
      "POST",
      { "x-forwarded-for": "5.5.5.5" },
    );

    for (let i = 0; i < RATE_LIMIT_POLICIES.sms.limit; i++) {
      await middleware(authFn, req);
    }

    const res = await middleware(authFn, req);
    expect(res).toBeDefined();
    if (!res) throw new Error("expected a 429 response");
    expect(res.status).toBe(429);
    const retryAfter = res.headers.get("Retry-After");
    expect(retryAfter).not.toBeNull();
    expect(Number.isInteger(Number(retryAfter))).toBe(true);
    expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);
    const body = await res.json();
    expect(body.code).toBe("RATE_LIMITED");
  });

  it("never 429s GET /api/health no matter how many times it is called", async () => {
    const authFn = makeAuthFn();
    const req = makeReq("/api/health", "GET");

    for (let i = 0; i < RATE_LIMIT_POLICIES.sms.limit + 50; i++) {
      const res = await middleware(authFn, req);
      expect(res?.status).not.toBe(429);
    }
  });

  it("skips the session fetch entirely for a page navigation (resolveTier returns null)", async () => {
    const authFn = makeSpyAuthFn();
    const req = makeReq("/dashboard", "GET");

    await middleware(authFn, req);

    expect(authFn as unknown as jest.Mock).not.toHaveBeenCalled();
  });
});
