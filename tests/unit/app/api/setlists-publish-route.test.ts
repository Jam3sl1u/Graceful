// Independent Tester-stage coverage for #56 (publish / unlock setlist,
// BR-01 zero-song publish). Uses a small stateful in-memory fake for the
// `setlists` / `setlist_songs` / `invitations` / `notifications` tables so
// that the notification fan-out (dedupe, skip-when-empty, body copy) is
// verified against real mutated state rather than a single canned fixture.

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({ getSupabaseClient: jest.fn() }));

import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { getSupabaseClient } from "@/lib/supabase/client";
import { publishSetlist, unlockSetlist } from "@/app/api/setlists/[id]/handler";
import type { AuthContext, UserLookup } from "@/lib/api/auth";
import type { UserRole } from "@/types/domain";

const mockAuth = auth as unknown as jest.Mock;
const mockGetSupabaseClient = getSupabaseClient as unknown as jest.Mock;

const JWT = "supabase-jwt";
const USER_ID = "user-1";
const CHURCH_GROUP_ID = "group-1";
const OTHER_CHURCH_GROUP_ID = "group-2";
const DRAFT_SETLIST_ID = "setlist-draft";
const PUBLISHED_SETLIST_ID = "setlist-published";
const WEEK_ID = "week-1";
const OTHER_WEEK_ID = "week-2";

function makeLookup(role: UserRole, churchGroupId = CHURCH_GROUP_ID): UserLookup {
  const ctx: AuthContext = { userId: USER_ID, churchGroupId, role };
  return async () => ctx;
}

function setUpAuth(jwt: string | null = JWT) {
  mockAuth.mockResolvedValue({
    userId: "clerk_test",
    getToken: jest.fn().mockResolvedValue(jwt),
  });
}

function makeReq(): NextRequest {
  return { json: jest.fn().mockResolvedValue(undefined) } as unknown as NextRequest;
}

beforeEach(() => {
  mockAuth.mockReset();
  mockGetSupabaseClient.mockReset();
});

// ---------------------------------------------------------------------------
// Stateful fake Supabase client
// ---------------------------------------------------------------------------

type AnyRow = Record<string, unknown>;
type QueryResult = { data: unknown; error: unknown };
type ErrObj = { message: string; code?: string };

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
type SetlistSongsRow = { id: string; setlist_id: string };
type InvitationsRow = { id: string; service_week_id: string; user_id: string; status: string };
type NotificationsRow = Record<string, unknown>;

function applyFilters<T extends AnyRow>(rows: T[], filters: [string, unknown][]): T[] {
  return rows.filter((r) => filters.every(([f, v]) => r[f] === v));
}

// select(...).eq(...).eq(...).maybeSingle() or ...then(...) (array) chain.
function makeSelectChain<T extends AnyRow>(rows: T[], error?: ErrObj) {
  const filters: [string, unknown][] = [];
  const chain: Record<string, unknown> & PromiseLike<QueryResult> = {
    eq: jest.fn((f: string, v: unknown) => {
      filters.push([f, v]);
      return chain;
    }),
    maybeSingle: jest.fn(async () => {
      if (error) return { data: null, error };
      const matched = applyFilters(rows, filters);
      return { data: matched[0] ?? null, error: null };
    }),
    then: (resolve: (v: QueryResult) => unknown, reject?: (e: unknown) => unknown) => {
      const run = async (): Promise<QueryResult> => {
        if (error) return { data: null, error };
        return { data: applyFilters(rows, filters), error: null };
      };
      return run().then(resolve, reject);
    },
  } as unknown as Record<string, unknown> & PromiseLike<QueryResult>;
  return chain;
}

// update(patch).eq(...).eq(...).select("*").maybeSingle() chain.
function makeUpdateChain(rows: SetlistsRow[], patch: AnyRow, error?: ErrObj) {
  const filters: [string, unknown][] = [];
  const chain: Record<string, unknown> & PromiseLike<QueryResult> = {
    eq: jest.fn((f: string, v: unknown) => {
      filters.push([f, v]);
      return chain;
    }),
    select: jest.fn(() => chain),
    maybeSingle: jest.fn(async () => {
      if (error) return { data: null, error };
      const matched = applyFilters(rows, filters);
      for (const row of matched) Object.assign(row, patch);
      return { data: matched[0] ?? null, error: null };
    }),
  } as unknown as Record<string, unknown> & PromiseLike<QueryResult>;
  return chain;
}

function makeInsertChain(sink: NotificationsRow[], payload: AnyRow, error?: ErrObj) {
  return {
    then: (resolve: (v: QueryResult) => unknown, reject?: (e: unknown) => unknown) => {
      const run = async (): Promise<QueryResult> => {
        if (error) return { data: null, error };
        const inserted = Array.isArray(payload) ? payload : [payload];
        sink.push(...(inserted as NotificationsRow[]));
        return { data: null, error: null };
      };
      return run().then(resolve, reject);
    },
  } as unknown as PromiseLike<QueryResult>;
}

type FakeState = {
  setlists: SetlistsRow[];
  setlistSongs: SetlistSongsRow[];
  invitations: InvitationsRow[];
  notifications: NotificationsRow[];
};

type FakeControls = {
  setlistsSelectError?: ErrObj;
  setlistsUpdateError?: ErrObj;
  setlistSongsSelectError?: ErrObj;
  invitationsSelectError?: ErrObj;
  notificationsInsertError?: ErrObj;
};

function makeFakeSupabase(state: FakeState, controls: FakeControls = {}) {
  return {
    from: jest.fn((table: string) => {
      if (table === "setlists") {
        return {
          select: jest.fn(() => makeSelectChain(state.setlists, controls.setlistsSelectError)),
          update: jest.fn((patch: AnyRow) =>
            makeUpdateChain(state.setlists, patch, controls.setlistsUpdateError),
          ),
        };
      }
      if (table === "setlist_songs") {
        return {
          select: jest.fn(() => makeSelectChain(state.setlistSongs, controls.setlistSongsSelectError)),
        };
      }
      if (table === "invitations") {
        return {
          select: jest.fn(() => makeSelectChain(state.invitations, controls.invitationsSelectError)),
        };
      }
      if (table === "notifications") {
        return {
          insert: jest.fn((payload: AnyRow) =>
            makeInsertChain(state.notifications, payload, controls.notificationsInsertError),
          ),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    }),
  };
}

function baseState(): FakeState {
  return {
    setlists: [
      {
        id: DRAFT_SETLIST_ID,
        church_group_id: CHURCH_GROUP_ID,
        service_week_id: WEEK_ID,
        status: "draft",
        published_at: null,
        notes: null,
        created_by: USER_ID,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
      {
        id: PUBLISHED_SETLIST_ID,
        church_group_id: CHURCH_GROUP_ID,
        service_week_id: OTHER_WEEK_ID,
        status: "published",
        published_at: "2026-01-01T00:00:00.000Z",
        notes: null,
        created_by: USER_ID,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
    ],
    setlistSongs: [{ id: "ss-1", setlist_id: DRAFT_SETLIST_ID }],
    invitations: [
      { id: "inv-1", service_week_id: WEEK_ID, user_id: "user-a", status: "accepted" },
      // Duplicate accepted invitation for the same user -> deduped to one notification.
      { id: "inv-2", service_week_id: WEEK_ID, user_id: "user-a", status: "accepted" },
      { id: "inv-3", service_week_id: WEEK_ID, user_id: "user-b", status: "accepted" },
      { id: "inv-4", service_week_id: WEEK_ID, user_id: "user-c", status: "pending" },
    ],
    notifications: [],
  };
}

// ---------------------------------------------------------------------------
// POST /api/setlists/:id/publish — publishSetlist
// ---------------------------------------------------------------------------

describe("POST /api/setlists/:id/publish (publishSetlist)", () => {
  it("happy path: songs present + confirmed members present -> notifies with body: null, dedupes by user", async () => {
    setUpAuth();
    const state = baseState();
    mockGetSupabaseClient.mockReturnValue(makeFakeSupabase(state));

    const res = await publishSetlist(makeReq(), DRAFT_SETLIST_ID, makeLookup("set_leader"));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data.setlist.status).toBe("published");
    expect(body.data.setlist.publishedAt).toEqual(expect.any(String));

    expect(state.notifications).toHaveLength(2); // user-a (deduped), user-b
    for (const n of state.notifications) {
      expect(n).toMatchObject({
        church_group_id: CHURCH_GROUP_ID,
        type: "setlist_released",
        title: "Setlist published",
        body: null,
        link_entity_type: "setlist",
        link_entity_id: DRAFT_SETLIST_ID,
      });
    }
    const notifiedUsers = state.notifications.map((n) => n.user_id).sort();
    expect(notifiedUsers).toEqual(["user-a", "user-b"]);
  });

  it("allows admin role", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeFakeSupabase(baseState()));

    const res = await publishSetlist(makeReq(), DRAFT_SETLIST_ID, makeLookup("admin"));
    expect(res.status).toBe(200);
  });

  it("BR-01: zero songs -> 200 published, notification body mentions songs still being added", async () => {
    setUpAuth();
    const state = baseState();
    state.setlistSongs = [];
    mockGetSupabaseClient.mockReturnValue(makeFakeSupabase(state));

    const res = await publishSetlist(makeReq(), DRAFT_SETLIST_ID, makeLookup("admin"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.setlist.status).toBe("published");
    expect(body.data.setlist.publishedAt).not.toBeNull();

    expect(state.notifications.length).toBeGreaterThan(0);
    for (const n of state.notifications) {
      expect(n.body).toBe("The setlist has been published — songs are still being added.");
    }
  });

  it("zero confirmed members -> publish succeeds but inserts no notification rows", async () => {
    setUpAuth();
    const state = baseState();
    state.invitations = state.invitations.filter((i) => i.status !== "accepted");
    mockGetSupabaseClient.mockReturnValue(makeFakeSupabase(state));

    const res = await publishSetlist(makeReq(), DRAFT_SETLIST_ID, makeLookup("admin"));
    expect(res.status).toBe(200);
    expect(state.notifications).toHaveLength(0);
  });

  it("returns 409 CONFLICT when the setlist is already published", async () => {
    setUpAuth();
    const state = baseState();
    mockGetSupabaseClient.mockReturnValue(makeFakeSupabase(state));

    const res = await publishSetlist(makeReq(), PUBLISHED_SETLIST_ID, makeLookup("admin"));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("CONFLICT");
    expect(body.error).toBe("Setlist is already published.");
    expect(state.notifications).toHaveLength(0);
  });

  it("returns 404 when the setlist does not exist or belongs to another tenant", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeFakeSupabase(baseState()));

    const res = await publishSetlist(makeReq(), DRAFT_SETLIST_ID, makeLookup("admin", OTHER_CHURCH_GROUP_ID));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });

  it.each<UserRole>(["member", "guest"])("returns 403 FORBIDDEN for role = '%s'", async (role) => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeFakeSupabase(baseState()));

    const res = await publishSetlist(makeReq(), DRAFT_SETLIST_ID, makeLookup(role));
    expect(res.status).toBe(403);
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 401 UNAUTHENTICATED when getToken yields no JWT", async () => {
    setUpAuth(null);

    const res = await publishSetlist(makeReq(), DRAFT_SETLIST_ID, makeLookup("admin"));
    expect(res.status).toBe(401);
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 500 INTERNAL when the load step errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeFakeSupabase(baseState(), { setlistsSelectError: { message: "connection refused" } }),
    );

    const res = await publishSetlist(makeReq(), DRAFT_SETLIST_ID, makeLookup("admin"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });

  it("returns 500 INTERNAL when the update step errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeFakeSupabase(baseState(), { setlistsUpdateError: { message: "connection refused" } }),
    );

    const res = await publishSetlist(makeReq(), DRAFT_SETLIST_ID, makeLookup("admin"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });

  it("returns 500 INTERNAL when the song-count step errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeFakeSupabase(baseState(), { setlistSongsSelectError: { message: "connection refused" } }),
    );

    const res = await publishSetlist(makeReq(), DRAFT_SETLIST_ID, makeLookup("admin"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });

  it("returns 500 INTERNAL when the invitations lookup errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeFakeSupabase(baseState(), { invitationsSelectError: { message: "connection refused" } }),
    );

    const res = await publishSetlist(makeReq(), DRAFT_SETLIST_ID, makeLookup("admin"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });

  it("returns 500 INTERNAL when the notification insert errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeFakeSupabase(baseState(), { notificationsInsertError: { message: "connection refused" } }),
    );

    const res = await publishSetlist(makeReq(), DRAFT_SETLIST_ID, makeLookup("admin"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });
});

// ---------------------------------------------------------------------------
// POST /api/setlists/:id/unlock — unlockSetlist
// ---------------------------------------------------------------------------

describe("POST /api/setlists/:id/unlock (unlockSetlist)", () => {
  it("happy path: published -> draft, publishedAt reset to null, no notifications", async () => {
    setUpAuth();
    const state = baseState();
    mockGetSupabaseClient.mockReturnValue(makeFakeSupabase(state));

    const res = await unlockSetlist(makeReq(), PUBLISHED_SETLIST_ID, makeLookup("set_leader"));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data.setlist.status).toBe("draft");
    expect(body.data.setlist.publishedAt).toBeNull();
    expect(state.notifications).toHaveLength(0);
  });

  it("allows admin role", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeFakeSupabase(baseState()));

    const res = await unlockSetlist(makeReq(), PUBLISHED_SETLIST_ID, makeLookup("admin"));
    expect(res.status).toBe(200);
  });

  it("returns 409 CONFLICT when unlocking a draft", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeFakeSupabase(baseState()));

    const res = await unlockSetlist(makeReq(), DRAFT_SETLIST_ID, makeLookup("admin"));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("CONFLICT");
  });

  it("returns 404 when the setlist does not exist or belongs to another tenant", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeFakeSupabase(baseState()));

    const res = await unlockSetlist(
      makeReq(),
      PUBLISHED_SETLIST_ID,
      makeLookup("admin", OTHER_CHURCH_GROUP_ID),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });

  it.each<UserRole>(["member", "guest"])("returns 403 FORBIDDEN for role = '%s'", async (role) => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeFakeSupabase(baseState()));

    const res = await unlockSetlist(makeReq(), PUBLISHED_SETLIST_ID, makeLookup(role));
    expect(res.status).toBe(403);
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 401 UNAUTHENTICATED when getToken yields no JWT", async () => {
    setUpAuth(null);

    const res = await unlockSetlist(makeReq(), PUBLISHED_SETLIST_ID, makeLookup("admin"));
    expect(res.status).toBe(401);
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 500 INTERNAL when the load step errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeFakeSupabase(baseState(), { setlistsSelectError: { message: "connection refused" } }),
    );

    const res = await unlockSetlist(makeReq(), PUBLISHED_SETLIST_ID, makeLookup("admin"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });

  it("returns 500 INTERNAL when the update step errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeFakeSupabase(baseState(), { setlistsUpdateError: { message: "connection refused" } }),
    );

    const res = await unlockSetlist(makeReq(), PUBLISHED_SETLIST_ID, makeLookup("admin"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });
});
