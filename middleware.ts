import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { checkRequestRateLimit, rateLimitResponse, resolveTier } from "@/lib/api/rate-limit";

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
]);

export default clerkMiddleware(async (auth, req) => {
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
});

export const config = {
  matcher: ["/((?!_next|.*\\..*).*)", "/(api|trpc)(.*)"],
};
