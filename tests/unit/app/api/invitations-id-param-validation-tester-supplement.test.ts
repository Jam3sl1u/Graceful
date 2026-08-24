// Tester-stage supplemental coverage for issue #77 Change 4:
// invitationIdParamSchema validation of the :id route param in
// denyInvitation (both the token and in-app branches) and
// withdrawInvitation (after the existing 401/403 auth checks).

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({
  getSupabaseClient: jest.fn(),
  getAnonSupabaseClient: jest.fn(),
}));

import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { getSupabaseClient, getAnonSupabaseClient } from "@/lib/supabase/client";
import { denyInvitation, withdrawInvitation } from "@/app/api/invitations/handler";
import type { AuthContext, UserLookup } from "@/lib/api/auth";
import type { UserRole } from "@/types/domain";

const mockAuth = auth as unknown as jest.Mock;
const mockGetSupabaseClient = getSupabaseClient as unknown as jest.Mock;
const mockGetAnonSupabaseClient = getAnonSupabaseClient as unknown as jest.Mock;

const JWT = "supabase-jwt";
const USER_ID = "user-1";
const CHURCH_GROUP_ID = "group-1";
const MALFORMED_ID = "not-a-uuid";

function makeReq(body?: unknown): NextRequest {
  return {
    json: jest.fn().mockResolvedValue(body),
  } as unknown as NextRequest;
}

function makeLookup(role: UserRole): UserLookup {
  const ctx: AuthContext = { userId: USER_ID, churchGroupId: CHURCH_GROUP_ID, role };
  return async () => ctx;
}

function setUpAuth(jwt: string | null = JWT) {
  mockAuth.mockResolvedValue({
    userId: "clerk_test",
    getToken: jest.fn().mockResolvedValue(jwt),
  });
}

beforeEach(() => {
  mockAuth.mockReset();
  mockGetSupabaseClient.mockReset();
  mockGetAnonSupabaseClient.mockReset();
});

describe("POST /api/invitations/:id/deny — malformed :id (issue #77)", () => {
  it("in-app branch: returns 400 VALIDATION_FAILED for a malformed id, before any Supabase call", async () => {
    setUpAuth();

    const res = await denyInvitation(makeReq({}), MALFORMED_ID, makeLookup("member"));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("token (no-session) branch: returns 400 VALIDATION_FAILED for a malformed id, before the RPC call", async () => {
    const rpc = jest.fn(() => Promise.resolve({ data: null, error: null }));
    mockGetAnonSupabaseClient.mockReturnValue({ rpc });

    const res = await denyInvitation(
      makeReq({ responseToken: "a".repeat(64) }),
      MALFORMED_ID,
      undefined,
    );
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("still accepts a well-formed uuid id (no behaviour change)", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue({
      from: jest.fn(() => ({
        select: jest.fn(() => ({
          eq: jest.fn(function (this: unknown) {
            return this;
          }),
          maybeSingle: jest.fn(() => Promise.resolve({ data: null, error: null })),
        })),
      })),
    });

    const wellFormedId = "33333333-3333-4333-8333-333333333333";
    const res = await denyInvitation(makeReq({}), wellFormedId, makeLookup("member"));
    // Passes validation and proceeds to the (mocked) DB lookup, which
    // resolves to "not found" here -- the important assertion is that this
    // is NOT the 400 VALIDATION_FAILED the malformed-id tests above get.
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/invitations/:id (withdraw) — malformed :id (issue #77)", () => {
  it("returns 400 VALIDATION_FAILED for a malformed id when caller is authorized", async () => {
    setUpAuth();

    const res = await withdrawInvitation(makeReq(), MALFORMED_ID, makeLookup("admin"));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("401 (unauthenticated) still takes precedence over 400 for a malformed id", async () => {
    // requireAuth's own 401 (no Clerk session) fires before id validation --
    // distinct from the later "no Supabase JWT" 401 check, which happens
    // after id validation and so would NOT take precedence over a 400.
    mockAuth.mockResolvedValue({ userId: null, getToken: jest.fn() });
    const lookup = jest.fn();

    const res = await withdrawInvitation(makeReq(), MALFORMED_ID, lookup as unknown as UserLookup);
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(lookup).not.toHaveBeenCalled();
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("403 (insufficient role) still takes precedence over 400 for a malformed id", async () => {
    setUpAuth();

    const res = await withdrawInvitation(makeReq(), MALFORMED_ID, makeLookup("member"));
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.code).toBe("FORBIDDEN");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });
});
