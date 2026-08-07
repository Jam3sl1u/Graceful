jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({ getSupabaseClient: jest.fn() }));

import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { getSupabaseClient } from "@/lib/supabase/client";
import { listSongs, createSong, type SongResponse } from "@/app/api/songs/handler";
import type { AuthContext, UserLookup } from "@/lib/api/auth";
import type { UserRole } from "@/types/domain";

const mockAuth = auth as unknown as jest.Mock;
const mockGetSupabaseClient = getSupabaseClient as unknown as jest.Mock;

const JWT = "supabase-jwt";
const USER_ID = "user-1";
const CHURCH_GROUP_ID = "group-1";

function makeReq(query: Record<string, string> = {}, body?: unknown): NextRequest {
  const searchParams = new URLSearchParams(query);
  return {
    nextUrl: { searchParams },
    json: jest.fn().mockResolvedValue(body),
  } as unknown as NextRequest;
}

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

type QueryResult = { data: unknown; error: unknown };
type TableFixture = {
  select?: QueryResult;
  insert?: QueryResult;
};

const defaultSongRows = [
  {
    id: "song-1",
    title: "Amazing Grace",
    artist: "Traditional",
    default_key: "C",
    bpm: 72,
    tags: ["hymn"],
    created_by: "user-2",
    created_at: "2026-07-01T00:00:00.000Z",
  },
  {
    id: "song-2",
    title: "How Great Thou Art",
    artist: null,
    default_key: null,
    bpm: null,
    tags: null,
    created_by: null,
    created_at: "2026-07-02T00:00:00.000Z",
  },
];

const DEFAULT_FIXTURES: Record<string, Required<TableFixture>> = {
  songs: {
    select: { data: defaultSongRows, error: null },
    insert: {
      data: {
        id: "song-new",
        title: "New Song",
        artist: null,
        default_key: null,
        bpm: null,
        tags: null,
        created_by: USER_ID,
        created_at: "2026-07-10T00:00:00.000Z",
      },
      error: null,
    },
  },
};

// Generic chainable mock covering:
//   .select(...).eq(...).or(...).order(...)   (list, with search)
//   .select(...).eq(...).order(...)           (list, no search)
//   .insert(...).select(...).single()
function makeChain(result: QueryResult) {
  const chain: Record<string, unknown> & PromiseLike<QueryResult> = {
    eq: jest.fn(() => chain),
    or: jest.fn(() => chain),
    order: jest.fn(() => chain),
    select: jest.fn(() => chain),
    single: jest.fn(() => Promise.resolve(result)),
    then: (resolve: (value: QueryResult) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  } as unknown as Record<string, unknown> & PromiseLike<QueryResult>;
  return chain;
}

function makeSupabaseClient(
  overrides: Partial<Record<string, TableFixture>> = {},
  hooks?: {
    onInsert?: (table: string, payload: unknown) => void;
  },
) {
  const fixtures: Record<string, Required<TableFixture>> = {};
  for (const table of Object.keys(DEFAULT_FIXTURES)) {
    const base = DEFAULT_FIXTURES[table]!;
    const override = overrides[table] ?? {};
    fixtures[table] = {
      select: override.select ?? base.select,
      insert: override.insert ?? base.insert,
    };
  }

  return {
    from: jest.fn((table: string) => {
      const tableFixture = fixtures[table]!;
      return {
        select: jest.fn(() => makeChain(tableFixture.select)),
        insert: jest.fn((payload: unknown) => {
          hooks?.onInsert?.(table, payload);
          return makeChain(tableFixture.insert);
        }),
      };
    }),
  };
}

beforeEach(() => {
  mockAuth.mockReset();
  mockGetSupabaseClient.mockReset();
});

describe("GET /api/songs", () => {
  it("returns 200 with all songs in the group, ordered by title, tags null -> []", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await listSongs(makeReq(), makeLookup("member"));
    expect(res.status).toBe(200);

    const body = await res.json();
    const songs: SongResponse[] = body.data.songs;
    expect(songs).toEqual([
      {
        id: "song-1",
        title: "Amazing Grace",
        artist: "Traditional",
        defaultKey: "C",
        bpm: 72,
        tags: ["hymn"],
        createdBy: "user-2",
        createdAt: "2026-07-01T00:00:00.000Z",
      },
      {
        id: "song-2",
        title: "How Great Thou Art",
        artist: null,
        defaultKey: null,
        bpm: null,
        tags: [],
        createdBy: null,
        createdAt: "2026-07-02T00:00:00.000Z",
      },
    ]);
  });

  it("applies a case-insensitive partial match filter when q is present", async () => {
    setUpAuth();
    const client = makeSupabaseClient();
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await listSongs(makeReq({ q: "amaz" }), makeLookup("member"));
    expect(res.status).toBe(200);

    const fromResult = client.from.mock.results[0]!.value;
    const selectChain = fromResult.select.mock.results[0]!.value;
    expect(selectChain.or).toHaveBeenCalledWith('title.ilike."%amaz%",artist.ilike."%amaz%"');
  });

  it("treats an empty q as no filter", async () => {
    setUpAuth();
    const client = makeSupabaseClient();
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await listSongs(makeReq({ q: "" }), makeLookup("member"));
    expect(res.status).toBe(200);

    const fromResult = client.from.mock.results[0]!.value;
    const selectChain = fromResult.select.mock.results[0]!.value;
    expect(selectChain.or).not.toHaveBeenCalled();
  });

  it("returns 200 with an empty array when the group has no songs", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({ songs: { select: { data: [], error: null } } }),
    );

    const res = await listSongs(makeReq(), makeLookup("member"));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data.songs).toEqual([]);
  });

  it("returns 403 FORBIDDEN for a guest", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await listSongs(makeReq(), makeLookup("guest"));
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.code).toBe("FORBIDDEN");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 401 UNAUTHENTICATED when getToken yields no JWT", async () => {
    setUpAuth(null);

    const res = await listSongs(makeReq(), makeLookup("member"));
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 500 INTERNAL when the query errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        songs: { select: { data: null, error: { message: "connection refused" } } },
      }),
    );

    const res = await listSongs(makeReq(), makeLookup("member"));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });
});

describe("POST /api/songs", () => {
  it("returns 201 for a valid minimal body with optional fields omitted and tags []", async () => {
    setUpAuth();
    let capturedPayload: unknown;
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({}, { onInsert: (table, payload) => (capturedPayload = payload) }),
    );

    const res = await createSong(makeReq({}, { title: "New Song" }), makeLookup("admin"));
    expect(res.status).toBe(201);

    const body = await res.json();
    const song: SongResponse = body.data.song;
    expect(song.artist).toBeNull();
    expect(song.defaultKey).toBeNull();
    expect(song.bpm).toBeNull();
    expect(song.tags).toEqual([]);
    expect(capturedPayload).toMatchObject({
      church_group_id: CHURCH_GROUP_ID,
      title: "New Song",
      artist: null,
      default_key: null,
      bpm: null,
      tags: null,
      created_by: USER_ID,
    });
  });

  it("returns 201 when optional fields are explicitly null", async () => {
    setUpAuth();
    let capturedPayload: unknown;
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({}, { onInsert: (table, payload) => (capturedPayload = payload) }),
    );

    const res = await createSong(
      makeReq(
        {},
        {
          title: "New Song",
          artist: null,
          default_key: null,
          bpm: null,
          tags: null,
        },
      ),
      makeLookup("admin"),
    );
    expect(res.status).toBe(201);

    const body = await res.json();
    const song: SongResponse = body.data.song;
    expect(song.artist).toBeNull();
    expect(song.defaultKey).toBeNull();
    expect(song.bpm).toBeNull();
    expect(song.tags).toEqual([]);
    expect(capturedPayload).toMatchObject({
      artist: null,
      default_key: null,
      bpm: null,
      tags: null,
    });
  });

  it.each(["C#", "Bb"])("returns 201 for a valid ASCII default_key %s", async (key) => {
    setUpAuth();
    let capturedPayload: unknown;
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({}, { onInsert: (table, payload) => (capturedPayload = payload) }),
    );

    const res = await createSong(
      makeReq({}, { title: "New Song", default_key: key }),
      makeLookup("set_leader"),
    );
    expect(res.status).toBe(201);
    expect(capturedPayload).toMatchObject({ default_key: key });
  });

  it("returns 201 for a valid Unicode default_key D♭", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await createSong(
      makeReq({}, { title: "New Song", default_key: "D♭" }),
      makeLookup("admin"),
    );
    expect(res.status).toBe(201);
  });

  it.each(["H", "c#", "Cmaj", "Z", "bb"])(
    "returns 422 VALIDATION_FAILED for an invalid default_key %s (BR-09)",
    async (key) => {
      setUpAuth();
      mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

      const res = await createSong(
        makeReq({}, { title: "New Song", default_key: key }),
        makeLookup("admin"),
      );
      expect(res.status).toBe(422);

      const body = await res.json();
      expect(body.code).toBe("VALIDATION_FAILED");
    },
  );

  it("returns 400 VALIDATION_FAILED for a missing/empty/whitespace title", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await createSong(makeReq({}, { title: "   " }), makeLookup("admin"));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("returns 400 for a title longer than 200 chars", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await createSong(
      makeReq({}, { title: "A".repeat(201) }),
      makeLookup("admin"),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for an artist longer than 200 chars, and 201 when artist is omitted", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const tooLong = await createSong(
      makeReq({}, { title: "New Song", artist: "A".repeat(201) }),
      makeLookup("admin"),
    );
    expect(tooLong.status).toBe(400);

    const omitted = await createSong(makeReq({}, { title: "New Song" }), makeLookup("admin"));
    expect(omitted.status).toBe(201);
  });

  it("returns 400 for bpm that is non-integer, <= 0, or > 400; 201 when omitted", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    for (const bpm of [1.5, 0, -10, 401]) {
      const res = await createSong(makeReq({}, { title: "New Song", bpm }), makeLookup("admin"));
      expect(res.status).toBe(400);
    }

    const omitted = await createSong(makeReq({}, { title: "New Song" }), makeLookup("admin"));
    expect(omitted.status).toBe(201);
  });

  it("returns 400 for tags that are not an array or contain non-string elements; 201 for tags: []", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const notArray = await createSong(
      makeReq({}, { title: "New Song", tags: "hymn" }),
      makeLookup("admin"),
    );
    expect(notArray.status).toBe(400);

    const badElement = await createSong(
      makeReq({}, { title: "New Song", tags: [1, 2] }),
      makeLookup("admin"),
    );
    expect(badElement.status).toBe(400);

    const emptyArray = await createSong(
      makeReq({}, { title: "New Song", tags: [] }),
      makeLookup("admin"),
    );
    expect(emptyArray.status).toBe(201);
  });

  it("returns 400 VALIDATION_FAILED for a missing/malformed body", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await createSong(makeReq({}, null), makeLookup("admin"));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it.each<UserRole>(["member", "guest"])(
    "returns 403 FORBIDDEN for role = '%s'",
    async (role) => {
      setUpAuth();
      mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

      const res = await createSong(makeReq({}, { title: "New Song" }), makeLookup(role));
      expect(res.status).toBe(403);

      const body = await res.json();
      expect(body.code).toBe("FORBIDDEN");
      expect(mockGetSupabaseClient).not.toHaveBeenCalled();
    },
  );

  it.each<UserRole>(["admin", "set_leader"])("allows role = '%s'", async (role) => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await createSong(makeReq({}, { title: "New Song" }), makeLookup(role));
    expect(res.status).toBe(201);
  });

  it("returns 401 UNAUTHENTICATED when getToken yields no JWT", async () => {
    setUpAuth(null);

    const res = await createSong(makeReq({}, { title: "New Song" }), makeLookup("admin"));
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 500 INTERNAL when the insert errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        songs: { insert: { data: null, error: { message: "constraint violation" } } },
      }),
    );

    const res = await createSong(makeReq({}, { title: "New Song" }), makeLookup("admin"));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });
});
