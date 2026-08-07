import type { NextRequest } from "next/server";
import {
  RATE_LIMIT_POLICIES,
  resolveTier,
  getRequestIdentifier,
  checkRateLimit,
  resetRateLimitStore,
  checkRequestRateLimit,
  rateLimitResponse,
} from "@/lib/api/rate-limit";

function makeReq(pathname: string, method = "GET", headers: Record<string, string> = {}): NextRequest {
  return {
    nextUrl: { pathname },
    method,
    headers: new Headers(headers),
  } as unknown as NextRequest;
}

describe("lib/api/rate-limit", () => {
  beforeEach(() => {
    resetRateLimitStore();
  });

  describe("checkRateLimit", () => {
    it("allows requests 1..N of an N-limit policy, counting remaining down to 0", () => {
      const policy = { limit: 3, windowMs: 60_000 };
      const now = 1_000_000;

      const r1 = checkRateLimit("k", policy, now);
      expect(r1.allowed).toBe(true);
      expect(r1.remaining).toBe(2);

      const r2 = checkRateLimit("k", policy, now);
      expect(r2.allowed).toBe(true);
      expect(r2.remaining).toBe(1);

      const r3 = checkRateLimit("k", policy, now);
      expect(r3.allowed).toBe(true);
      expect(r3.remaining).toBe(0);
    });

    it("denies request N+1 with remaining 0 and retryAfterSeconds >= 1", () => {
      const policy = { limit: 2, windowMs: 60_000 };
      const now = 1_000_000;

      checkRateLimit("k", policy, now);
      checkRateLimit("k", policy, now);
      const denied = checkRateLimit("k", policy, now);

      expect(denied.allowed).toBe(false);
      expect(denied.remaining).toBe(0);
      expect(denied.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    });

    it("allows the caller again at window rollover and resets remaining", () => {
      const policy = { limit: 2, windowMs: 60_000 };
      const windowStart = 1_000_000;

      checkRateLimit("k", policy, windowStart);
      checkRateLimit("k", policy, windowStart);
      const denied = checkRateLimit("k", policy, windowStart + 30_000);
      expect(denied.allowed).toBe(false);

      const rolledOver = checkRateLimit("k", policy, windowStart + policy.windowMs);
      expect(rolledOver.allowed).toBe(true);
      expect(rolledOver.remaining).toBe(policy.limit - 1);
    });

    it("does not extend the window on denied requests", () => {
      const policy = { limit: 1, windowMs: 60_000 };
      const windowStart = 1_000_000;

      const first = checkRateLimit("k", policy, windowStart);
      expect(first.allowed).toBe(true);
      const originalResetAtMs = first.resetAtMs;

      // Hammer past the limit.
      const denied1 = checkRateLimit("k", policy, windowStart + 10_000);
      const denied2 = checkRateLimit("k", policy, windowStart + 20_000);
      expect(denied1.allowed).toBe(false);
      expect(denied2.allowed).toBe(false);
      expect(denied1.resetAtMs).toBe(originalResetAtMs);
      expect(denied2.resetAtMs).toBe(originalResetAtMs);

      // Allowed again exactly at the original resetAtMs.
      const rolledOver = checkRateLimit("k", policy, originalResetAtMs);
      expect(rolledOver.allowed).toBe(true);
    });

    it("keeps sms and read buckets independent for the same identity", () => {
      const now = 1_000_000;
      const smsPolicy = RATE_LIMIT_POLICIES.sms;
      const readPolicy = RATE_LIMIT_POLICIES.read;

      for (let i = 0; i < smsPolicy.limit; i++) {
        checkRateLimit("sms:user:1", smsPolicy, now);
      }
      const smsDenied = checkRateLimit("sms:user:1", smsPolicy, now);
      expect(smsDenied.allowed).toBe(false);

      const readAllowed = checkRateLimit("read:user:1", readPolicy, now);
      expect(readAllowed.allowed).toBe(true);
    });

    it("does not share buckets between two different identities", () => {
      const policy = { limit: 1, windowMs: 60_000 };
      const now = 1_000_000;

      const a1 = checkRateLimit("write:user:a", policy, now);
      expect(a1.allowed).toBe(true);
      const b1 = checkRateLimit("write:user:b", policy, now);
      expect(b1.allowed).toBe(true);
    });
  });

  describe("rateLimitResponse", () => {
    it("builds a 429 with Retry-After header and RATE_LIMITED envelope", async () => {
      const decision = {
        tier: "sms" as const,
        allowed: false,
        limit: 5,
        remaining: 0,
        retryAfterSeconds: 12,
        resetAtMs: 1_000_000,
      };

      const res = rateLimitResponse(decision);
      expect(res.status).toBe(429);

      const retryAfter = res.headers.get("Retry-After");
      expect(retryAfter).not.toBeNull();
      const parsed = Number(retryAfter);
      expect(Number.isInteger(parsed)).toBe(true);
      expect(parsed).toBeGreaterThanOrEqual(1);

      const body = await res.json();
      expect(body).toEqual({ error: expect.any(String), code: "RATE_LIMITED" });
    });
  });

  describe("resolveTier", () => {
    it.each([
      ["/api/invitations", "POST", "invite"],
      ["/api/invitations", "GET", "read"],
      ["/api/invitations/11111111-1111-1111-1111-111111111111/deny", "POST", "sms"],
      ["/api/invitations/11111111-1111-1111-1111-111111111111/accept", "POST", "auth"],
      ["/api/invitations/respond/some-token-value", "GET", "auth"],
      ["/api/church-group/join", "POST", "auth"],
      ["/api/setlists/22222222-2222-2222-2222-222222222222/publish", "POST", "sms"],
      ["/api/cron/invitation-reminders", "GET", "sms"],
      ["/api/webhooks/clerk", "POST", "webhook"],
      ["/api/profile", "PATCH", "write"],
      ["/api/events/33333333-3333-3333-3333-333333333333", "DELETE", "write"],
      ["/api/events", "GET", "read"],
      ["/api/health", "GET", null],
      ["/dashboard", "GET", null],
      ["/api/health/", "GET", null],
      // Negative-precedence cases: verbs/paths that must NOT match the
      // higher-precedence tiers above them and fall through correctly.
      ["/api/events", "HEAD", "read"],
      ["/api/events", "OPTIONS", "read"],
      ["/api/invitations/11111111-1111-1111-1111-111111111111/deny", "GET", "read"],
      ["/api/setlists/22222222-2222-2222-2222-222222222222/publish", "GET", "read"],
      ["/api/setlists/22222222-2222-2222-2222-222222222222", "PUT", "write"],
      ["/api", "GET", "read"],
    ] as const)("%s %s -> %s", (path, method, expected) => {
      expect(resolveTier(path, method)).toBe(expected);
    });

    it("classifies a lowercase method the same as its uppercase equivalent", () => {
      expect(resolveTier("/api/invitations", "post")).toBe("invite");
    });
  });

  describe("getRequestIdentifier", () => {
    it("returns user:<id> for a signed-in user", () => {
      const req = makeReq("/api/events", "GET");
      expect(getRequestIdentifier(req, "clerk_123")).toBe("user:clerk_123");
    });

    it("uses the first hop of x-forwarded-for for anonymous callers", () => {
      const req = makeReq("/api/events", "GET", { "x-forwarded-for": "1.2.3.4, 5.6.7.8" });
      expect(getRequestIdentifier(req, null)).toBe("ip:1.2.3.4");
    });

    it("falls back to x-real-ip when x-forwarded-for is absent", () => {
      const req = makeReq("/api/events", "GET", { "x-real-ip": "9.9.9.9" });
      expect(getRequestIdentifier(req, null)).toBe("ip:9.9.9.9");
    });

    it("falls back to ip:unknown when neither header is present", () => {
      const req = makeReq("/api/events", "GET");
      expect(getRequestIdentifier(req, null)).toBe("ip:unknown");
    });
  });

  describe("checkRequestRateLimit", () => {
    it("returns null for exempt requests", () => {
      const req = makeReq("/api/health", "GET");
      expect(checkRequestRateLimit(req, null, 1_000_000)).toBeNull();
    });

    it("returns a decision with the resolved tier for non-exempt requests", () => {
      const req = makeReq("/api/events", "GET", { "x-forwarded-for": "1.1.1.1" });
      const decision = checkRequestRateLimit(req, null, 1_000_000);
      expect(decision).not.toBeNull();
      expect(decision?.tier).toBe("read");
      expect(decision?.allowed).toBe(true);
    });
  });

  describe("policy ordering invariant", () => {
    it("sms.limit < invite.limit < auth.limit < write.limit < read.limit", () => {
      expect(RATE_LIMIT_POLICIES.sms.limit).toBeLessThan(RATE_LIMIT_POLICIES.invite.limit);
      expect(RATE_LIMIT_POLICIES.invite.limit).toBeLessThan(RATE_LIMIT_POLICIES.auth.limit);
      expect(RATE_LIMIT_POLICIES.auth.limit).toBeLessThan(RATE_LIMIT_POLICIES.write.limit);
      expect(RATE_LIMIT_POLICIES.write.limit).toBeLessThan(RATE_LIMIT_POLICIES.read.limit);
    });
  });
});
