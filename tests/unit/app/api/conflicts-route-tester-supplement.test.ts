// Supplementary tests written independently by the Tester stage for #50
// (GET /api/conflicts's new `roleNote` field).
//
// The coder's own conflicts-route.test.ts covers the happy path (an
// invitation row WITH a role_note) and the "invitation row entirely
// missing" fallback (roleNote: null), but leaves a gap this file closes:
// it never exercises an invitation row that DOES exist but whose
// `role_note` column is itself `null` (e.g. a set_leader never filled it
// in) — a distinct code path from "no invitation row at all", since both
// go through the same `invitation?.role_note ?? null` expression but only
// one of them proves the `??` fallback (not just optional-chaining) is
// doing real work.
//
// It also never asserts the role gate on this newly-touched handler
// rejects `guest`, not just `member` — this matters here because the
// spec's own out-of-scope list singles out "any change to ... schema",
// so a regression that accidentally loosened `requireRole` while adding
// the new column would not be caught by the coder's single "member" case.

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({ getSupabaseClient: jest.fn() }));

import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { getSupabaseClient } from "@/lib/supabase/client";
import { getOpenConflicts, type OpenConflict } from "@/app/api/conflicts/handler";
import type { AuthContext, UserLookup } from "@/lib/api/auth";
import type { UserRole } from "@/types/domain";

const mockAuth = auth as unknown as jest.Mock;
const mockGetSupabaseClient = getSupabaseClient as unknown as jest.Mock;

const JWT = "supabase-jwt";
const USER_ID = "admin-1";
const CHURCH_GROUP_ID = "group-1";
const CONFLICT_ID = "44444444-4444-4444-4444-444444444444";
const INVITATION_ID = "33333333-3333-3333-3333-333333333333";
const SERVICE_WEEK_ID = "22222222-2222-2222-2222-222222222222";
const MEMBER_ID = "11111111-1111-1111-1111-111111111111";

function makeReq(): NextRequest {
  return { json: jest.fn().mockResolvedValue(undefined) } as unknown as NextRequest;
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

type QueryResult = { data: unknown; error: unknown };
type TableFixture = { selects?: QueryResult[] };

function makeChain(result: QueryResult) {
  const chain: Record<string, unknown> & PromiseLike<QueryResult> = {
    eq: jest.fn(() => chain),
    in: jest.fn(() => chain),
    is: jest.fn(() => chain),
    order: jest.fn(() => chain),
    select: jest.fn(() => chain),
    maybeSingle: jest.fn(() => Promise.resolve(result)),
    then: (resolve: (value: QueryResult) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  } as unknown as Record<string, unknown> & PromiseLike<QueryResult>;
  return chain;
}

function makeSupabaseClient(fixtures: Partial<Record<string, TableFixture>> = {}) {
  const selectCallIndex: Record<string, number> = {};
  return {
    from: jest.fn((table: string) => {
      const tableFixture = fixtures[table] ?? {};
      return {
        select: jest.fn(() => {
          const idx = selectCallIndex[table] ?? 0;
          selectCallIndex[table] = idx + 1;
          const selects = tableFixture.selects ?? [{ data: [], error: null }];
          const result = selects[Math.min(idx, selects.length - 1)] ?? { data: [], error: null };
          return makeChain(result);
        }),
      };
    }),
  };
}

const conflictRow = {
  id: CONFLICT_ID,
  church_group_id: CHURCH_GROUP_ID,
  invitation_id: INVITATION_ID,
  triggered_by: null,
  trigger_reason: "double-booked",
  replacement_suggestion_user_id: null,
  resolved_at: null,
  resolution_type: null,
  created_at: "2026-07-12T00:00:00Z",
};

const userRow = { id: MEMBER_ID, name: "Jane Doe" };
const weekRow = { id: SERVICE_WEEK_ID, service_date: "2026-07-19", title: "Sunday Service" };

beforeEach(() => {
  mockAuth.mockReset();
  mockGetSupabaseClient.mockReset();
});

describe("GET /api/conflicts — tester supplement (#50 roleNote)", () => {
  it("returns 403 FORBIDDEN when caller role is guest (not just member)", async () => {
    setUpAuth();

    const res = await getOpenConflicts(makeReq(), makeLookup("guest"));
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.code).toBe("FORBIDDEN");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("surfaces roleNote: null when the joined invitation row EXISTS but its role_note column is null " +
    "(distinct from the invitation row being entirely missing)", async () => {
    setUpAuth();
    const invitationRowWithNullRoleNote = {
      id: INVITATION_ID,
      user_id: MEMBER_ID,
      service_week_id: SERVICE_WEEK_ID,
      status: "accepted",
      role_note: null,
    };
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        conflicts: { selects: [{ data: [conflictRow], error: null }] },
        invitations: { selects: [{ data: [invitationRowWithNullRoleNote], error: null }] },
        users: { selects: [{ data: [userRow], error: null }] },
        service_weeks: { selects: [{ data: [weekRow], error: null }] },
      }),
    );

    const res = await getOpenConflicts(makeReq(), makeLookup("admin"));
    expect(res.status).toBe(200);

    const body = await res.json();
    const conflicts: OpenConflict[] = body.data.conflicts;
    expect(conflicts).toHaveLength(1);
    // The invitation row (and its user/week joins) are fully present here —
    // only role_note itself is null — so every other field should still be
    // populated normally, proving the null-coalesce is scoped to roleNote.
    expect(conflicts[0]).toEqual({
      id: CONFLICT_ID,
      invitationId: INVITATION_ID,
      memberId: MEMBER_ID,
      memberName: "Jane Doe",
      serviceWeekId: SERVICE_WEEK_ID,
      serviceDate: "2026-07-19",
      serviceWeekTitle: "Sunday Service",
      roleNote: null,
      invitationStatus: "accepted",
      triggerReason: "double-booked",
      createdAt: "2026-07-12T00:00:00Z",
    });
  });
});
