// Verifies the #73 new surfaces are auth-gated by middleware.ts's real
// isPublicRoute matcher (unmocked — createRouteMatcher needs no auth call to
// build/evaluate): neither GET /api/invitations/:id nor the /invitations/:id
// page are in the public-route allowlist, so both stay behind
// auth.protect() by default (an unauthenticated request gets redirected /
// 401'd, never the invitation data). Contrast with the existing public,
// token-gated accept/deny/respond endpoints, which *are* public.

import { isPublicRoute } from "@/middleware";
import type { NextRequest } from "next/server";

const INVITATION_ID = "11111111-1111-4111-8111-111111111111";

function makeReq(pathname: string, method = "GET"): NextRequest {
  return { nextUrl: { pathname }, method } as unknown as NextRequest;
}

describe("#73 auth gating", () => {
  it("GET /api/invitations/:id is NOT a public route (protected by default)", () => {
    expect(isPublicRoute(makeReq(`/api/invitations/${INVITATION_ID}`))).toBe(false);
  });

  it("/invitations/:id (the in-app response page) is NOT a public route", () => {
    expect(isPublicRoute(makeReq(`/invitations/${INVITATION_ID}`))).toBe(false);
  });

  it("contrast: the public, token-gated accept/deny/respond endpoints ARE public", () => {
    expect(isPublicRoute(makeReq(`/api/invitations/${INVITATION_ID}/accept`, "POST"))).toBe(true);
    expect(isPublicRoute(makeReq(`/api/invitations/${INVITATION_ID}/deny`, "POST"))).toBe(true);
    expect(isPublicRoute(makeReq(`/api/invitations/respond/sometoken`))).toBe(true);
  });
});
