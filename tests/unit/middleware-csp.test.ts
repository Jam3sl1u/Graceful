// CSP-plumbing coverage for middleware.ts (issue #78). The repo's other two
// middleware.test.ts / middleware-tester-supplement.test.ts files (added by
// #76) already cover rate limiting; this file covers the independent CSP
// nonce concern that #78 added to the same handler, which neither of those
// exercises (their `createRouteMatcher` mocks never assert on the CSP
// header, and their `authFn`/routes are chosen for rate-limit scenarios).

import type { NextRequest, NextResponse } from "next/server";

jest.mock("@clerk/nextjs/server", () => ({
  clerkMiddleware: (handler: unknown) => handler,
  createRouteMatcher: (
    jest.requireActual("@clerk/nextjs/server") as typeof import("@clerk/nextjs/server")
  ).createRouteMatcher,
}));

import middlewareImport, { isPublicRoute } from "../../middleware";

type AuthFn = (() => Promise<{ userId: string | null }>) & { protect: jest.Mock };
type MiddlewareHandler = (authFn: AuthFn, req: NextRequest) => Promise<NextResponse | undefined>;
const middleware = middlewareImport as unknown as MiddlewareHandler;

function makeReq(pathname: string, method = "GET"): NextRequest {
  return {
    nextUrl: { pathname },
    method,
    headers: new Headers(),
  } as unknown as NextRequest;
}

function makeAuthFn(): AuthFn {
  return Object.assign(async () => ({ userId: null }), { protect: jest.fn() });
}

describe("middleware CSP", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    Object.defineProperty(process.env, "NODE_ENV", { value: originalNodeEnv, configurable: true });
  });

  it("stamps a CSP header on a public route without calling auth.protect()", async () => {
    expect(isPublicRoute(makeReq("/sign-in"))).toBe(true);

    const authFn = makeAuthFn();
    const res = await middleware(authFn, makeReq("/sign-in"));

    expect(authFn.protect).not.toHaveBeenCalled();
    const csp = res?.headers.get("content-security-policy");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toMatch(/script-src 'self' 'nonce-[^']+'/);
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("still stamps a CSP header on a protected route, and calls auth.protect() once", async () => {
    expect(isPublicRoute(makeReq("/dashboard"))).toBe(false);

    const authFn = makeAuthFn();
    const res = await middleware(authFn, makeReq("/dashboard"));

    expect(authFn.protect).toHaveBeenCalledTimes(1);
    expect(res?.headers.get("content-security-policy")).toMatch(/script-src 'self' 'nonce-[^']+'/);
  });

  it("stamps the same nonce onto the request headers passed to NextResponse.next() as ends up in the response header", async () => {
    const { NextResponse } = jest.requireActual("next/server") as typeof import("next/server");
    const nextSpy = jest.spyOn(NextResponse, "next");

    const authFn = makeAuthFn();
    const res = await middleware(authFn, makeReq("/sign-in"));

    const responseCsp = res?.headers.get("content-security-policy");
    const forwardedHeaders = nextSpy.mock.calls[0]?.[0]?.request?.headers as Headers | undefined;
    expect(forwardedHeaders?.get("content-security-policy")).toBe(responseCsp);

    nextSpy.mockRestore();
  });

  it("generates a different nonce for each request", async () => {
    const authFn = makeAuthFn();
    const resA = await middleware(authFn, makeReq("/sign-in"));
    const resB = await middleware(authFn, makeReq("/sign-in"));

    const cspA = resA?.headers.get("content-security-policy");
    const cspB = resB?.headers.get("content-security-policy");
    expect(cspA).not.toBe(cspB);
  });

  it("excludes 'unsafe-eval' and ws: and includes upgrade-insecure-requests in production", async () => {
    Object.defineProperty(process.env, "NODE_ENV", { value: "production", configurable: true });

    const authFn = makeAuthFn();
    const res = await middleware(authFn, makeReq("/sign-in"));
    const csp = res?.headers.get("content-security-policy") ?? "";

    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toContain("ws:");
    expect(csp).toContain("upgrade-insecure-requests");
  });
});
