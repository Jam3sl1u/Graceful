import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { checkRequestRateLimit, rateLimitResponse, resolveTier } from "@/lib/api/rate-limit";
import {
  buildContentSecurityPolicy,
  clerkFrontendApiOrigin,
  generateNonce,
} from "@/lib/security/csp";

// Request-level auth is enforced here; role-level checks (requireRole) still
// land in #6.
export const isPublicRoute = createRouteMatcher([
  "/",
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/join(.*)",
  "/invite(.*)",
  "/guest(.*)",
  "/api/health",
  "/api/webhooks(.*)",
  "/api/invitations/(.*)/accept",
  "/api/invitations/(.*)/deny",
  "/api/invitations/respond/(.*)",
  // PWA install assets must be fetchable by the browser/OS with no session;
  // /apple-icon has no dot in its path so it isn't excluded by config.matcher.
  "/apple-icon(.*)",
  "/manifest.webmanifest",
]);

export default clerkMiddleware(async (auth, req) => {
  const nonce = generateNonce();
  const csp = buildContentSecurityPolicy({
    nonce,
    clerkOrigin: clerkFrontendApiOrigin(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY),
    isDev: process.env.NODE_ENV !== "production",
  });

  // Only resolve the session (needed for rate-limit keying) when the
  // request is actually subject to a rate-limit tier — otherwise every page
  // navigation pays a JWT verification it doesn't need.
  if (resolveTier(req.nextUrl.pathname, req.method) !== null) {
    let clerkUserId: string | null = null;
    try {
      clerkUserId = (await auth()).userId;
    } catch {
      clerkUserId = null; // malformed/expired session -> fall back to IP bucketing
    }

    const decision = checkRequestRateLimit(req, clerkUserId);
    if (decision && !decision.allowed) {
      return rateLimitResponse(decision);
    }
  }

  if (!isPublicRoute(req)) {
    await auth.protect();
  }

  // Stamping the CSP (with its nonce) onto the *request* headers before
  // calling NextResponse.next() is what lets Next.js read the nonce back out
  // and use it to sign its own streaming inline scripts — this is what makes
  // "no inline scripts" achievable without 'unsafe-inline' in script-src.
  //
  // Note: when auth.protect() above redirects an unauthenticated request, it
  // short-circuits this handler and that redirect response carries no CSP
  // header. That's fine — a redirect has an empty body, so there's nothing
  // for a CSP violation to apply to.
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("content-security-policy", csp);

  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set("content-security-policy", csp);
  return res;
});

export const config = {
  matcher: ["/((?!_next|.*\\..*).*)", "/(api|trpc)(.*)"],
};
