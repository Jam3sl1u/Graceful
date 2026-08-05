// Supplementary tests written independently by the Tester stage for #76
// (rate limiting in middleware.ts).
//
// The coder's own tests/unit/middleware.test.ts proves the 429 fires and
// that /api/health is exempt, but its mocked `authFn` always resolves
// `{ userId: null }` and never throws, and its mocked `createRouteMatcher`
// always returns `true` (everything "public"). That leaves two spec
// requirements from .pipeline/spec.md completely unexercised:
//   1. "await auth() throwing must not 500 the request — fall back to IP
//      bucketing" (edge case #6). A regression that let the throw escape
//      (e.g. removing the try/catch, or catching but rethrowing) would
//      still pass the coder's suite because it never calls an authFn that
//      throws.
//   2. Rate limiting must run *before* `auth.protect()`, and `auth.protect()`
//      must still run for allowed requests on protected (non-public) routes.
//      A regression that skipped `auth.protect()` entirely (e.g. an early
//      `return` on every path, or always treating routes as public) would
//      still pass the coder's suite because its `createRouteMatcher` mock
//      always reports "public" and never asserts `protect` was called.

jest.mock("@clerk/nextjs/server", () => ({
  clerkMiddleware: (handler: unknown) => handler,
  createRouteMatcher: () => () => false, // treat everything as protected (non-public)
}));

import type { NextRequest, NextResponse } from "next/server";
import { RATE_LIMIT_POLICIES, resetRateLimitStore } from "@/lib/api/rate-limit";
import middlewareImport from "../../middleware";

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

function makeThrowingAuthFn(): AuthFn {
  return Object.assign(
    async (): Promise<{ userId: string | null }> => {
      throw new Error("session decode failed");
    },
    { protect: jest.fn() },
  );
}

function makeAuthFn(userId: string | null = null): AuthFn {
  return Object.assign(async () => ({ userId }), { protect: jest.fn() });
}

describe("middleware rate limiting — tester supplement", () => {
  beforeEach(() => {
    resetRateLimitStore();
  });

  it("does not 500 when auth() throws, and falls back to IP-based rate limiting", async () => {
    const authFn = makeThrowingAuthFn();
    const req = makeReq("/api/invitations", "POST", { "x-forwarded-for": "7.7.7.7" });

    // Exhaust the sms limit for this IP; none of these calls should throw.
    for (let i = 0; i < RATE_LIMIT_POLICIES.sms.limit; i++) {
      await expect(middleware(authFn, req)).resolves.not.toThrow();
    }

    const res = await middleware(authFn, req);
    expect(res).toBeDefined();
    if (!res) throw new Error("expected a 429 response");
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.code).toBe("RATE_LIMITED");
  });

  it("falling back to IP bucketing on auth() throw does not let a signed-in-looking session bypass its own IP's budget from an unrelated user", async () => {
    // Two different callers behind two different IPs both hit auth() throwing;
    // each should get its own budget (IP-scoped), not share one bucket, and
    // neither should ever throw/500.
    const authFn = makeThrowingAuthFn();
    const reqA = makeReq("/api/invitations", "POST", { "x-forwarded-for": "8.8.8.8" });
    const reqB = makeReq("/api/invitations", "POST", { "x-forwarded-for": "9.9.9.9" });

    for (let i = 0; i < RATE_LIMIT_POLICIES.sms.limit; i++) {
      await middleware(authFn, reqA);
    }
    const aDenied = await middleware(authFn, reqA);
    expect(aDenied?.status).toBe(429);

    // reqB is a fresh IP/bucket and should still be allowed.
    const bAllowed = await middleware(authFn, reqB);
    expect(bAllowed?.status).not.toBe(429);
  });

  it("still calls auth.protect() for an allowed request on a non-public route", async () => {
    const authFn = makeAuthFn("clerk_user_1");
    const req = makeReq("/api/events", "GET");

    const res = await middleware(authFn, req);
    expect(res?.status).not.toBe(429);
    expect(authFn.protect).toHaveBeenCalledTimes(1);
  });

  it("does not call auth.protect() once the request is rate limited (denies before the auth gate)", async () => {
    const authFn = makeAuthFn("clerk_user_2");
    const req = makeReq("/api/invitations", "POST");

    for (let i = 0; i < RATE_LIMIT_POLICIES.sms.limit; i++) {
      await middleware(authFn, req);
    }
    const protectCallsBeforeDenial = authFn.protect.mock.calls.length;

    const denied = await middleware(authFn, req);
    expect(denied?.status).toBe(429);
    // The denied call itself must short-circuit before auth.protect() —
    // the call count must not grow from the denied request.
    expect(authFn.protect.mock.calls.length).toBe(protectCallsBeforeDenial);
  });
});
