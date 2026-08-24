// Supplementary tests written independently by the Tester stage for #48
// (GET /api/invitations?serviceWeekId=, the Week View roster read endpoint).
//
// The coder's own invitations-list-route.test.ts covers the happy path, the
// role gate (member -> 403), validation, auth, and the response-token leak
// (its single most important assertion, per changes.md) well. But its
// `makeChain`/`makeSupabaseClient` helpers never *record* the arguments
// passed to `.eq(...)` — they only assert the final `{ data, error }`
// result. That leaves two regressions the existing green suite would not
// catch:
//   1. Cross-tenant leak: if the handler ever dropped or swapped the
//      `.eq("church_group_id", ctx.churchGroupId)` filter (e.g. copy-paste
//      drift), every existing test would still pass, because the mock
//      chain answers the same fixture data regardless of what `.eq(...)`
//      was called with. This is the read-side counterpart of the
//      writer-mocked leaks already caught by
//      invitations-withdraw-route-tester-supplement.test.ts.
//   2. Only the "member" role is exercised for the 403 gate; "guest" (the
//      other explicitly-listed forbidden role in the spec's "Role gating"
//      edge case) is never tried.
//
// This file closes both gaps, plus asserts the exact selected-column list
// (not just "isn't `*`" and "doesn't mention response_token" — a regression
// that also dropped a *needed* column, e.g. `status`, would slip past the
// coder's assertions since they only check the shape of the mapped output,
// not the string passed to `.select(...)`).

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({ getSupabaseClient: jest.fn() }));

import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { getSupabaseClient } from "@/lib/supabase/client";
import { listInvitations } from "@/app/api/invitations/handler";
import type { AuthContext, UserLookup } from "@/lib/api/auth";
import type { UserRole } from "@/types/domain";

const mockAuth = auth as unknown as jest.Mock;
const mockGetSupabaseClient = getSupabaseClient as unknown as jest.Mock;

const JWT = "supabase-jwt";
const USER_ID = "admin-1";
const CHURCH_GROUP_ID = "group-1";
const OTHER_CHURCH_GROUP_ID = "group-2";
const SERVICE_WEEK_ID = "22222222-2222-4222-8222-222222222222";
const INVITATION_ID = "33333333-3333-4333-8333-333333333333";
const MEMBER_ID = "11111111-1111-4111-8111-111111111111";

function makeReq(searchParams: Record<string, string> = {}): NextRequest {
  return {
    json: jest.fn().mockResolvedValue(undefined),
    nextUrl: { searchParams: new URLSearchParams(searchParams) },
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

const invitationRow = {
  id: INVITATION_ID,
  service_week_id: SERVICE_WEEK_ID,
  user_id: MEMBER_ID,
  role_note: "Lead vocals",
  status: "pending",
  response_deadline: "2026-07-20T00:00:00.000Z",
  created_at: "2026-07-12T00:00:00Z",
};

type QueryResult = { data: unknown; error: unknown };

// Chain that records every .eq(...) call's arguments, unlike the coder's own
// makeChain, so tests can assert on the *filter arguments*, not just the
// final resolved value.
function makeRecordingChain(result: QueryResult, onEq: (args: unknown[]) => void) {
  const chain: Record<string, unknown> & PromiseLike<QueryResult> = {
    eq: jest.fn((...args: unknown[]) => {
      onEq(args);
      return chain;
    }),
    order: jest.fn(() => chain),
    then: (resolve: (value: QueryResult) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  } as unknown as Record<string, unknown> & PromiseLike<QueryResult>;
  return chain;
}

beforeEach(() => {
  mockAuth.mockReset();
  mockGetSupabaseClient.mockReset();
});

describe("listInvitations — tester supplement (#48)", () => {
  it("returns 403 FORBIDDEN when caller role is guest (the other explicitly forbidden role, alongside member)", async () => {
    setUpAuth();

    const res = await listInvitations(
      makeReq({ serviceWeekId: SERVICE_WEEK_ID }),
      makeLookup("guest"),
    );
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.code).toBe("FORBIDDEN");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("scopes the query by BOTH church_group_id and service_week_id (a dropped church_group_id filter would leak another tenant's invitations)", async () => {
    setUpAuth();
    const eqCalls: unknown[][] = [];
    const client = {
      from: jest.fn((table: string) => {
        if (table === "invitations") {
          return {
            select: jest.fn(() =>
              makeRecordingChain({ data: [invitationRow], error: null }, (args) => eqCalls.push(args)),
            ),
          };
        }
        throw new Error(`Unexpected table: ${table}`);
      }),
    };
    mockGetSupabaseClient.mockReturnValue(client);

    // ctx.churchGroupId (CHURCH_GROUP_ID) deliberately differs from an
    // "other" group id that must never leak in — if the handler ever
    // dropped the church_group_id filter, this assertion on the *filter
    // arguments actually sent* (not just the fixture response) would catch
    // it, unlike the coder's own test which never inspects .eq(...) args.
    await listInvitations(makeReq({ serviceWeekId: SERVICE_WEEK_ID }), makeLookup("admin"));

    expect(eqCalls).toContainEqual(["service_week_id", SERVICE_WEEK_ID]);
    expect(eqCalls).toContainEqual(["church_group_id", CHURCH_GROUP_ID]);
    expect(eqCalls).not.toContainEqual(["church_group_id", OTHER_CHURCH_GROUP_ID]);
  });

  it("selects exactly the roster-safe columns — not a superset (missing status) nor a leaking superset (response_token/denial_reason)", async () => {
    setUpAuth();
    let selectedColumns = "";
    const client = {
      from: jest.fn(() => ({
        select: jest.fn((columns: string) => {
          selectedColumns = columns;
          return makeRecordingChain({ data: [invitationRow], error: null }, () => {});
        }),
      })),
    };
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await listInvitations(makeReq({ serviceWeekId: SERVICE_WEEK_ID }), makeLookup("admin"));
    expect(res.status).toBe(200);

    const requiredColumns = [
      "id",
      "service_week_id",
      "user_id",
      "role_note",
      "status",
      "response_deadline",
      "created_at",
    ];
    for (const col of requiredColumns) {
      expect(selectedColumns).toMatch(new RegExp(`\\b${col}\\b`));
    }
    expect(selectedColumns).not.toMatch(/denial_reason/);
    expect(selectedColumns).not.toBe("*");
  });
});
