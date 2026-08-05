// Supplementary tests written independently by the Tester stage for #76
// (lib/api/rate-limit.ts).
//
// The coder's own rate-limit.test.ts is thorough, but it (a) only tests
// tier isolation and identity isolation via hand-built keys
// (e.g. "sms:user:1"), never through the real `checkRequestRateLimit`
// entry point that actually constructs `${tier}:${identifier}` keys, and
// (b) only tests the "header absent entirely" branch of the ip:unknown
// fallback, not the "header present but blank" branch the spec calls out
// explicitly (edge case #4: "Missing/blank x-forwarded-for and x-real-ip").
// A regression that constructed the key without the tier prefix (e.g. just
// `identifier` instead of `${tier}:${identifier}`) would still pass the
// coder's suite because it never calls checkRequestRateLimit twice with two
// different tiers for literally the same request object.

import {
  checkRequestRateLimit,
  getRequestIdentifier,
  resetRateLimitStore,
  RATE_LIMIT_POLICIES,
} from "@/lib/api/rate-limit";
import type { NextRequest } from "next/server";

function makeReq(pathname: string, method = "GET", headers: Record<string, string> = {}): NextRequest {
  return {
    nextUrl: { pathname },
    method,
    headers: new Headers(headers),
  } as unknown as NextRequest;
}

describe("lib/api/rate-limit — tester supplement", () => {
  beforeEach(() => {
    resetRateLimitStore();
  });

  it("keys checkRequestRateLimit by tier, so exhausting write for a user does not affect that same user's read budget", () => {
    const now = 2_000_000;
    const writeReq = makeReq("/api/profile", "PATCH");
    const readReq = makeReq("/api/events", "GET");

    for (let i = 0; i < RATE_LIMIT_POLICIES.write.limit; i++) {
      const d = checkRequestRateLimit(writeReq, "clerk_shared_user", now);
      expect(d?.allowed).toBe(true);
    }
    const writeDenied = checkRequestRateLimit(writeReq, "clerk_shared_user", now);
    expect(writeDenied?.allowed).toBe(false);

    // Same user, different tier (read) — must still be allowed since the
    // key is `${tier}:${identifier}`, not just `${identifier}`.
    const readAllowed = checkRequestRateLimit(readReq, "clerk_shared_user", now);
    expect(readAllowed?.allowed).toBe(true);
  });

  it("treats a blank (present-but-empty) x-forwarded-for the same as an absent one", () => {
    const req = makeReq("/api/events", "GET", { "x-forwarded-for": "" });
    expect(getRequestIdentifier(req, null)).toBe("ip:unknown");
  });

  it("treats a blank (present-but-empty) x-real-ip the same as an absent one, once x-forwarded-for is also blank", () => {
    const req = makeReq("/api/events", "GET", { "x-forwarded-for": "", "x-real-ip": "" });
    expect(getRequestIdentifier(req, null)).toBe("ip:unknown");
  });

  it("ignores the query string entirely — only nextUrl.pathname drives classification", () => {
    // checkRequestRateLimit only ever reads req.nextUrl.pathname (never
    // req.nextUrl.search / req.url), so a query string on the same pathname
    // must land in the exact same bucket, not a separate one.
    const now = 3_000_000;
    const req1 = makeReq("/api/events", "GET");
    const req2 = { ...req1 } as NextRequest; // same pathname, "different" request object

    const d1 = checkRequestRateLimit(req1, "clerk_qs_user", now);
    const d2 = checkRequestRateLimit(req2, "clerk_qs_user", now);
    expect(d1?.remaining).toBe(RATE_LIMIT_POLICIES.read.limit - 1);
    expect(d2?.remaining).toBe(RATE_LIMIT_POLICIES.read.limit - 2);
  });

  it("clamps to an empty-string clerkUserId falling back to IP bucketing (not `user:`)", () => {
    // getRequestIdentifier's contract is "non-empty string" -> user:<id>.
    // An empty string is falsy content-wise and must not produce "user:".
    const req = makeReq("/api/events", "GET", { "x-forwarded-for": "4.4.4.4" });
    expect(getRequestIdentifier(req, "")).toBe("ip:4.4.4.4");
  });
});
