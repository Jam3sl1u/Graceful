// Tester-stage supplemental coverage for #56 (publish / unlock setlist),
// independent of the Coder's own setlists-publish-route.test.ts. That suite
// only calls the handler functions (publishSetlist/unlockSetlist) directly
// with a hand-picked id, so it never exercises the actual route.ts POST
// exports or proves that the id threaded through is the *setlist* id (the
// spec explicitly warns :id is the setlist id, not the service_week id — a
// copy/paste bug swapping which id gets extracted from `params` would not be
// caught by only testing the handler in isolation). This file drives the
// real route.ts entry points end-to-end against a stateful fake Supabase
// client (no handler-level mocking) and also covers:
//  - the combined BR-01 edge case (zero songs AND zero confirmed members
//    together)
//  - requireAuth's "lookup resolves to null" 401 branch (Clerk user not yet
//    provisioned) — a different code path than "missing JWT", not exercised
//    by the Coder's suite

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({ getSupabaseClient: jest.fn() }));

import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { getSupabaseClient } from "@/lib/supabase/client";
import * as publishRoute from "@/app/api/setlists/[id]/publish/route";
import * as unlockRoute from "@/app/api/setlists/[id]/unlock/route";
import { publishSetlist, unlockSetlist } from "@/app/api/setlists/[id]/handler";
import type { AuthContext, UserLookup } from "@/lib/api/auth";

const mockAuth = auth as unknown as jest.Mock;
const mockGetSupabaseClient = getSupabaseClient as unknown as jest.Mock;

const JWT = "supabase-jwt";
const USER_ID = "user-1";
const CHURCH_GROUP_ID = "group-1";
const SETLIST_A_ID = "setlist-a";
const SETLIST_B_ID = "setlist-b";
const WEEK_A_ID = "week-a";
const WEEK_B_ID = "week-b";

function makeLookup(role: AuthContext["role"], churchGroupId = CHURCH_GROUP_ID): UserLookup {
  const ctx: AuthContext = { userId: USER_ID, churchGroupId, role };
  return async () => ctx;
}

function setUpAuth(clerkUserId: string | null = "clerk_test", jwt: string | null = JWT) {
  mockAuth.mockResolvedValue({
    userId: clerkUserId,
    getToken: jest.fn().mockResolvedValue(jwt),
  });
}

beforeEach(() => {
  mockAuth.mockReset();
  mockGetSupabaseClient.mockReset();
});

const fakeReq = {} as NextRequest;

// ---------------------------------------------------------------------------
// Stateful fake Supabase client (independent implementation from the
// Coder's own test file's fake).
// ---------------------------------------------------------------------------

type AnyRow = Record<string, unknown>;
type QueryResult = { data: unknown; error: unknown };

type SetlistsRow = {
  id: string;
  church_group_id: string;
  service_week_id: string;
  status: string;
  published_at: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

function applyFilters<T extends AnyRow>(rows: T[], filters: [string, unknown][]): T[] {
  return rows.filter((r) => filters.every(([f, v]) => r[f] === v));
}

function makeSelectChain<T extends AnyRow>(rows: T[]) {
  const filters: [string, unknown][] = [];
  const chain: Record<string, unknown> & PromiseLike<QueryResult> = {
    eq: jest.fn((f: string, v: unknown) => {
      filters.push([f, v]);
      return chain;
    }),
    maybeSingle: jest.fn(async () => {
      const matched = applyFilters(rows, filters);
      return { data: matched[0] ?? null, error: null };
    }),
    then: (resolve: (v: QueryResult) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve({ data: applyFilters(rows, filters), error: null }).then(resolve, reject),
  } as unknown as Record<string, unknown> & PromiseLike<QueryResult>;
  return chain;
}

function makeUpdateChain(rows: AnyRow[], patch: AnyRow) {
  const filters: [string, unknown][] = [];
  const chain: Record<string, unknown> & PromiseLike<QueryResult> = {
    eq: jest.fn((f: string, v: unknown) => {
      filters.push([f, v]);
      return chain;
    }),
    select: jest.fn(() => chain),
    maybeSingle: jest.fn(async () => {
      const matched = applyFilters(rows, filters);
      for (const row of matched) Object.assign(row, patch);
      return { data: matched[0] ?? null, error: null };
    }),
  } as unknown as Record<string, unknown> & PromiseLike<QueryResult>;
  return chain;
}

function makeState() {
  return {
    users: [
      {
        id: USER_ID,
        clerk_id: "clerk_test",
        church_group_id: CHURCH_GROUP_ID,
        role: "admin",
      },
    ] as AnyRow[],
    setlists: [
      {
        id: SETLIST_A_ID,
        church_group_id: CHURCH_GROUP_ID,
        service_week_id: WEEK_A_ID,
        status: "draft",
        published_at: null,
        notes: null,
        created_by: USER_ID,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
      {
        id: SETLIST_B_ID,
        church_group_id: CHURCH_GROUP_ID,
        service_week_id: WEEK_B_ID,
        status: "published",
        published_at: "2026-01-01T00:00:00.000Z",
        notes: null,
        created_by: USER_ID,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
    ] as SetlistsRow[],
    setlistSongs: [] as AnyRow[],
    invitations: [] as AnyRow[],
    notifications: [] as AnyRow[],
  };
}

function makeFakeSupabase(state: ReturnType<typeof makeState>) {
  return {
    from: jest.fn((table: string) => {
      if (table === "users") {
        return { select: jest.fn(() => makeSelectChain(state.users)) };
      }
      if (table === "setlists") {
        return {
          select: jest.fn(() => makeSelectChain(state.setlists)),
          update: jest.fn((patch: AnyRow) => makeUpdateChain(state.setlists, patch)),
        };
      }
      if (table === "setlist_songs") {
        return { select: jest.fn(() => makeSelectChain(state.setlistSongs)) };
      }
      if (table === "invitations") {
        return { select: jest.fn(() => makeSelectChain(state.invitations)) };
      }
      if (table === "notifications") {
        return {
          insert: jest.fn((payload: AnyRow) => {
            const inserted = Array.isArray(payload) ? payload : [payload];
            state.notifications.push(...(inserted as AnyRow[]));
            return Promise.resolve({ data: null, error: null });
          }),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    }),
  };
}

// ---------------------------------------------------------------------------
// route.ts wiring — the real POST exports, driven end-to-end against the
// fake, proving the setlist targeted is the one identified by `params.id`
// (and not, say, the service_week id, or the wrong row of two candidates).
// ---------------------------------------------------------------------------

describe("route wiring — publish/route.ts and unlock/route.ts (end-to-end, no handler mocking)", () => {
  it("POST /api/setlists/:id/publish publishes exactly the setlist named by params.id, leaving other rows untouched", async () => {
    setUpAuth();
    const state = makeState();
    mockGetSupabaseClient.mockReturnValue(makeFakeSupabase(state));

    const res = await publishRoute.POST(fakeReq, {
      params: Promise.resolve({ id: SETLIST_A_ID }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.setlist.id).toBe(SETLIST_A_ID);
    expect(body.data.setlist.status).toBe("published");

    // Confirm via the mutated fake state directly (not just the response),
    // and that the *other* row (SETLIST_B) was never touched.
    const rowA = state.setlists.find((r) => r.id === SETLIST_A_ID)!;
    const rowB = state.setlists.find((r) => r.id === SETLIST_B_ID)!;
    expect(rowA.status).toBe("published");
    expect(rowB.status).toBe("published"); // was already published, unchanged
    expect(rowB.published_at).toBe("2026-01-01T00:00:00.000Z"); // untouched, not re-stamped
  });

  it("POST /api/setlists/:id/unlock unlocks exactly the setlist named by params.id", async () => {
    setUpAuth();
    const state = makeState();
    mockGetSupabaseClient.mockReturnValue(makeFakeSupabase(state));

    const res = await unlockRoute.POST(fakeReq, {
      params: Promise.resolve({ id: SETLIST_B_ID }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.setlist.id).toBe(SETLIST_B_ID);
    expect(body.data.setlist.status).toBe("draft");
    expect(body.data.setlist.publishedAt).toBeNull();

    const rowA = state.setlists.find((r) => r.id === SETLIST_A_ID)!;
    expect(rowA.status).toBe("draft"); // untouched
  });

  it("POST /api/setlists/:id/publish with the service_week id instead of the setlist id -> 404, not a mistaken publish", async () => {
    setUpAuth();
    const state = makeState();
    mockGetSupabaseClient.mockReturnValue(makeFakeSupabase(state));

    // WEEK_A_ID is a real service_week_id in the fixture but not a row id in
    // `setlists`, so if route.ts (or a future refactor) ever threaded the
    // wrong id through, this proves it fails closed (404) rather than
    // silently publishing nothing or the wrong row.
    const res = await publishRoute.POST(fakeReq, {
      params: Promise.resolve({ id: WEEK_A_ID }),
    });

    expect(res.status).toBe(404);
    const rowA = state.setlists.find((r) => r.id === SETLIST_A_ID)!;
    expect(rowA.status).toBe("draft");
  });
});

// ---------------------------------------------------------------------------
// Combined BR-01 edge case + an auth branch not covered by the Coder's suite.
// ---------------------------------------------------------------------------

describe("publishSetlist / unlockSetlist — combined edge case and auth branch not covered elsewhere", () => {
  it("zero songs AND zero confirmed members together -> still 200 published, no notification rows inserted", async () => {
    setUpAuth();
    const state = makeState();
    // state.setlistSongs and state.invitations are already empty by default.
    mockGetSupabaseClient.mockReturnValue(makeFakeSupabase(state));

    const res = await publishSetlist(fakeReq, SETLIST_A_ID, makeLookup("admin"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.setlist.status).toBe("published");
    expect(body.data.setlist.publishedAt).not.toBeNull();
    expect(state.notifications).toHaveLength(0);
  });

  it("returns 401 when requireAuth's lookup resolves to null (Clerk user not yet provisioned) — distinct from the missing-JWT 401 path", async () => {
    setUpAuth("clerk_test", JWT);
    const state = makeState();
    mockGetSupabaseClient.mockReturnValue(makeFakeSupabase(state));
    const unprovisionedLookup: UserLookup = async () => null;

    const res = await publishSetlist(fakeReq, SETLIST_A_ID, unprovisionedLookup);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("unlock: returns 401 when requireAuth's lookup resolves to null", async () => {
    setUpAuth("clerk_test", JWT);
    const state = makeState();
    mockGetSupabaseClient.mockReturnValue(makeFakeSupabase(state));
    const unprovisionedLookup: UserLookup = async () => null;

    const res = await unlockSetlist(fakeReq, SETLIST_B_ID, unprovisionedLookup);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });
});
