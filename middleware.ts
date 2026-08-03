import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// Request-level auth is enforced here; role-level checks (requireRole) still
// land in #6.
export const isPublicRoute = createRouteMatcher([
  "/",
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/join(.*)",
  "/invite(.*)",
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
  if (!isPublicRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: ["/((?!_next|.*\\..*).*)", "/(api|trpc)(.*)"],
};
