import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// Route matcher is defined now so it's ready to use, but NOT enforced yet —
// auth.protect() depends on real Clerk keys + role claims that land in
// Sprint 0 #5/#6. Wire it in then:
//
//   export default clerkMiddleware(async (auth, req) => {
//     if (!isPublicRoute(req)) await auth.protect();
//   });
export const isPublicRoute = createRouteMatcher([
  "/",
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/join(.*)",
  "/invite(.*)",
  "/api/health",
  "/api/webhooks(.*)",
]);

export default clerkMiddleware();

export const config = {
  matcher: ["/((?!_next|.*\\..*).*)", "/(api|trpc)(.*)"],
};
