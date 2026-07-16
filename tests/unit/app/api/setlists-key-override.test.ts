// Tester-stage independent coverage for Issue #57 (BR-09 key-override
// validation + default-vs-override distinction, AC #4). This suite is
// deliberately separate from `setlists-songs-route.test.ts` (which is the
// Coder's maintained suite for #55/#57 response-shape updates) so that the
// AC #4 derived fields, the BR-09 400-vs-422 split, and BR-09/AC #3
// non-mutation guarantee are verified independently rather than trusting the
// Coder's own fixtures/assertions.

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({ getSupabaseClient: jest.fn() }));

import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { getSupabaseClient } from "@/lib/supabase/client";
import {
  reorderSetlist,
  addSetlistSong,
  removeSetlistSong,
  toSetlistSongResponse,
  type SetlistSongResponse,
} from "@/app/api/setlists/[id]/handler";
import type { AuthContext, UserLookup } from "@/lib/api/auth";

const mockAuth = auth as unknown as jest.Mock;
const mockGetSupabaseClient = getSupabaseClient as unknown as jest.Mock;

const JWT = "supabase-jwt";
const USER_ID = "user-1";
const CHURCH_GROUP_ID = "group-1";
const SETLIST_ID = "setlist-1";

const SONG_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"; // default_key "C"
const SONG_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"; // default_key null
const SONG_C = "cccccccc-cccc-cccc-cccc-cccccccccccc"; // default_key "G", used for add

function makeLookup(role: "admin" | "set_leader" | "member" | "guest" = "admin"): UserLookup {
  const ctx: AuthContext = { userId: USER_ID, churchGroupId: CHURCH_GROUP_ID, role };
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
// Pure unit coverage of toSetlistSongResponse (AC #4 derivation logic itself,
// independent of any DB/route plumbing).
// ---------------------------------------------------------------------------

describe("toSetlistSongResponse (AC #4 derived-field logic)", () => {
  const baseRow = {
    id: "ss-1",
    setlist_id: SETLIST_ID,
    song_id: SONG_A,
    position: 1,
    notes: null,
  };

  it("override null: isOverridden false, effectiveKey falls back to defaultKey", () => {
    const result = toSetlistSongResponse({ ...baseRow, key_override: null }, "C");
    expect(result).toEqual({
      id: "ss-1",
      setlistId: SETLIST_ID,
      songId: SONG_A,
      position: 1,
      keyOverride: null,
      defaultKey: "C",
      effectiveKey: "C",
      isOverridden: false,
      notes: null,
    });
  });

  it("override set to a value different from defaultKey: isOverridden true, effectiveKey is the override", () => {
    const result = toSetlistSongResponse({ ...baseRow, key_override: "G" }, "C");
    expect(result.isOverridden).toBe(true);
    expect(result.effectiveKey).toBe("G");
    expect(result.defaultKey).toBe("C");
    expect(result.keyOverride).toBe("G");
  });

  it("edge case: override equals defaultKey exactly — still isOverridden true (derived from non-null, not from inequality)", () => {
    const result = toSetlistSongResponse({ ...baseRow, key_override: "C" }, "C");
    expect(result.isOverridden).toBe(true);
    expect(result.effectiveKey).toBe("C");
    expect(result.defaultKey).toBe("C");
  });

  it("edge case: defaultKey null and no override — defaultKey, effectiveKey both null, isOverridden false", () => {
    const result = toSetlistSongResponse({ ...baseRow, key_override: null }, null);
    expect(result).toMatchObject({
      keyOverride: null,
      defaultKey: null,
      effectiveKey: null,
      isOverridden: false,
    });
  });

  it("edge case: defaultKey null but override set — effectiveKey is the override, isOverridden true", () => {
    const result = toSetlistSongResponse({ ...baseRow, key_override: "A" }, null);
    expect(result).toMatchObject({
      keyOverride: "A",
      defaultKey: null,
      effectiveKey: "A",
      isOverridden: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Stateful fake Supabase client — deliberately independent implementation
// from the Coder's fixture in setlists-songs-route.test.ts, so a bug that
// happens to cancel out against that file's fake wouldn't also cancel out
// here.
// ---------------------------------------------------------------------------

type AnyRow = Record<string, unknown>;
type QueryResult = { data: unknown; error: unknown };

type SetlistsRow = { id: string; church_group_id: string; status: string };
type SongsRow = { id: string; church_group_id: string; default_key: string | null };
type SetlistSongsRow = {
  id: string;
  setlist_id: string;
  song_id: string;
  position: number;
  key_override: string | null;
  notes: string | null;
};

function filterRows<T extends AnyRow>(rows: T[], filters: [string, unknown][]): T[] {
  return rows.filter((r) => filters.every(([f, v]) => r[f] === v));
}

function makeSelect<T extends AnyRow>(rows: T[]) {
  const eqFilters: [string, unknown][] = [];
  let inField: string | null = null;
  let inValues: unknown[] = [];
  let orderField: string | null = null;
  const chain: Record<string, unknown> & PromiseLike<QueryResult> = {
    eq: jest.fn((f: string, v: unknown) => {
      eqFilters.push([f, v]);
      return chain;
    }),
    in: jest.fn((f: string, values: unknown[]) => {
      inField = f;
      inValues = values;
      return chain;
    }),
    order: jest.fn((f: string) => {
      orderField = f;
      return chain;
    }),
    maybeSingle: jest.fn(async () => {
      const matched = filterRows(rows, eqFilters);
      return { data: matched[0] ?? null, error: null };
    }),
    then: (resolve: (v: QueryResult) => unknown, reject?: (e: unknown) => unknown) => {
      const run = async (): Promise<QueryResult> => {
        let matched = filterRows(rows, eqFilters);
        if (inField) {
          const field = inField;
          matched = matched.filter((r) => inValues.includes(r[field]));
        }
        if (orderField) {
          const field = orderField;
          matched = [...matched].sort(
            (a, b) => (a[field] as number) - (b[field] as number),
          );
        }
        return { data: matched, error: null };
      };
      return run().then(resolve, reject);
    },
  } as unknown as Record<string, unknown> & PromiseLike<QueryResult>;
  return chain;
}

function makeUpdate(rows: SetlistSongsRow[], patch: AnyRow) {
  const filters: [string, unknown][] = [];
  const chain: Record<string, unknown> & PromiseLike<QueryResult> = {
    eq: jest.fn((f: string, v: unknown) => {
      filters.push([f, v]);
      return chain;
    }),
    then: (resolve: (v: QueryResult) => unknown, reject?: (e: unknown) => unknown) => {
      const run = async (): Promise<QueryResult> => {
        for (const row of filterRows(rows, filters)) Object.assign(row, patch);
        return { data: null, error: null };
      };
      return run().then(resolve, reject);
    },
  } as unknown as Record<string, unknown> & PromiseLike<QueryResult>;
  return chain;
}

function makeDelete(rows: SetlistSongsRow[]) {
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
        const matched = filterRows(rows, filters);
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
function makeInsert(rows: SetlistSongsRow[], payload: AnyRow) {
  return {
    then: (resolve: (v: QueryResult) => unknown, reject?: (e: unknown) => unknown) => {
      const run = async (): Promise<QueryResult> => {
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

function makeFakeSupabase(state: FakeState, tableCallCounts?: Record<string, number>) {
  return {
    from: jest.fn((table: string) => {
      if (tableCallCounts) {
        tableCallCounts[table] = (tableCallCounts[table] ?? 0) + 1;
      }
      if (table === "setlists") {
        return { select: jest.fn(() => makeSelect(state.setlists)) };
      }
      if (table === "songs") {
        return { select: jest.fn(() => makeSelect(state.songs)) };
      }
      if (table === "setlist_songs") {
        return {
          select: jest.fn(() => makeSelect(state.setlistSongs)),
          update: jest.fn((patch: AnyRow) => makeUpdate(state.setlistSongs, patch)),
          delete: jest.fn(() => makeDelete(state.setlistSongs)),
          insert: jest.fn((payload: AnyRow) => makeInsert(state.setlistSongs, payload)),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    }),
  };
}

function baseState(): FakeState {
  return {
    setlists: [{ id: SETLIST_ID, church_group_id: CHURCH_GROUP_ID, status: "draft" }],
    songs: [
      { id: SONG_A, church_group_id: CHURCH_GROUP_ID, default_key: "C" },
      { id: SONG_B, church_group_id: CHURCH_GROUP_ID, default_key: null },
      { id: SONG_C, church_group_id: CHURCH_GROUP_ID, default_key: "G" },
    ],
    setlistSongs: [
      { id: "ss-a", setlist_id: SETLIST_ID, song_id: SONG_A, position: 1, key_override: null, notes: null },
      { id: "ss-b", setlist_id: SETLIST_ID, song_id: SONG_B, position: 2, key_override: null, notes: null },
    ],
  };
}

// ---------------------------------------------------------------------------
// AC #4 through the actual route handlers (integration-style, exercising the
// full loadSongResponses join).
// ---------------------------------------------------------------------------

describe("AC #4: default-vs-override distinction via the route handlers", () => {
  it("PUT reorder: overriding a song's key to the SAME value as its default still reports isOverridden: true", async () => {
    setUpAuth();
    const state = baseState();
    mockGetSupabaseClient.mockReturnValue(makeFakeSupabase(state));

    const res = await reorderSetlist(
      makeReq({
        songs: [
          { songId: SONG_A, keyOverride: "C" }, // same as song A's default_key "C"
          { songId: SONG_B },
        ],
      }),
      SETLIST_ID,
      makeLookup("admin"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const songs: SetlistSongResponse[] = body.data.songs;
    const songARes = songs.find((s) => s.songId === SONG_A)!;
    expect(songARes.keyOverride).toBe("C");
    expect(songARes.defaultKey).toBe("C");
    expect(songARes.effectiveKey).toBe("C");
    expect(songARes.isOverridden).toBe(true);
  });

  it("PUT reorder: a song with default_key null and no override reports defaultKey/effectiveKey null, isOverridden false", async () => {
    setUpAuth();
    const state = baseState();
    mockGetSupabaseClient.mockReturnValue(makeFakeSupabase(state));

    const res = await reorderSetlist(
      makeReq({ songs: [{ songId: SONG_A }, { songId: SONG_B }] }),
      SETLIST_ID,
      makeLookup("admin"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const songs: SetlistSongResponse[] = body.data.songs;
    const songBRes = songs.find((s) => s.songId === SONG_B)!;
    expect(songBRes).toMatchObject({
      keyOverride: null,
      defaultKey: null,
      effectiveKey: null,
      isOverridden: false,
    });
  });

  it("AC #3: an override never mutates songs.default_key in the catalog", async () => {
    setUpAuth();
    const state = baseState();
    mockGetSupabaseClient.mockReturnValue(makeFakeSupabase(state));

    const res = await reorderSetlist(
      makeReq({ songs: [{ songId: SONG_A, keyOverride: "F#" }, { songId: SONG_B, keyOverride: "Bb" }] }),
      SETLIST_ID,
      makeLookup("admin"),
    );
    expect(res.status).toBe(200);

    // The catalog rows themselves must be untouched.
    const songARow = state.songs.find((s) => s.id === SONG_A)!;
    const songBRow = state.songs.find((s) => s.id === SONG_B)!;
    expect(songARow.default_key).toBe("C");
    expect(songBRow.default_key).toBe(null);

    // And the response still reports the catalog default_key, not the
    // override, in the defaultKey field.
    const body = await res.json();
    const songs: SetlistSongResponse[] = body.data.songs;
    expect(songs.find((s) => s.songId === SONG_A)!.defaultKey).toBe("C");
    expect(songs.find((s) => s.songId === SONG_B)!.defaultKey).toBe(null);
  });

  it("POST add: happy path reports correct defaultKey/effectiveKey/isOverridden for the newly added song", async () => {
    setUpAuth();
    insertCounter = 0;
    const state = baseState();
    mockGetSupabaseClient.mockReturnValue(makeFakeSupabase(state));

    const res = await addSetlistSong(
      makeReq({ songId: SONG_C, keyOverride: "D" }),
      SETLIST_ID,
      makeLookup("set_leader"),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    const songs: SetlistSongResponse[] = body.data.songs;
    const added = songs.find((s) => s.songId === SONG_C)!;
    expect(added).toMatchObject({
      keyOverride: "D",
      defaultKey: "G",
      effectiveKey: "D",
      isOverridden: true,
    });
  });

  it("DELETE remove: after removing the last remaining song, returns { songs: [] } and never queries the songs table", async () => {
    setUpAuth();
    const state = baseState();
    state.setlistSongs = [state.setlistSongs[0]!]; // leave only song A
    const tableCallCounts: Record<string, number> = {};
    mockGetSupabaseClient.mockReturnValue(makeFakeSupabase(state, tableCallCounts));

    const res = await removeSetlistSong(makeReq(), SETLIST_ID, SONG_A, makeLookup("admin"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.songs).toEqual([]);
    expect(tableCallCounts["songs"] ?? 0).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC #2 / BR-09 independent verification: 400 for malformed body, 422 for a
// shape-valid but non-musical keyOverride, for both PUT and POST.
// ---------------------------------------------------------------------------

describe("BR-09 independent verification (AC #2)", () => {
  it("PUT /api/setlists/:id: malformed JSON body -> 400 VALIDATION_FAILED, no DB call", async () => {
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

  it("PUT /api/setlists/:id: shape-valid but non-musical keyOverride -> 422, no DB mutation", async () => {
    setUpAuth();
    const state = baseState();
    mockGetSupabaseClient.mockReturnValue(makeFakeSupabase(state));

    const res = await reorderSetlist(
      makeReq({ songs: [{ songId: SONG_A, keyOverride: "H" }, { songId: SONG_B }] }),
      SETLIST_ID,
      makeLookup("admin"),
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
    // No mutation occurred: song A's key_override is still null in the fake state.
    expect(state.setlistSongs.find((r) => r.song_id === SONG_A)!.key_override).toBe(null);
  });

  it("POST /api/setlists/:id/songs: malformed body (missing songId) -> 400", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeFakeSupabase(baseState()));

    const res = await addSetlistSong(makeReq({ keyOverride: "C" }), SETLIST_ID, makeLookup("admin"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("POST /api/setlists/:id/songs: shape-valid but non-musical keyOverride -> 422, nothing inserted", async () => {
    setUpAuth();
    const state = baseState();
    mockGetSupabaseClient.mockReturnValue(makeFakeSupabase(state));
    const initialCount = state.setlistSongs.length;

    const res = await addSetlistSong(
      makeReq({ songId: SONG_C, keyOverride: "Zz" }),
      SETLIST_ID,
      makeLookup("admin"),
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(state.setlistSongs).toHaveLength(initialCount);
  });

  it("PUT accepts a valid unicode-accidental key value (BR-09 accepts both spellings)", async () => {
    setUpAuth();
    const state = baseState();
    mockGetSupabaseClient.mockReturnValue(makeFakeSupabase(state));

    const res = await reorderSetlist(
      makeReq({ songs: [{ songId: SONG_A, keyOverride: "F♯" }, { songId: SONG_B }] }),
      SETLIST_ID,
      makeLookup("admin"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const songs: SetlistSongResponse[] = body.data.songs;
    expect(songs.find((s) => s.songId === SONG_A)!.keyOverride).toBe("F♯");
  });
});

// ---------------------------------------------------------------------------
// Failure case: internal error from the songs lookup surfaces as 500, not a
// silent partial response.
// ---------------------------------------------------------------------------

describe("Failure case: songs table lookup error surfaces as 500", () => {
  it("PUT reorder returns 500 INTERNAL when the post-update songs join query fails", async () => {
    setUpAuth();
    const state = baseState();
    const fake = makeFakeSupabase(state);
    // Force the *second* `from("songs")` call (the loadSongResponses join, not
    // the setlists table) to error by overriding songs.select once the update
    // has already happened. We do this by monkeypatching the fake's songs
    // table select to return an error after the setlist_songs update runs.
    const originalFrom = fake.from;
    let updateHappened = false;
    (fake.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "setlist_songs") {
        const real = originalFrom(table) as {
          select: jest.Mock;
          update: jest.Mock;
          delete: jest.Mock;
          insert: jest.Mock;
        };
        const wrappedUpdate = jest.fn((patch: AnyRow) => {
          updateHappened = true;
          return real.update(patch);
        });
        return { ...real, update: wrappedUpdate };
      }
      if (table === "songs" && updateHappened) {
        return {
          select: jest.fn(() => ({
            in: jest.fn(() => Promise.resolve({ data: null, error: { message: "boom" } })),
          })),
        };
      }
      return originalFrom(table);
    });
    mockGetSupabaseClient.mockReturnValue(fake);

    const res = await reorderSetlist(
      makeReq({ songs: [{ songId: SONG_A }, { songId: SONG_B }] }),
      SETLIST_ID,
      makeLookup("admin"),
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });
});
