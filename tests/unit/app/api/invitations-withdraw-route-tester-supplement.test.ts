// Supplementary tests written independently by the Tester stage for #43
// (DELETE /api/invitations/:id, withdraw invitation).
//
// The coder's own invitations-withdraw-route.test.ts covers the happy path
// and most edge cases well, but leaves a few gaps this file closes:
//   1. It only exercises the `member` role for the 403 gate; `guest` is
//      never tried, even though the spec calls out "member/guest" together.
//   2. It never exercises the invitations *update* query erroring (only the
//      initial select erroring is covered) — the handler has a separate
//      `updateError` branch that was otherwise untested.
//   3. It never exercises the update returning no row (`!updated`, e.g. a
//      concurrent modification/race) — the handler's second 404 branch.
//   4. It never asserts the invitation lookup is scoped by
//      `church_group_id` only and NOT `user_id` — this is the specific,
//      deliberate behavioral difference from `denyInvitation` (spec
//      Decision: "the leader is withdrawing someone else's invitation") and
//      a regression here (e.g. copy-pasting denyInvitation's `.eq("user_id",
//      ctx.userId)` filter) would silently break withdrawal for every
//      invitation not created by the actor while still returning green on
//      the existing suite, since its fixtures don't record `.eq(...)` args.

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({ getSupabaseClient: jest.fn() }));

import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { getSupabaseClient } from "@/lib/supabase/client";
import { withdrawInvitation } from "@/app/api/invitations/handler";
import type { AuthContext, UserLookup } from "@/lib/api/auth";
import type { UserRole } from "@/types/domain";

const mockAuth = auth as unknown as jest.Mock;
const mockGetSupabaseClient = getSupabaseClient as unknown as jest.Mock;

const JWT = "supabase-jwt";
const USER_ID = "admin-1";
const CHURCH_GROUP_ID = "group-1";
const SERVICE_WEEK_ID = "22222222-2222-4222-8222-222222222222";
const TARGET_USER_ID = "11111111-1111-4111-8111-111111111111";
const INVITATION_ID = "33333333-3333-4333-8333-333333333333";

const fakeReq = { json: jest.fn().mockResolvedValue(undefined) } as unknown as NextRequest;

function makeLookup(role: UserRole): UserLookup {
  const ctx: AuthContext = {
    userId: USER_ID,
    churchGroupId: CHURCH_GROUP_ID,
    role,
  };
  return async () => ctx;
}

function setUpAuth(jwt: string | null = JWT) {
  mockAuth.mockResolvedValue({
    userId: "clerk_test",
    getToken: jest.fn().mockResolvedValue(jwt),
  });
}

const pendingInvitationRow = {
  id: INVITATION_ID,
  church_group_id: CHURCH_GROUP_ID,
  service_week_id: SERVICE_WEEK_ID,
  user_id: TARGET_USER_ID,
  role_note: null,
  status: "pending",
  response_token: "a".repeat(64),
  responded_at: null,
  denial_reason: null,
  denial_count: 0,
  response_deadline: "2026-07-15T00:00:00Z",
  invited_by: USER_ID,
  created_at: "2026-07-12T00:00:00Z",
};

type QueryResult = { data: unknown; error: unknown };

// Chain that records every .eq(...) call it receives so tests can assert on
// the *arguments*, not just that a call happened.
function makeRecordingChain(result: QueryResult, onEq?: (args: unknown[]) => void) {
  const chain: Record<string, unknown> & PromiseLike<QueryResult> = {
    eq: jest.fn((...args: unknown[]) => {
      onEq?.(args);
      return chain;
    }),
    select: jest.fn(() => chain),
    maybeSingle: jest.fn(() => Promise.resolve(result)),
    then: (resolve: (value: QueryResult) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  } as unknown as Record<string, unknown> & PromiseLike<QueryResult>;
  return chain;
}

beforeEach(() => {
  mockAuth.mockReset();
  mockGetSupabaseClient.mockReset();
});

describe("withdrawInvitation — tester supplement", () => {
  it("returns 403 FORBIDDEN when caller role is guest", async () => {
    setUpAuth();

    const res = await withdrawInvitation(fakeReq, INVITATION_ID, makeLookup("guest"));
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.code).toBe("FORBIDDEN");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 500 INTERNAL when the invitations UPDATE query itself errors (not just the initial select)", async () => {
    setUpAuth();
    const client = {
      from: jest.fn((table: string) => {
        if (table === "invitations") {
          return {
            select: jest.fn(() => makeRecordingChain({ data: pendingInvitationRow, error: null })),
            update: jest.fn(() =>
              makeRecordingChain({ data: null, error: { message: "deadlock detected" } }),
            ),
          };
        }
        throw new Error(`Unexpected table: ${table}`);
      }),
    };
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await withdrawInvitation(fakeReq, INVITATION_ID, makeLookup("admin"));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });

  it("returns 404 NOT_FOUND when the update matches no row (e.g. concurrently modified)", async () => {
    setUpAuth();
    const client = {
      from: jest.fn((table: string) => {
        if (table === "invitations") {
          return {
            select: jest.fn(() => makeRecordingChain({ data: pendingInvitationRow, error: null })),
            update: jest.fn(() => makeRecordingChain({ data: null, error: null })),
          };
        }
        throw new Error(`Unexpected table: ${table}`);
      }),
    };
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await withdrawInvitation(fakeReq, INVITATION_ID, makeLookup("set_leader"));
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });

  it("scopes the invitation lookup by church_group_id only, never by user_id (a leader must be able to withdraw another member's invitation)", async () => {
    setUpAuth();
    const eqCalls: unknown[][] = [];
    const client = {
      from: jest.fn((table: string) => {
        if (table === "invitations") {
          return {
            select: jest.fn(() =>
              makeRecordingChain({ data: pendingInvitationRow, error: null }, (args) =>
                eqCalls.push(args),
              ),
            ),
            update: jest.fn(() => makeRecordingChain({ data: null, error: null })),
          };
        }
        throw new Error(`Unexpected table: ${table}`);
      }),
    };
    mockGetSupabaseClient.mockReturnValue(client);

    // ctx.userId (USER_ID, the leader/actor) deliberately does NOT match
    // pendingInvitationRow.user_id (TARGET_USER_ID, the invited member) —
    // if the handler ever filtered the lookup by ctx.userId, this row would
    // not be visible and the call would 404 instead of proceeding.
    await withdrawInvitation(fakeReq, INVITATION_ID, makeLookup("admin"));

    expect(eqCalls).toContainEqual(["id", INVITATION_ID]);
    expect(eqCalls).toContainEqual(["church_group_id", CHURCH_GROUP_ID]);
    expect(eqCalls).not.toContainEqual(["user_id", USER_ID]);
    expect(eqCalls).not.toContainEqual(["user_id", TARGET_USER_ID]);
  });
});
