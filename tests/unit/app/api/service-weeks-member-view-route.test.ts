jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({ getSupabaseClient: jest.fn() }));
jest.mock("@/lib/r2/client", () => ({ getDownloadUrl: jest.fn() }));

import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { getSupabaseClient } from "@/lib/supabase/client";
import { getDownloadUrl } from "@/lib/r2/client";
import {
  getMemberWeekView,
  type MemberWeekViewResponse,
} from "@/app/api/service-weeks/[id]/member-view/handler";
import type { AuthContext, UserLookup } from "@/lib/api/auth";
import type { UserRole } from "@/types/domain";

const mockAuth = auth as unknown as jest.Mock;
const mockGetSupabaseClient = getSupabaseClient as unknown as jest.Mock;
const mockGetDownloadUrl = getDownloadUrl as unknown as jest.Mock;

const JWT = "supabase-jwt";
const USER_ID = "user-1";
const OTHER_USER_ID = "user-2";
const CHURCH_GROUP_ID = "group-1";
const WEEK_ID = "week-1";
const SETLIST_ID = "setlist-1";
const SONG_ID_1 = "song-1";
const SONG_ID_2 = "song-2";
const EVENT_ID_1 = "event-1";
const EVENT_ID_2 = "event-2";

const fakeReq = {} as NextRequest;

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

// Generic chainable mock — every method returns `chain` itself (so any
// combination of .eq/.in/.order/.is can be called in any order), and the
// chain is thenable so `await`-ing it (or `.maybeSingle()`) yields `result`.
function makeChain(result: QueryResult) {
  const chain: Record<string, unknown> & PromiseLike<QueryResult> = {
    eq: jest.fn(() => chain),
    in: jest.fn(() => chain),
    is: jest.fn(() => chain),
    order: jest.fn(() => chain),
    limit: jest.fn(() => chain),
    select: jest.fn(() => chain),
    maybeSingle: jest.fn(() => Promise.resolve(result)),
    then: (resolve: (value: QueryResult) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  } as unknown as Record<string, unknown> & PromiseLike<QueryResult>;
  return chain;
}

const weekRow = {
  id: WEEK_ID,
  service_date: "2026-07-19",
  title: "Sunday Service",
  is_cancelled: false,
};

const publishedSetlistRow = { id: SETLIST_ID, status: "published" };
const draftSetlistRow = { id: SETLIST_ID, status: "draft" };

const setlistSongRows = [
  { song_id: SONG_ID_1, position: 1, key_override: "D" },
  { song_id: SONG_ID_2, position: 2, key_override: null },
];

const songRows = [
  { id: SONG_ID_1, title: "Song One", artist: "Artist One", default_key: "C" },
  { id: SONG_ID_2, title: "Song Two", artist: null, default_key: "G" },
];

const eventRows = [
  {
    id: EVENT_ID_1,
    type: "rehearsal",
    name: "Rehearsal",
    location: "123 Main St",
    start_time: "2026-07-18T18:00:00Z",
    end_time: "2026-07-18T19:00:00Z",
    notes: null,
  },
  {
    id: EVENT_ID_2,
    type: "service",
    name: "Sunday Service",
    location: null,
    start_time: "2026-07-19T09:00:00Z",
    end_time: "2026-07-19T10:30:00Z",
    notes: "Bring extra cables",
  },
];

const attendeeRows = [
  { event_id: EVENT_ID_1, user_id: USER_ID },
  { event_id: EVENT_ID_2, user_id: USER_ID },
  { event_id: EVENT_ID_2, user_id: OTHER_USER_ID },
];

const userRows = [
  { id: USER_ID, name: "Zoe Caller", role: "member" },
  { id: OTHER_USER_ID, name: "Amy Other", role: "member" },
];

const memberProfileRows = [{ id: "profile-2", user_id: OTHER_USER_ID, vocal_capability: "lead" }];

const memberInstrumentRows = [{ member_profile_id: "profile-2", instrument_id: "instr-1" }];

const instrumentRows = [{ id: "instr-1", name: "Guitar" }];

const docRows = [
  {
    id: "doc-1",
    song_id: SONG_ID_1,
    name: "Chart.pdf",
    file_key: `song-documents/${CHURCH_GROUP_ID}/${SONG_ID_1}/uuid-1/Chart.pdf`,
    file_type: "application/pdf",
    file_size_bytes: 1024,
  },
];

type Fixtures = {
  service_weeks: QueryResult;
  invitations: QueryResult;
  setlists: QueryResult;
  setlist_songs: QueryResult;
  songs: QueryResult;
  events: QueryResult;
  event_attendees: QueryResult;
  users: QueryResult;
  member_profiles: QueryResult;
  member_instruments: QueryResult;
  instruments: QueryResult;
  song_documents: QueryResult;
};

const DEFAULT_FIXTURES: Fixtures = {
  service_weeks: { data: weekRow, error: null },
  invitations: { data: [{ status: "accepted", created_at: "2026-07-10T00:00:00Z" }], error: null },
  setlists: { data: publishedSetlistRow, error: null },
  setlist_songs: { data: setlistSongRows, error: null },
  songs: { data: songRows, error: null },
  events: { data: eventRows, error: null },
  event_attendees: { data: attendeeRows, error: null },
  users: { data: userRows, error: null },
  member_profiles: { data: memberProfileRows, error: null },
  member_instruments: { data: memberInstrumentRows, error: null },
  instruments: { data: instrumentRows, error: null },
  song_documents: { data: docRows, error: null },
};

function makeSupabaseClient(overrides: Partial<Fixtures> = {}) {
  const fixtures: Fixtures = { ...DEFAULT_FIXTURES, ...overrides };
  const fromSpy = jest.fn((table: keyof Fixtures) => {
    if (!(table in fixtures)) {
      throw new Error(`Unexpected table: ${table}`);
    }
    return {
      select: jest.fn(() => makeChain(fixtures[table])),
    };
  });
  return { from: fromSpy };
}

beforeEach(() => {
  mockAuth.mockReset();
  mockGetSupabaseClient.mockReset();
  mockGetDownloadUrl.mockReset();
  mockGetDownloadUrl.mockResolvedValue("https://r2.example/download-signed");
});

describe("GET /api/service-weeks/:id/member-view", () => {
  it("returns 401 UNAUTHENTICATED when Clerk userId is null (lookup never consulted)", async () => {
    mockAuth.mockResolvedValue({ userId: null, getToken: jest.fn() });
    const lookup = jest.fn();

    const res = await getMemberWeekView(fakeReq, WEEK_ID, lookup as unknown as UserLookup);
    expect(res.status).toBe(401);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("returns 401 UNAUTHENTICATED when getToken yields no JWT", async () => {
    setUpAuth(null);

    const res = await getMemberWeekView(fakeReq, WEEK_ID, makeLookup("member"));
    expect(res.status).toBe(401);
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it.each<UserRole>(["admin", "set_leader", "member"])(
    "allows role = '%s'",
    async (role) => {
      setUpAuth();
      mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

      const res = await getMemberWeekView(fakeReq, WEEK_ID, makeLookup(role));
      expect(res.status).toBe(200);
    },
  );

  it("returns 404 NOT_FOUND when the service week is missing / other tenant", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({ service_weeks: { data: null, error: null } }),
    );

    const res = await getMemberWeekView(fakeReq, WEEK_ID, makeLookup("member"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });

  it("returns 500 INTERNAL when the service_weeks query errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        service_weeks: { data: null, error: { message: "connection refused" } },
      }),
    );

    const res = await getMemberWeekView(fakeReq, WEEK_ID, makeLookup("member"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });

  it("happy path: returns the full aggregate payload", async () => {
    setUpAuth();
    const client = makeSupabaseClient();
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await getMemberWeekView(fakeReq, WEEK_ID, makeLookup("member"));
    expect(res.status).toBe(200);
    const body = await res.json();
    const data: MemberWeekViewResponse = body.data;

    expect(data.serviceWeek).toEqual({
      id: WEEK_ID,
      serviceDate: "2026-07-19",
      title: "Sunday Service",
      isCancelled: false,
    });
    expect(data.confirmationStatus).toBe("accepted");

    expect(data.setlist).toEqual({
      status: "published",
      songs: [
        { songId: SONG_ID_1, title: "Song One", artist: "Artist One", position: 1, effectiveKey: "D" },
        { songId: SONG_ID_2, title: "Song Two", artist: null, position: 2, effectiveKey: "G" },
      ],
    });

    // Both events returned; assigned reflects the caller's own attendee rows.
    expect(data.events).toHaveLength(2);
    expect(data.events.every((e) => e.assigned)).toBe(true);

    // Team reflects the full attendee set (caller + other user), sorted by name.
    expect(data.team.map((m) => m.userId)).toEqual([OTHER_USER_ID, USER_ID]);
    const other = data.team.find((m) => m.userId === OTHER_USER_ID)!;
    expect(other.instruments).toEqual([{ id: "instr-1", name: "Guitar" }]);
    expect(other.vocalCapability).toBe("lead");
    const caller = data.team.find((m) => m.userId === USER_ID)!;
    expect(caller.vocalCapability).toBe("none");
    expect(caller.instruments).toEqual([]);

    expect(data.documents).toEqual([
      {
        songId: SONG_ID_1,
        songTitle: "Song One",
        files: [
          {
            id: "doc-1",
            name: "Chart.pdf",
            fileType: "application/pdf",
            fileSizeBytes: 1024,
            downloadUrl: "https://r2.example/download-signed",
          },
        ],
      },
    ]);
    expect(JSON.stringify(data)).not.toContain("file_key");
    expect(mockGetDownloadUrl).toHaveBeenCalledWith(docRows[0]!.file_key);
  });

  it("picks the latest invitation by created_at when multiple rows exist", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        invitations: {
          data: [
            { status: "denied", created_at: "2026-07-01T00:00:00Z" },
            { status: "accepted", created_at: "2026-07-15T00:00:00Z" },
          ],
          error: null,
        },
      }),
    );

    const res = await getMemberWeekView(fakeReq, WEEK_ID, makeLookup("member"));
    const body = await res.json();
    expect(body.data.confirmationStatus).toBe("accepted");
  });

  it("confirmationStatus is null when the caller has no invitation for the week", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({ invitations: { data: [], error: null } }),
    );

    const res = await getMemberWeekView(fakeReq, WEEK_ID, makeLookup("member"));
    const body = await res.json();
    expect(body.data.confirmationStatus).toBeNull();
    expect(res.status).toBe(200);
  });

  it("setlist is null when there is no setlist row", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({ setlists: { data: null, error: null } }),
    );

    const res = await getMemberWeekView(fakeReq, WEEK_ID, makeLookup("member"));
    const body = await res.json();
    expect(body.data.setlist).toBeNull();
  });

  it("setlist is null when the setlist row is a draft (defense in depth beyond RLS)", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({ setlists: { data: draftSetlistRow, error: null } }),
    );

    const res = await getMemberWeekView(fakeReq, WEEK_ID, makeLookup("member"));
    const body = await res.json();
    expect(body.data.setlist).toBeNull();
  });

  it("published setlist with zero songs returns { status: 'published', songs: [] }, not null", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({ setlist_songs: { data: [], error: null } }),
    );

    const res = await getMemberWeekView(fakeReq, WEEK_ID, makeLookup("member"));
    const body = await res.json();
    expect(body.data.setlist).toEqual({ status: "published", songs: [] });
  });

  it("effectiveKey falls back to null when both key_override and default_key are null", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        setlist_songs: { data: [{ song_id: SONG_ID_1, position: 1, key_override: null }], error: null },
        songs: { data: [{ id: SONG_ID_1, title: "Song One", artist: null, default_key: null }], error: null },
      }),
    );

    const res = await getMemberWeekView(fakeReq, WEEK_ID, makeLookup("member"));
    const body = await res.json();
    expect(body.data.setlist.songs[0].effectiveKey).toBeNull();
  });

  it("week with no events: events is [], team is [], and the event_attendees query is skipped entirely", async () => {
    setUpAuth();
    const client = makeSupabaseClient({ events: { data: [], error: null } });
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await getMemberWeekView(fakeReq, WEEK_ID, makeLookup("member"));
    const body = await res.json();
    expect(body.data.events).toEqual([]);
    expect(body.data.team).toEqual([]);
    expect(client.from).not.toHaveBeenCalledWith("event_attendees");
    expect(client.from).not.toHaveBeenCalledWith("users");
  });

  it("member assigned to only some events: only those are flagged assigned, but team reflects the full attendee set", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        event_attendees: {
          data: [
            { event_id: EVENT_ID_1, user_id: OTHER_USER_ID },
            { event_id: EVENT_ID_2, user_id: USER_ID },
          ],
          error: null,
        },
      }),
    );

    const res = await getMemberWeekView(fakeReq, WEEK_ID, makeLookup("member"));
    const body = await res.json();
    const byId = Object.fromEntries(body.data.events.map((e: { id: string; assigned: boolean }) => [e.id, e.assigned]));
    expect(byId[EVENT_ID_1]).toBe(false);
    expect(byId[EVENT_ID_2]).toBe(true);
    expect(body.data.team.map((m: { userId: string }) => m.userId).sort()).toEqual(
      [USER_ID, OTHER_USER_ID].sort(),
    );
  });

  it("cancelled week: isCancelled is true on the serviceWeek summary", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        service_weeks: { data: { ...weekRow, is_cancelled: true }, error: null },
      }),
    );

    const res = await getMemberWeekView(fakeReq, WEEK_ID, makeLookup("member"));
    const body = await res.json();
    expect(body.data.serviceWeek.isCancelled).toBe(true);
  });

  it("documents degrade to [] with a 200 when getDownloadUrl throws (R2 misconfiguration)", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());
    mockGetDownloadUrl.mockRejectedValue(new Error("R2 not configured"));

    const res = await getMemberWeekView(fakeReq, WEEK_ID, makeLookup("member"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.documents).toEqual([]);
  });

  it("documents is [] when the setlist has no songs (documents query skipped)", async () => {
    setUpAuth();
    const client = makeSupabaseClient({ setlist_songs: { data: [], error: null } });
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await getMemberWeekView(fakeReq, WEEK_ID, makeLookup("member"));
    const body = await res.json();
    expect(body.data.documents).toEqual([]);
    expect(client.from).not.toHaveBeenCalledWith("song_documents");
  });

  it("returns 500 INTERNAL when the events query errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({ events: { data: null, error: { message: "connection refused" } } }),
    );

    const res = await getMemberWeekView(fakeReq, WEEK_ID, makeLookup("member"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });

  // #72: guest role variant.
  describe("guest role", () => {
    it("guest with an accepted invitation for this week gets 200", async () => {
      setUpAuth();
      mockGetSupabaseClient.mockReturnValue(
        makeSupabaseClient({
          invitations: {
            data: [{ status: "accepted", created_at: "2026-07-10T00:00:00Z" }],
            error: null,
          },
        }),
      );

      const res = await getMemberWeekView(fakeReq, WEEK_ID, makeLookup("guest"));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.confirmationStatus).toBe("accepted");
    });

    it("guest with only a denied invitation for this week gets 404 (not 403)", async () => {
      setUpAuth();
      // This mock ignores query args (it can't distinguish guestHasWeekAccess's
      // `.in("status", GUEST_ACCESS_STATUSES)` filter from any other select on
      // this table), so the fixture models the already-filtered result a real
      // denied-only invitation would produce: zero rows. The access check runs
      // and short-circuits before the (never-reached) confirmationStatus query
      // against this same table would matter.
      mockGetSupabaseClient.mockReturnValue(
        makeSupabaseClient({
          invitations: { data: [], error: null },
        }),
      );

      const res = await getMemberWeekView(fakeReq, WEEK_ID, makeLookup("guest"));
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.code).toBe("NOT_FOUND");
    });

    it("guest with no invitation for this week gets 404", async () => {
      setUpAuth();
      mockGetSupabaseClient.mockReturnValue(
        makeSupabaseClient({ invitations: { data: [], error: null } }),
      );

      const res = await getMemberWeekView(fakeReq, WEEK_ID, makeLookup("guest"));
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.code).toBe("NOT_FOUND");
    });

    it("returns 500 INTERNAL when the guest access-check query errors", async () => {
      setUpAuth();
      mockGetSupabaseClient.mockReturnValue(
        makeSupabaseClient({
          invitations: { data: null, error: { message: "connection refused" } },
        }),
      );

      const res = await getMemberWeekView(fakeReq, WEEK_ID, makeLookup("guest"));
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.code).toBe("INTERNAL");
    });

    it("a guest-role user in the attendee set is filtered out of team", async () => {
      setUpAuth();
      mockGetSupabaseClient.mockReturnValue(
        makeSupabaseClient({
          invitations: {
            data: [{ status: "accepted", created_at: "2026-07-10T00:00:00Z" }],
            error: null,
          },
          users: {
            data: [
              { id: USER_ID, name: "Zoe Caller", role: "member" },
              { id: OTHER_USER_ID, name: "Amy Other", role: "guest" },
            ],
            error: null,
          },
        }),
      );

      const res = await getMemberWeekView(fakeReq, WEEK_ID, makeLookup("member"));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.team.map((m: { userId: string }) => m.userId)).toEqual([USER_ID]);
    });
  });
});
