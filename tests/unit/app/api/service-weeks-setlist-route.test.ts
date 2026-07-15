jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({ getSupabaseClient: jest.fn() }));

import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { getSupabaseClient } from "@/lib/supabase/client";
import { getSetlist, createSetlist } from "@/app/api/service-weeks/[id]/setlist/handler";
import type { SetlistResponse } from "@/app/api/service-weeks/[id]/setlist/handler";
import type { AuthContext, UserLookup } from "@/lib/api/auth";
import type { UserRole } from "@/types/domain";

const mockAuth = auth as unknown as jest.Mock;
const mockGetSupabaseClient = getSupabaseClient as unknown as jest.Mock;

const JWT = "supabase-jwt";
const USER_ID = "user-1";
const CHURCH_GROUP_ID = "group-1";
const WEEK_ID = "week-1";
const SETLIST_ID = "setlist-1";

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
type TableFixture = {
  select?: QueryResult;
  insert?: QueryResult;
};

const publishedSetlistRow = {
  id: SETLIST_ID,
  church_group_id: CHURCH_GROUP_ID,
  service_week_id: WEEK_ID,
  status: "published",
  published_at: "2026-07-10T00:00:00Z",
  notes: null,
  created_by: USER_ID,
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-01T00:00:00Z",
};

const publishedSetlistResponse: SetlistResponse = {
  id: SETLIST_ID,
  serviceWeekId: WEEK_ID,
  status: "published",
  publishedAt: "2026-07-10T00:00:00Z",
  notes: null,
  createdBy: USER_ID,
  createdAt: "2026-07-01T00:00:00Z",
  updatedAt: "2026-07-01T00:00:00Z",
};

const draftSetlistRow = {
  id: SETLIST_ID,
  church_group_id: CHURCH_GROUP_ID,
  service_week_id: WEEK_ID,
  status: "draft",
  published_at: null,
  notes: null,
  created_by: USER_ID,
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-01T00:00:00Z",
};

const weekRow = { id: WEEK_ID };

const DEFAULT_FIXTURES: Record<string, TableFixture> = {
  setlists: {
    select: { data: publishedSetlistRow, error: null },
  },
  invitations: {
    select: { data: { id: "invitation-1" }, error: null },
  },
  service_weeks: {
    select: { data: weekRow, error: null },
  },
};

// Generic chainable mock covering:
//   .select(...).eq(...).eq(...).maybeSingle()
//   .insert(...).select(...).maybeSingle()
function makeChain(result: QueryResult) {
  const chain: Record<string, unknown> & PromiseLike<QueryResult> = {
    eq: jest.fn(() => chain),
    select: jest.fn(() => chain),
    maybeSingle: jest.fn(() => Promise.resolve(result)),
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
  const fixtures: Record<string, TableFixture> = {};
  for (const table of Object.keys(DEFAULT_FIXTURES)) {
    fixtures[table] = { ...DEFAULT_FIXTURES[table], ...overrides[table] };
  }

  return {
    from: jest.fn((table: string) => {
      const tableFixture = fixtures[table] ?? {};
      return {
        select: jest.fn(() => makeChain(tableFixture.select ?? { data: null, error: null })),
        insert: jest.fn((payload: unknown) => {
          hooks?.onInsert?.(table, payload);
          return makeChain(tableFixture.insert ?? { data: null, error: null });
        }),
      };
    }),
  };
}

beforeEach(() => {
  mockAuth.mockReset();
  mockGetSupabaseClient.mockReset();
});

describe("GET /api/service-weeks/[id]/setlist", () => {
  it("returns 401 UNAUTHENTICATED when Clerk userId is null (lookup never consulted)", async () => {
    mockAuth.mockResolvedValue({ userId: null, getToken: jest.fn() });
    const lookup = jest.fn();

    const res = await getSetlist(fakeReq, WEEK_ID, lookup as unknown as UserLookup);
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("returns 401 UNAUTHENTICATED when getToken yields no JWT", async () => {
    setUpAuth(null);

    const res = await getSetlist(fakeReq, WEEK_ID, makeLookup("member"));
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 200 for a member when a published setlist row is returned", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await getSetlist(fakeReq, WEEK_ID, makeLookup("member"));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data.setlist).toEqual(publishedSetlistResponse);
  });

  it("returns 404 NOT_FOUND when the setlist query returns { data: null } (draft hidden from member / no setlist)", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({ setlists: { select: { data: null, error: null } } }),
    );

    const res = await getSetlist(fakeReq, WEEK_ID, makeLookup("member"));
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });

  it("returns 200 for a guest with a matching invitation", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await getSetlist(fakeReq, WEEK_ID, makeLookup("guest"));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data.setlist).toEqual(publishedSetlistResponse);
  });

  it("returns 404 NOT_FOUND (not 403) for a guest with no invitation", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({ invitations: { select: { data: null, error: null } } }),
    );

    const res = await getSetlist(fakeReq, WEEK_ID, makeLookup("guest"));
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });

  it("returns 500 INTERNAL when the setlist query errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        setlists: { select: { data: null, error: { message: "connection refused" } } },
      }),
    );

    const res = await getSetlist(fakeReq, WEEK_ID, makeLookup("member"));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });
});

describe("POST /api/service-weeks/[id]/setlist", () => {
  it("returns 401 UNAUTHENTICATED when Clerk userId is null (lookup never consulted)", async () => {
    mockAuth.mockResolvedValue({ userId: null, getToken: jest.fn() });
    const lookup = jest.fn();

    const res = await createSetlist(fakeReq, WEEK_ID, lookup as unknown as UserLookup);
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("returns 401 UNAUTHENTICATED when getToken yields no JWT", async () => {
    setUpAuth(null);

    const res = await createSetlist(fakeReq, WEEK_ID, makeLookup("admin"));
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 403 FORBIDDEN for a member (supabase never constructed)", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await createSetlist(fakeReq, WEEK_ID, makeLookup("member"));
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.code).toBe("FORBIDDEN");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 403 FORBIDDEN for a guest (supabase never constructed)", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabaseClient());

    const res = await createSetlist(fakeReq, WEEK_ID, makeLookup("guest"));
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.code).toBe("FORBIDDEN");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 404 NOT_FOUND when the tenant-scoped service_weeks lookup returns null", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({ service_weeks: { select: { data: null, error: null } } }),
    );

    const res = await createSetlist(fakeReq, "missing-id", makeLookup("admin"));
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });

  it("returns 500 INTERNAL when the service_weeks lookup errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        service_weeks: { select: { data: null, error: { message: "connection refused" } } },
      }),
    );

    const res = await createSetlist(fakeReq, WEEK_ID, makeLookup("admin"));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });

  it("returns 200 with the existing setlist when one already exists (no insert)", async () => {
    setUpAuth();
    let insertCalled = false;
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient(
        { setlists: { select: { data: draftSetlistRow, error: null } } },
        { onInsert: () => (insertCalled = true) },
      ),
    );

    const res = await createSetlist(fakeReq, WEEK_ID, makeLookup("admin"));
    expect(res.status).toBe(200);
    expect(insertCalled).toBe(false);

    const body = await res.json();
    expect(body.data.setlist.status).toBe("draft");
  });

  it("returns 201 creating a new draft when none exists", async () => {
    setUpAuth();
    let capturedPayload: unknown;
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient(
        {
          setlists: {
            select: { data: null, error: null },
            insert: { data: draftSetlistRow, error: null },
          },
        },
        { onInsert: (_table, payload) => (capturedPayload = payload) },
      ),
    );

    const res = await createSetlist(fakeReq, WEEK_ID, makeLookup("set_leader"));
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.data.setlist.status).toBe("draft");
    expect(capturedPayload).toEqual({
      church_group_id: CHURCH_GROUP_ID,
      service_week_id: WEEK_ID,
      created_by: USER_ID,
    });
  });

  it("returns 500 INTERNAL when the insert errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        setlists: {
          select: { data: null, error: null },
          insert: { data: null, error: { message: "constraint violation" } },
        },
      }),
    );

    const res = await createSetlist(fakeReq, WEEK_ID, makeLookup("admin"));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });
});
