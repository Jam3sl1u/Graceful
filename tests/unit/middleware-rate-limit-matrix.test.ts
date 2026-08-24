// Full rate-limit tier sweep across representative routes (issue #80, AC-4).
// Sister file to tests/unit/middleware.test.ts (#76/#77), which predates this
// and covers only the sms tier via one deny route; this file sweeps auth,
// sms, invite, and write (see .pipeline/spec.md Assumption 1 for why those
// four tiers, not a job-submission tier Phase 1 does not have), plus the
// budget-isolation properties the store relies on.

import type { NextRequest, NextResponse } from "next/server";
import { RATE_LIMIT_POLICIES, resetRateLimitStore, type RateLimitTier } from "@/lib/api/rate-limit";

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

function makeAuthFn(userId: string | null = null): AuthFn {
  return Object.assign(async () => ({ userId }), { protect: jest.fn() });
}

beforeEach(() => {
  resetRateLimitStore();
});

// ---------------------------------------------------------------------------
// Per tier/route sweep
// ---------------------------------------------------------------------------

type RouteCase = { tier: RateLimitTier; label: string; path: string; method: string; ip: string };

const ROUTE_CASES_BASE: Omit<RouteCase, "ip">[] = [
  { tier: "auth", label: "POST /api/church-group/join", path: "/api/church-group/join", method: "POST" },
  {
    tier: "auth",
    label: "GET /api/invitations/respond/<token>",
    path: "/api/invitations/respond/some-token",
    method: "GET",
  },
  {
    tier: "auth",
    label: "POST /api/invitations/<uuid>/accept",
    path: "/api/invitations/11111111-1111-1111-1111-111111111111/accept",
    method: "POST",
  },
  {
    tier: "sms",
    label: "POST /api/invitations/<uuid>/deny",
    path: "/api/invitations/11111111-1111-1111-1111-111111111111/deny",
    method: "POST",
  },
  {
    tier: "sms",
    label: "POST /api/setlists/<uuid>/publish",
    path: "/api/setlists/11111111-1111-1111-1111-111111111111/publish",
    method: "POST",
  },
  {
    tier: "sms",
    label: "GET /api/cron/invitation-reminders",
    path: "/api/cron/invitation-reminders",
    method: "GET",
  },
  { tier: "invite", label: "POST /api/invitations", path: "/api/invitations", method: "POST" },
  { tier: "write", label: "PUT /api/profile", path: "/api/profile", method: "PUT" },
];

// Distinct x-forwarded-for per case so tests cannot cross-contaminate even if
// resetRateLimitStore ordering changes. Assigned up front (not via the
// describe.each callback's index param, which Jest's types reserve for a
// `done` callback, not an array index).
const ROUTE_CASES: RouteCase[] = ROUTE_CASES_BASE.map((c, i) => ({ ...c, ip: `10.0.0.${i + 1}` }));

describe.each(ROUTE_CASES)("$label ($tier tier)", ({ tier, path, method, ip }) => {
  it(`allows the first ${RATE_LIMIT_POLICIES[tier].limit} requests`, async () => {
    const authFn = makeAuthFn();
    const req = makeReq(path, method, { "x-forwarded-for": ip });

    for (let j = 0; j < RATE_LIMIT_POLICIES[tier].limit; j++) {
      const res = await middleware(authFn, req);
      expect(res?.status).not.toBe(429);
    }
  });

  it("429s the request past the limit with RATE_LIMITED and a valid Retry-After", async () => {
    const authFn = makeAuthFn();
    const req = makeReq(path, method, { "x-forwarded-for": ip });

    for (let j = 0; j < RATE_LIMIT_POLICIES[tier].limit; j++) {
      await middleware(authFn, req);
    }

    const res = await middleware(authFn, req);
    expect(res).toBeDefined();
    if (!res) throw new Error("expected a 429 response");
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.code).toBe("RATE_LIMITED");

    const retryAfter = res.headers.get("Retry-After");
    expect(retryAfter).not.toBeNull();
    const retryAfterNum = Number(retryAfter);
    expect(Number.isInteger(retryAfterNum)).toBe(true);
    expect(retryAfterNum).toBeGreaterThanOrEqual(1);
    expect(retryAfterNum).toBeLessThanOrEqual(RATE_LIMIT_POLICIES[tier].windowMs / 1000);
  });
});

// ---------------------------------------------------------------------------
// Isolation cases
// ---------------------------------------------------------------------------

describe("rate-limit budget isolation", () => {
  it("exhausting sms for one identifier leaves that identifier's auth budget intact", async () => {
    const authFn = makeAuthFn();
    const ip = "10.1.1.1";
    const smsReq = makeReq(
      "/api/invitations/11111111-1111-1111-1111-111111111111/deny",
      "POST",
      { "x-forwarded-for": ip },
    );
    const authReq = makeReq("/api/church-group/join", "POST", { "x-forwarded-for": ip });

    for (let i = 0; i <= RATE_LIMIT_POLICIES.sms.limit; i++) {
      await middleware(authFn, smsReq);
    }
    const smsRes = await middleware(authFn, smsReq);
    expect(smsRes?.status).toBe(429);

    const authRes = await middleware(authFn, authReq);
    expect(authRes?.status).not.toBe(429);
  });

  it("two different x-forwarded-for first hops get independent budgets", async () => {
    const authFn = makeAuthFn();
    const reqA = makeReq(
      "/api/invitations/11111111-1111-1111-1111-111111111111/deny",
      "POST",
      { "x-forwarded-for": "10.2.2.1" },
    );
    const reqB = makeReq(
      "/api/invitations/11111111-1111-1111-1111-111111111111/deny",
      "POST",
      { "x-forwarded-for": "10.2.2.2" },
    );

    for (let i = 0; i <= RATE_LIMIT_POLICIES.sms.limit; i++) {
      await middleware(authFn, reqA);
    }
    const resA = await middleware(authFn, reqA);
    expect(resA?.status).toBe(429);

    const resB = await middleware(authFn, reqB);
    expect(resB?.status).not.toBe(429);
  });

  it("a signed-in caller and an anonymous caller from the same IP get independent budgets", async () => {
    const ip = "10.3.3.3";
    const signedInAuthFn = makeAuthFn("clerk_user_1");
    const anonAuthFn = makeAuthFn(null);
    const req = makeReq(
      "/api/invitations/11111111-1111-1111-1111-111111111111/deny",
      "POST",
      { "x-forwarded-for": ip },
    );

    for (let i = 0; i <= RATE_LIMIT_POLICIES.sms.limit; i++) {
      await middleware(signedInAuthFn, req);
    }
    const signedInRes = await middleware(signedInAuthFn, req);
    expect(signedInRes?.status).toBe(429);

    const anonRes = await middleware(anonAuthFn, req);
    expect(anonRes?.status).not.toBe(429);
  });

  // Failure case required by the pipeline contract: exhausting a tier for
  // one identifier must NOT 429 a different identifier.
  it("exhausting a tier for one identifier does not 429 a different identifier's very next request", async () => {
    const authFn = makeAuthFn();
    const exhaustedReq = makeReq("/api/invitations", "POST", { "x-forwarded-for": "10.4.4.1" });
    const freshReq = makeReq("/api/invitations", "POST", { "x-forwarded-for": "10.4.4.2" });

    for (let i = 0; i <= RATE_LIMIT_POLICIES.invite.limit; i++) {
      await middleware(authFn, exhaustedReq);
    }
    const exhaustedRes = await middleware(authFn, exhaustedReq);
    expect(exhaustedRes?.status).toBe(429);

    const freshRes = await middleware(authFn, freshReq);
    expect(freshRes?.status).not.toBe(429);
  });
});
