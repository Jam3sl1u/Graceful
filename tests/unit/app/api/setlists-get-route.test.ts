// Independent Tester-stage coverage for #64 (Setlist Builder screen):
// app/api/setlists/[id]/handler.ts's new `getSetlistWithSongs`
// (GET /api/setlists/:id) plus the `notes` persistence guard added to
// `reorderSetlist`. Mirrors the stateful in-memory fake Supabase pattern from
// tests/unit/app/api/setlists-songs-route.test.ts.

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({ getSupabaseClient: jest.fn() }));

import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { getSupabaseClient } from "@/lib/supabase/client";
import {
  getSetlistWithSongs,
  reorderSetlist,
  type SetlistSongResponse,
} from "@/app/api/setlists/[id]/handler";
import type { AuthContext, UserLookup } from "@/lib/api/auth";
import type { UserRole } from "@/types/domain";

const mockAuth = auth as unknown as jest.Mock;
const mockGetSupabaseClient = getSupabaseClient as unknown as jest.Mock;

const JWT = "supabase-jwt";
const USER_ID = "user-1";
const CHURCH_GROUP_ID = "group-1";
const OTHER_CHURCH_GROUP_ID = "group-2";
const SETLIST_ID = "setlist-1";
const PUBLISHED_SETLIST_ID = "setlist-published";
const SERVICE_WEEK_ID = "week-1";

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

function makeReq(body?: unknown, jsonImpl?: () => Promise<unknown>): NextRequest {
  return {
    json: jsonImpl ? jest.fn(jsonImpl) : jest.fn().mockResolvedValue(body),
  } as unknown as NextRequest;
}

beforeEach(() => {
  mockAuth.mockReset();
  mockGetSupabaseClient.mockReset();
});

// ---------------------------------------------------------------------------
// Stateful fake Supabase client (same shape as setlists-songs-route.test.ts)
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
type SongsRow = { id: string; church_group_id: string; default_key: string | null };
type SetlistSongsRow = {
  id: string;
  setlist_id: string;
  song_id: string;
  position: number;
  key_override: string | null;
  notes: string | null;
};

type Predicate<T extends AnyRow> = (row: T) => boolean;

function applyFilters<T extends AnyRow>(rows: T[], filters: [string, unknown][]): T[] {
  return rows.filter((r) => filters.every(([f, v]) => r[f] === v));
}

function makeSelectChain<T extends AnyRow>(rows: T[], error?: ErrObj) {
  const filters: [string, unknown][] = [];
  const predicates: Predicate<T>[] = [];
  let orderField: string | null = null;
  let orderAsc = true;
  const chain: Record<string, unknown> & PromiseLike<QueryResult> = {
    eq: jest.fn((f: string, v: unknown) => {
      filters.push([f, v]);
      return chain;
    }),
    in: jest.fn((f: string, values: unknown[]) => {
      predicates.push((row: T) => values.includes(row[f]));
      return chain;
    }),
    order: jest.fn((f: string, opts: { ascending: boolean }) => {
      orderField = f;
      orderAsc = opts.ascending;
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
        let matched = applyFilters(rows, filters).filter((r) => predicates.every((p) => p(r)));
        if (orderField) {
          const field = orderField;
          matched = [...matched].sort((a, b) => {
            const av = a[field] as number;
            const bv = b[field] as number;
            return orderAsc ? av - bv : bv - av;
          });
        }
        return { data: matched, error: null };
      };
      return run().then(resolve, reject);
    },
  } as unknown as Record<string, unknown> & PromiseLike<QueryResult>;
  return chain;
}

function makeUpdateChain(rows: SetlistSongsRow[], patch: AnyRow, error?: ErrObj) {
  const filters: [string, unknown][] = [];
  const chain: Record<string, unknown> & PromiseLike<QueryResult> = {
    eq: jest.fn((f: string, v: unknown) => {
      filters.push([f, v]);
      return chain;
    }),
    then: (resolve: (v: QueryResult) => unknown, reject?: (e: unknown) => unknown) => {
      const run = async (): Promise<QueryResult> => {
        if (error) return { data: null, error };
        const matched = applyFilters(rows, filters);
        for (const row of matched) Object.assign(row, patch);
        return { data: null, error: null };
      };
      return run().then(resolve, reject);
    },
  } as unknown as Record<string, unknown> & PromiseLike<QueryResult>;
  return chain;
}

type FakeState = {
  setlists: SetlistsRow[];
  songs: SongsRow[];
  setlistSongs: SetlistSongsRow[];
};

type FakeControls = {
  setlistsSelectError?: ErrObj;
  songsSelectError?: ErrObj;
  setlistSongsSelectError?: ErrObj;
  setlistSongsUpdateError?: ErrObj;
};

function makeFakeSupabase(state: FakeState, controls: FakeControls = {}) {
  return {
    from: jest.fn((table: string) => {
      if (table === "setlists") {
        return { select: jest.fn(() => makeSelectChain(state.setlists, controls.setlistsSelectError)) };
      }
      if (table === "songs") {
        return { select: jest.fn(() => makeSelectChain(state.songs, controls.songsSelectError)) };
      }
      if (table === "setlist_songs") {
        return {
          select: jest.fn(() => makeSelectChain(state.setlistSongs, controls.setlistSongsSelectError)),
          update: jest.fn((patch: AnyRow) =>
            makeUpdateChain(state.setlistSongs, patch, controls.setlistSongsUpdateError),
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
        id: SETLIST_ID,
        church_group_id: CHURCH_GROUP_ID,
        service_week_id: SERVICE_WEEK_ID,
        status: "draft",
        published_at: null,
        notes: null,
        created_by: USER_ID,
        created_at: "2026-07-01T00:00:00Z",
        updated_at: "2026-07-01T00:00:00Z",
      },
      {
        id: PUBLISHED_SETLIST_ID,
        church_group_id: CHURCH_GROUP_ID,
        service_week_id: SERVICE_WEEK_ID,
        status: "published",
        published_at: "2026-07-10T00:00:00Z",
        notes: null,
        created_by: USER_ID,
        created_at: "2026-07-01T00:00:00Z",
        updated_at: "2026-07-10T00:00:00Z",
      },
    ],
    songs: [
      { id: "11111111-1111-4111-8111-111111111111", church_group_id: CHURCH_GROUP_ID, default_key: "C" },
      { id: "22222222-2222-4222-8222-222222222222", church_group_id: CHURCH_GROUP_ID, default_key: "D" },
    ],
    setlistSongs: [
      {
        id: "ss-1",
        setlist_id: SETLIST_ID,
        song_id: "11111111-1111-4111-8111-111111111111",
        position: 1,
        key_override: "A",
        notes: "Play softly",
      },
      {
        id: "ss-2",
        setlist_id: SETLIST_ID,
        song_id: "22222222-2222-4222-8222-222222222222",
        position: 2,
        key_override: null,
        notes: null,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// GET /api/setlists/:id — getSetlistWithSongs
// ---------------------------------------------------------------------------

describe("GET /api/setlists/:id (getSetlistWithSongs)", () => {
  it("happy path: returns the setlist (draft) plus its ordered songs", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeFakeSupabase(baseState()));

    const res = await getSetlistWithSongs(makeReq(), SETLIST_ID, makeLookup("set_leader"));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data.setlist).toMatchObject({ id: SETLIST_ID, status: "draft" });
    const songs: SetlistSongResponse[] = body.data.songs;
    expect(songs).toEqual([
      {
        id: "ss-1",
        setlistId: SETLIST_ID,
        songId: "11111111-1111-4111-8111-111111111111",
        position: 1,
        keyOverride: "A",
        defaultKey: "C",
        effectiveKey: "A",
        isOverridden: true,
        notes: "Play softly",
      },
      {
        id: "ss-2",
        setlistId: SETLIST_ID,
        songId: "22222222-2222-4222-8222-222222222222",
        position: 2,
        keyOverride: null,
        defaultKey: "D",
        effectiveKey: "D",
        isOverridden: false,
        notes: null,
      },
    ]);
  });

  it("also returns songs for a PUBLISHED setlist (client needs status to render the locked state)", async () => {
    setUpAuth();
    const state = baseState();
    state.setlistSongs = state.setlistSongs.map((r) => ({ ...r, setlist_id: PUBLISHED_SETLIST_ID }));
    mockGetSupabaseClient.mockReturnValue(makeFakeSupabase(state));

    const res = await getSetlistWithSongs(makeReq(), PUBLISHED_SETLIST_ID, makeLookup("set_leader"));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data.setlist.status).toBe("published");
    expect(body.data.songs).toHaveLength(2);
  });

  it("allows admin role", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeFakeSupabase(baseState()));

    const res = await getSetlistWithSongs(makeReq(), SETLIST_ID, makeLookup("admin"));
    expect(res.status).toBe(200);
  });

  it("returns 404 (not 403) when the setlist belongs to another tenant — never leaks existence", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeFakeSupabase(baseState()));

    const res = await getSetlistWithSongs(
      makeReq(),
      SETLIST_ID,
      makeLookup("admin", OTHER_CHURCH_GROUP_ID),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });

  it("returns 404 when the setlist id does not exist at all", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeFakeSupabase(baseState()));

    const res = await getSetlistWithSongs(makeReq(), "does-not-exist", makeLookup("admin"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });

  it.each<UserRole>(["member", "guest"])("returns 403 FORBIDDEN for role = '%s'", async (role) => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeFakeSupabase(baseState()));

    const res = await getSetlistWithSongs(makeReq(), SETLIST_ID, makeLookup(role));
    expect(res.status).toBe(403);
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 401 UNAUTHENTICATED when getToken yields no JWT", async () => {
    setUpAuth(null);

    const res = await getSetlistWithSongs(makeReq(), SETLIST_ID, makeLookup("admin"));
    expect(res.status).toBe(401);
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 500 INTERNAL when the setlist lookup errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeFakeSupabase(baseState(), { setlistsSelectError: { message: "connection refused" } }),
    );

    const res = await getSetlistWithSongs(makeReq(), SETLIST_ID, makeLookup("admin"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });

  it("returns 500 INTERNAL when the songs join errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeFakeSupabase(baseState(), { songsSelectError: { message: "connection refused" } }),
    );

    const res = await getSetlistWithSongs(makeReq(), SETLIST_ID, makeLookup("admin"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });
});

// ---------------------------------------------------------------------------
// PUT /api/setlists/:id — notes persistence guard (Gap 2 in the spec)
// ---------------------------------------------------------------------------

describe("PUT /api/setlists/:id (reorderSetlist) — notes guard", () => {
  it("omitting `notes` on an entry leaves that song's existing notes column untouched", async () => {
    setUpAuth();
    const state = baseState(); // ss-1 has notes "Play softly", ss-2 has null
    mockGetSupabaseClient.mockReturnValue(makeFakeSupabase(state));

    const res = await reorderSetlist(
      makeReq({
        songs: [
          { songId: "11111111-1111-4111-8111-111111111111" }, // notes omitted
          { songId: "22222222-2222-4222-8222-222222222222" }, // notes omitted
        ],
      }),
      SETLIST_ID,
      makeLookup("set_leader"),
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    const songs: SetlistSongResponse[] = body.data.songs;
    const song1 = songs.find((s) => s.songId === "11111111-1111-4111-8111-111111111111");
    expect(song1?.notes).toBe("Play softly"); // untouched
  });

  it("`notes: null` clears an existing note", async () => {
    setUpAuth();
    const state = baseState();
    mockGetSupabaseClient.mockReturnValue(makeFakeSupabase(state));

    const res = await reorderSetlist(
      makeReq({
        songs: [
          { songId: "11111111-1111-4111-8111-111111111111", notes: null },
          { songId: "22222222-2222-4222-8222-222222222222" },
        ],
      }),
      SETLIST_ID,
      makeLookup("set_leader"),
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    const songs: SetlistSongResponse[] = body.data.songs;
    const song1 = songs.find((s) => s.songId === "11111111-1111-4111-8111-111111111111");
    expect(song1?.notes).toBeNull();
  });

  it("a string sets/updates the note", async () => {
    setUpAuth();
    const state = baseState();
    mockGetSupabaseClient.mockReturnValue(makeFakeSupabase(state));

    const res = await reorderSetlist(
      makeReq({
        songs: [
          { songId: "11111111-1111-4111-8111-111111111111" },
          { songId: "22222222-2222-4222-8222-222222222222", notes: "Bring capo" },
        ],
      }),
      SETLIST_ID,
      makeLookup("set_leader"),
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    const songs: SetlistSongResponse[] = body.data.songs;
    const song2 = songs.find((s) => s.songId === "22222222-2222-4222-8222-222222222222");
    expect(song2?.notes).toBe("Bring capo");
  });

  it("rejects an overlong notes string (> 1000 chars) as a 400 validation failure", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeFakeSupabase(baseState()));

    const res = await reorderSetlist(
      makeReq({
        songs: [
          {
            songId: "11111111-1111-4111-8111-111111111111",
            notes: "x".repeat(1001),
          },
          { songId: "22222222-2222-4222-8222-222222222222" },
        ],
      }),
      SETLIST_ID,
      makeLookup("set_leader"),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });
});
