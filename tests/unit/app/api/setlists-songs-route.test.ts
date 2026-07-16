// Independent Tester-stage coverage for #55 (add/remove/reorder setlist
// songs, BR-07 no duplicates). Uses a small stateful in-memory fake for the
// `setlists` / `songs` / `setlist_songs` tables so that multi-step handler
// behavior (recompaction, exact songId-set matching, position derivation
// from array order) is verified against real mutated state rather than a
// single canned fixture per call.

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({ getSupabaseClient: jest.fn() }));

import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { getSupabaseClient } from "@/lib/supabase/client";
import {
  reorderSetlist,
  addSetlistSong,
  removeSetlistSong,
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
// Stateful fake Supabase client
// ---------------------------------------------------------------------------

type AnyRow = Record<string, unknown>;
type QueryResult = { data: unknown; error: unknown };
type ErrObj = { message: string; code?: string };

type SetlistsRow = { id: string; church_group_id: string; status: string };
type SongsRow = { id: string; church_group_id: string };
type SetlistSongsRow = {
  id: string;
  setlist_id: string;
  song_id: string;
  position: number;
  key_override: string | null;
  notes: string | null;
};

function applyFilters<T extends AnyRow>(rows: T[], filters: [string, unknown][]): T[] {
  return rows.filter((r) => filters.every(([f, v]) => r[f] === v));
}

function makeSelectChain<T extends AnyRow>(rows: T[], error?: ErrObj) {
  const filters: [string, unknown][] = [];
  let orderField: string | null = null;
  let orderAsc = true;
  const chain: Record<string, unknown> & PromiseLike<QueryResult> = {
    eq: jest.fn((f: string, v: unknown) => {
      filters.push([f, v]);
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
        let matched = applyFilters(rows, filters);
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

function makeDeleteChain(rows: SetlistSongsRow[], error?: ErrObj) {
  const filters: [string, unknown][] = [];
  let selectAfter = false;
  const chain: Record<string, unknown> & PromiseLike<QueryResult> = {
    eq: jest.fn((f: string, v: unknown) => {
      filters.push([f, v]);
      return chain;
    }),
    select: jest.fn(() => {
      selectAfter = true;
      return chain;
    }),
    then: (resolve: (v: QueryResult) => unknown, reject?: (e: unknown) => unknown) => {
      const run = async (): Promise<QueryResult> => {
        if (error) return { data: null, error };
        const matched = applyFilters(rows, filters);
        for (const row of matched) {
          const idx = rows.indexOf(row);
          if (idx >= 0) rows.splice(idx, 1);
        }
        return { data: selectAfter ? matched.map((r) => ({ id: r.id })) : null, error: null };
      };
      return run().then(resolve, reject);
    },
  } as unknown as Record<string, unknown> & PromiseLike<QueryResult>;
  return chain;
}

let insertCounter = 0;
function makeInsertChain(rows: SetlistSongsRow[], payload: AnyRow, error?: ErrObj) {
  return {
    then: (resolve: (v: QueryResult) => unknown, reject?: (e: unknown) => unknown) => {
      const run = async (): Promise<QueryResult> => {
        if (error) return { data: null, error };
        insertCounter += 1;
        rows.push({
          id: `new-row-${insertCounter}`,
          setlist_id: payload.setlist_id as string,
          song_id: payload.song_id as string,
          position: payload.position as number,
          key_override: (payload.key_override as string | null) ?? null,
          notes: null,
        });
        return { data: null, error: null };
      };
      return run().then(resolve, reject);
    },
  } as unknown as PromiseLike<QueryResult>;
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
  setlistSongsDeleteError?: ErrObj;
  setlistSongsInsertError?: ErrObj;
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
          delete: jest.fn(() => makeDeleteChain(state.setlistSongs, controls.setlistSongsDeleteError)),
          insert: jest.fn((payload: AnyRow) =>
            makeInsertChain(state.setlistSongs, payload, controls.setlistSongsInsertError),
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
      { id: SETLIST_ID, church_group_id: CHURCH_GROUP_ID, status: "draft" },
      { id: PUBLISHED_SETLIST_ID, church_group_id: CHURCH_GROUP_ID, status: "published" },
    ],
    songs: [
      { id: "11111111-1111-1111-1111-111111111111", church_group_id: CHURCH_GROUP_ID },
      { id: "22222222-2222-2222-2222-222222222222", church_group_id: CHURCH_GROUP_ID },
      { id: "33333333-3333-3333-3333-333333333333", church_group_id: CHURCH_GROUP_ID },
      { id: "44444444-4444-4444-4444-444444444444", church_group_id: OTHER_CHURCH_GROUP_ID },
    ],
    setlistSongs: [
      {
        id: "ss-1",
        setlist_id: SETLIST_ID,
        song_id: "11111111-1111-1111-1111-111111111111",
        position: 1,
        key_override: "A",
        notes: null,
      },
      {
        id: "ss-2",
        setlist_id: SETLIST_ID,
        song_id: "22222222-2222-2222-2222-222222222222",
        position: 2,
        key_override: "C",
        notes: null,
      },
      {
        id: "ss-3",
        setlist_id: SETLIST_ID,
        song_id: "33333333-3333-3333-3333-333333333333",
        position: 3,
        key_override: null,
        notes: null,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// PUT /api/setlists/:id — reorderSetlist
// ---------------------------------------------------------------------------

describe("PUT /api/setlists/:id (reorderSetlist)", () => {
  it("happy path: reorders, derives 1-indexed position from array order, sets key_override per-entry (including clearing via omission and via explicit null)", async () => {
    setUpAuth();
    const state = baseState();
    mockGetSupabaseClient.mockReturnValue(makeFakeSupabase(state));

    const res = await reorderSetlist(
      makeReq({
        songs: [
          { songId: "33333333-3333-3333-3333-333333333333", keyOverride: "G" },
          { songId: "11111111-1111-1111-1111-111111111111" }, // omitted -> clears existing "A" override
          { songId: "22222222-2222-2222-2222-222222222222", keyOverride: null }, // explicit null -> clears existing "C"
        ],
      }),
      SETLIST_ID,
      makeLookup("set_leader"),
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    const songs: SetlistSongResponse[] = body.data.songs;
    expect(songs).toEqual([
      {
        id: "ss-3",
        setlistId: SETLIST_ID,
        songId: "33333333-3333-3333-3333-333333333333",
        position: 1,
        keyOverride: "G",
        notes: null,
      },
      {
        id: "ss-1",
        setlistId: SETLIST_ID,
        songId: "11111111-1111-1111-1111-111111111111",
        position: 2,
        keyOverride: null,
        notes: null,
      },
      {
        id: "ss-2",
        setlistId: SETLIST_ID,
        songId: "22222222-2222-2222-2222-222222222222",
        position: 3,
        keyOverride: null,
        notes: null,
      },
    ]);
  });

  it("allows admin role", async () => {
    setUpAuth();
    const state = baseState();
    mockGetSupabaseClient.mockReturnValue(makeFakeSupabase(state));

    const res = await reorderSetlist(
      makeReq({ songs: [{ songId: "11111111-1111-1111-1111-111111111111" }, { songId: "22222222-2222-2222-2222-222222222222" }, { songId: "33333333-3333-3333-3333-333333333333" }] }),
      SETLIST_ID,
      makeLookup("admin"),
    );
    expect(res.status).toBe(200);
  });

  it("returns 400 VALIDATION_FAILED for malformed JSON", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeFakeSupabase(baseState()));

    const res = await reorderSetlist(
      makeReq(undefined, () => Promise.reject(new Error("bad json"))),
      SETLIST_ID,
      makeLookup("admin"),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 400 VALIDATION_FAILED for a shape-invalid body (bad songId uuid)", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeFakeSupabase(baseState()));

    const res = await reorderSetlist(
      makeReq({ songs: [{ songId: "not-a-uuid" }] }),
      SETLIST_ID,
      makeLookup("admin"),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when the body's songId set is missing an existing song", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeFakeSupabase(baseState()));

    const res = await reorderSetlist(
      makeReq({ songs: [{ songId: "11111111-1111-1111-1111-111111111111" }, { songId: "22222222-2222-2222-2222-222222222222" }] }), // song-3 missing
      SETLIST_ID,
      makeLookup("admin"),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("returns 400 when the body's songId set contains an extra song not in the setlist", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeFakeSupabase(baseState()));

    const res = await reorderSetlist(
      makeReq({
        songs: [
          { songId: "11111111-1111-1111-1111-111111111111" },
          { songId: "22222222-2222-2222-2222-222222222222" },
          { songId: "33333333-3333-3333-3333-333333333333" },
          { songId: "66666666-6666-6666-6666-666666666666" },
        ],
      }),
      SETLIST_ID,
      makeLookup("admin"),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for duplicate songIds within the request body", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeFakeSupabase(baseState()));

    const res = await reorderSetlist(
      makeReq({ songs: [{ songId: "11111111-1111-1111-1111-111111111111" }, { songId: "11111111-1111-1111-1111-111111111111" }, { songId: "22222222-2222-2222-2222-222222222222" }] }),
      SETLIST_ID,
      makeLookup("admin"),
    );
    expect(res.status).toBe(400);
  });

  it("returns 422 VALIDATION_FAILED for a shape-valid but BR-09-invalid keyOverride", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeFakeSupabase(baseState()));

    const res = await reorderSetlist(
      makeReq({
        songs: [
          { songId: "11111111-1111-1111-1111-111111111111", keyOverride: "H" },
          { songId: "22222222-2222-2222-2222-222222222222" },
          { songId: "33333333-3333-3333-3333-333333333333" },
        ],
      }),
      SETLIST_ID,
      makeLookup("admin"),
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("returns 404 when the setlist does not exist or belongs to another tenant", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeFakeSupabase(baseState()));

    const res = await reorderSetlist(
      makeReq({ songs: [{ songId: "11111111-1111-1111-1111-111111111111" }] }),
      SETLIST_ID,
      makeLookup("admin", OTHER_CHURCH_GROUP_ID),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });

  it("returns 409 CONFLICT when the setlist is published", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeFakeSupabase(baseState()));

    const res = await reorderSetlist(
      makeReq({ songs: [{ songId: "11111111-1111-1111-1111-111111111111" }] }),
      PUBLISHED_SETLIST_ID,
      makeLookup("admin"),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("CONFLICT");
  });

  it.each<UserRole>(["member", "guest"])("returns 403 FORBIDDEN for role = '%s'", async (role) => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeFakeSupabase(baseState()));

    const res = await reorderSetlist(
      makeReq({ songs: [{ songId: "11111111-1111-1111-1111-111111111111" }] }),
      SETLIST_ID,
      makeLookup(role),
    );
    expect(res.status).toBe(403);
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 401 UNAUTHENTICATED when getToken yields no JWT", async () => {
    setUpAuth(null);

    const res = await reorderSetlist(
      makeReq({ songs: [{ songId: "11111111-1111-1111-1111-111111111111" }] }),
      SETLIST_ID,
      makeLookup("admin"),
    );
    expect(res.status).toBe(401);
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 500 INTERNAL when the update step errors", async () => {
    setUpAuth();
    const state = baseState();
    mockGetSupabaseClient.mockReturnValue(
      makeFakeSupabase(state, { setlistSongsUpdateError: { message: "connection refused" } }),
    );

    const res = await reorderSetlist(
      makeReq({ songs: [{ songId: "11111111-1111-1111-1111-111111111111" }, { songId: "22222222-2222-2222-2222-222222222222" }, { songId: "33333333-3333-3333-3333-333333333333" }] }),
      SETLIST_ID,
      makeLookup("admin"),
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });
});

// ---------------------------------------------------------------------------
// POST /api/setlists/:id/songs — addSetlistSong
// ---------------------------------------------------------------------------

describe("POST /api/setlists/:id/songs (addSetlistSong)", () => {
  beforeEach(() => {
    insertCounter = 0;
  });

  it("happy path: returns 201, adds the song at position = count + 1", async () => {
    setUpAuth();
    const state = baseState();
    // remove song-3 from the setlist so it's addable
    state.setlistSongs = state.setlistSongs.filter((r) => r.song_id !== "33333333-3333-3333-3333-333333333333");
    mockGetSupabaseClient.mockReturnValue(makeFakeSupabase(state));

    const res = await addSetlistSong(
      makeReq({ songId: "33333333-3333-3333-3333-333333333333", keyOverride: "Bb" }),
      SETLIST_ID,
      makeLookup("set_leader"),
    );
    expect(res.status).toBe(201);

    const body = await res.json();
    const songs: SetlistSongResponse[] = body.data.songs;
    expect(songs).toHaveLength(3);
    expect(songs[2]).toMatchObject({ songId: "33333333-3333-3333-3333-333333333333", position: 3, keyOverride: "Bb" });
  });

  it("returns 404 'Song not found' when songId is not in the caller's group catalog", async () => {
    setUpAuth();
    const state = baseState();
    mockGetSupabaseClient.mockReturnValue(makeFakeSupabase(state));

    const res = await addSetlistSong(
      makeReq({ songId: "44444444-4444-4444-4444-444444444444" }),
      SETLIST_ID,
      makeLookup("admin"),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });

  it("returns 409 CONFLICT (BR-07) when the song is already in the setlist", async () => {
    setUpAuth();
    const state = baseState();
    mockGetSupabaseClient.mockReturnValue(makeFakeSupabase(state));

    const res = await addSetlistSong(
      makeReq({ songId: "11111111-1111-1111-1111-111111111111" }), // already in setlist per baseState
      SETLIST_ID,
      makeLookup("admin"),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("CONFLICT");
    expect(state.setlistSongs).toHaveLength(3); // nothing inserted
  });

  it("returns 422 for an invalid keyOverride (BR-09)", async () => {
    setUpAuth();
    const state = baseState();
    state.setlistSongs = state.setlistSongs.filter((r) => r.song_id !== "33333333-3333-3333-3333-333333333333");
    mockGetSupabaseClient.mockReturnValue(makeFakeSupabase(state));

    const res = await addSetlistSong(
      makeReq({ songId: "33333333-3333-3333-3333-333333333333", keyOverride: "Zz" }),
      SETLIST_ID,
      makeLookup("admin"),
    );
    expect(res.status).toBe(422);
  });

  it("returns 400 for a missing/malformed body (missing songId)", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeFakeSupabase(baseState()));

    const res = await addSetlistSong(makeReq({}), SETLIST_ID, makeLookup("admin"));
    expect(res.status).toBe(400);
  });

  it("returns 404 when the setlist does not exist or belongs to another tenant", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeFakeSupabase(baseState()));

    const res = await addSetlistSong(
      makeReq({ songId: "11111111-1111-1111-1111-111111111111" }),
      SETLIST_ID,
      makeLookup("admin", OTHER_CHURCH_GROUP_ID),
    );
    expect(res.status).toBe(404);
  });

  it("returns 409 CONFLICT when the setlist is published", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeFakeSupabase(baseState()));

    const res = await addSetlistSong(
      makeReq({ songId: "11111111-1111-1111-1111-111111111111" }),
      PUBLISHED_SETLIST_ID,
      makeLookup("admin"),
    );
    expect(res.status).toBe(409);
  });

  it.each<UserRole>(["member", "guest"])("returns 403 FORBIDDEN for role = '%s'", async (role) => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeFakeSupabase(baseState()));

    const res = await addSetlistSong(makeReq({ songId: "11111111-1111-1111-1111-111111111111" }), SETLIST_ID, makeLookup(role));
    expect(res.status).toBe(403);
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 401 UNAUTHENTICATED when getToken yields no JWT", async () => {
    setUpAuth(null);

    const res = await addSetlistSong(makeReq({ songId: "11111111-1111-1111-1111-111111111111" }), SETLIST_ID, makeLookup("admin"));
    expect(res.status).toBe(401);
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("maps a generic insert error to 500 INTERNAL", async () => {
    setUpAuth();
    const state = baseState();
    state.setlistSongs = state.setlistSongs.filter((r) => r.song_id !== "33333333-3333-3333-3333-333333333333");
    mockGetSupabaseClient.mockReturnValue(
      makeFakeSupabase(state, { setlistSongsInsertError: { message: "connection refused" } }),
    );

    const res = await addSetlistSong(makeReq({ songId: "33333333-3333-3333-3333-333333333333" }), SETLIST_ID, makeLookup("admin"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });

  it("maps a Postgres unique-violation (23505) race on insert to 409 CONFLICT, not 500", async () => {
    setUpAuth();
    const state = baseState();
    state.setlistSongs = state.setlistSongs.filter((r) => r.song_id !== "33333333-3333-3333-3333-333333333333");
    mockGetSupabaseClient.mockReturnValue(
      makeFakeSupabase(state, {
        setlistSongsInsertError: {
          message: "duplicate key value violates unique constraint",
          code: "23505",
        },
      }),
    );

    const res = await addSetlistSong(makeReq({ songId: "33333333-3333-3333-3333-333333333333" }), SETLIST_ID, makeLookup("admin"));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("CONFLICT");
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/setlists/:id/songs/:songId — removeSetlistSong
// ---------------------------------------------------------------------------

describe("DELETE /api/setlists/:id/songs/:songId (removeSetlistSong)", () => {
  it("happy path: removes a middle song and recompacts remaining positions to 1..N", async () => {
    setUpAuth();
    const state = baseState(); // song-1 pos1, song-2 pos2, song-3 pos3
    mockGetSupabaseClient.mockReturnValue(makeFakeSupabase(state));

    const res = await removeSetlistSong(makeReq(), SETLIST_ID, "22222222-2222-2222-2222-222222222222", makeLookup("admin"));
    expect(res.status).toBe(200);

    const body = await res.json();
    const songs: SetlistSongResponse[] = body.data.songs;
    expect(songs).toEqual([
      { id: "ss-1", setlistId: SETLIST_ID, songId: "11111111-1111-1111-1111-111111111111", position: 1, keyOverride: "A", notes: null },
      { id: "ss-3", setlistId: SETLIST_ID, songId: "33333333-3333-3333-3333-333333333333", position: 2, keyOverride: null, notes: null },
    ]);
  });

  it("returns { songs: [] } after removing the last remaining song", async () => {
    setUpAuth();
    const state = baseState();
    state.setlistSongs = [state.setlistSongs[0]!]; // only song-1 left
    mockGetSupabaseClient.mockReturnValue(makeFakeSupabase(state));

    const res = await removeSetlistSong(makeReq(), SETLIST_ID, "11111111-1111-1111-1111-111111111111", makeLookup("admin"));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data.songs).toEqual([]);
  });

  it("returns 404 when the songId is not in the setlist", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeFakeSupabase(baseState()));

    const res = await removeSetlistSong(
      makeReq(),
      SETLIST_ID,
      "55555555-5555-5555-5555-555555555555",
      makeLookup("admin"),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });

  it("returns 404 when the setlist does not exist or belongs to another tenant", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeFakeSupabase(baseState()));

    const res = await removeSetlistSong(
      makeReq(),
      SETLIST_ID,
      "11111111-1111-1111-1111-111111111111",
      makeLookup("admin", OTHER_CHURCH_GROUP_ID),
    );
    expect(res.status).toBe(404);
  });

  it("returns 409 CONFLICT when the setlist is published", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeFakeSupabase(baseState()));

    const res = await removeSetlistSong(
      makeReq(),
      PUBLISHED_SETLIST_ID,
      "11111111-1111-1111-1111-111111111111",
      makeLookup("admin"),
    );
    expect(res.status).toBe(409);
  });

  it.each<UserRole>(["member", "guest"])("returns 403 FORBIDDEN for role = '%s'", async (role) => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeFakeSupabase(baseState()));

    const res = await removeSetlistSong(makeReq(), SETLIST_ID, "11111111-1111-1111-1111-111111111111", makeLookup(role));
    expect(res.status).toBe(403);
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 401 UNAUTHENTICATED when getToken yields no JWT", async () => {
    setUpAuth(null);

    const res = await removeSetlistSong(makeReq(), SETLIST_ID, "11111111-1111-1111-1111-111111111111", makeLookup("admin"));
    expect(res.status).toBe(401);
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 500 INTERNAL when the delete step errors", async () => {
    setUpAuth();
    const state = baseState();
    mockGetSupabaseClient.mockReturnValue(
      makeFakeSupabase(state, { setlistSongsDeleteError: { message: "connection refused" } }),
    );

    const res = await removeSetlistSong(makeReq(), SETLIST_ID, "11111111-1111-1111-1111-111111111111", makeLookup("admin"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });
});
