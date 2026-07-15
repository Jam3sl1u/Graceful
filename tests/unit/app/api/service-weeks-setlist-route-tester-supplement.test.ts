// Supplementary tests written independently by the Tester stage for #54
// (BR-01 zero-song valid state). The coder's own
// service-weeks-setlist-route.test.ts uses a `makeChain` mock whose `.eq()`
// is a no-op passthrough that ignores its arguments and always resolves to
// the configured fixture — so a bug where a handler forgot to scope a query
// by `church_group_id` (a cross-tenant data leak / creation-in-wrong-tenant
// bug) would NOT be caught by that suite: the fixture would still be
// returned regardless of what was actually passed to `.eq()`. These tests
// close that gap by recording the actual arguments passed to `.eq()`/
// `.insert()`, plus a couple of additional independent checks (call
// ordering, and that `status` is never set on insert per the spec).

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({ getSupabaseClient: jest.fn() }));

import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { getSupabaseClient } from "@/lib/supabase/client";
import { getSetlist, createSetlist } from "@/app/api/service-weeks/[id]/setlist/handler";
import type { AuthContext, UserLookup } from "@/lib/api/auth";

const mockAuth = auth as unknown as jest.Mock;
const mockGetSupabaseClient = getSupabaseClient as unknown as jest.Mock;

const JWT = "supabase-jwt";
const USER_ID = "user-1";
const CHURCH_GROUP_ID = "group-1";
const OTHER_CHURCH_GROUP_ID = "group-EVIL";
const WEEK_ID = "week-1";
const SETLIST_ID = "setlist-1";

const fakeReq = {} as NextRequest;

function makeLookup(role: AuthContext["role"], churchGroupId = CHURCH_GROUP_ID): UserLookup {
  const ctx: AuthContext = { userId: USER_ID, churchGroupId, role };
  return async () => ctx;
}

function setUpAuth(jwt: string | null = JWT) {
  mockAuth.mockResolvedValue({
    userId: "clerk_test",
    getToken: jest.fn().mockResolvedValue(jwt),
  });
}

type QueryResult = { data: unknown; error: unknown };

// Chain that records every .eq(...) call it receives (table-scoped by the
// caller) so tests can assert on the *arguments*, not just that a call
// happened and a fixture was returned regardless.
function makeRecordingChain(
  result: QueryResult,
  onEq?: (args: unknown[]) => void,
): Record<string, unknown> & PromiseLike<QueryResult> {
  const chain: Record<string, unknown> & PromiseLike<QueryResult> = {
    eq: jest.fn((...args: unknown[]) => {
      onEq?.(args);
      return chain;
    }),
    select: jest.fn(() => chain),
    maybeSingle: jest.fn(() => Promise.resolve(result)),
    then: (resolve: (value: QueryResult) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  } as unknown as Record<string, unknown> & PromiseLike<QueryResult>;
  return chain;
}

beforeEach(() => {
  mockAuth.mockReset();
  mockGetSupabaseClient.mockReset();
});

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

describe("getSetlist — tester supplement (tenant scoping)", () => {
  it("scopes the setlists query by the caller's church_group_id, not any other tenant's", async () => {
    setUpAuth();
    const eqCalls: unknown[][] = [];

    const client = {
      from: jest.fn((table: string) => {
        if (table === "setlists") {
          return {
            select: jest.fn(() =>
              makeRecordingChain({ data: draftSetlistRow, error: null }, (args) =>
                eqCalls.push(args),
              ),
            ),
          };
        }
        throw new Error(`Unexpected table: ${table}`);
      }),
    };
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await getSetlist(fakeReq, WEEK_ID, makeLookup("admin", OTHER_CHURCH_GROUP_ID));
    expect(res.status).toBe(200);

    // Must filter by service_week_id AND by the caller's own church_group_id
    // — never a hardcoded/wrong tenant.
    expect(eqCalls).toEqual([
      ["service_week_id", WEEK_ID],
      ["church_group_id", OTHER_CHURCH_GROUP_ID],
    ]);
  });

  it("does not query invitations for a non-guest role (admin/leader/member skip the invitation check)", async () => {
    setUpAuth();
    let invitationsQueried = false;

    const client = {
      from: jest.fn((table: string) => {
        if (table === "setlists") {
          return {
            select: jest.fn(() => makeRecordingChain({ data: draftSetlistRow, error: null })),
          };
        }
        if (table === "invitations") {
          invitationsQueried = true;
          return { select: jest.fn(() => makeRecordingChain({ data: null, error: null })) };
        }
        throw new Error(`Unexpected table: ${table}`);
      }),
    };
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await getSetlist(fakeReq, WEEK_ID, makeLookup("member"));
    expect(res.status).toBe(200);
    expect(invitationsQueried).toBe(false);
  });
});

describe("createSetlist — tester supplement (tenant scoping, ordering, insert shape)", () => {
  it("scopes the tenant existence check by the caller's own church_group_id", async () => {
    setUpAuth();
    const eqCalls: unknown[][] = [];

    const client = {
      from: jest.fn((table: string) => {
        if (table === "service_weeks") {
          return {
            select: jest.fn(() =>
              makeRecordingChain({ data: null, error: null }, (args) => eqCalls.push(args)),
            ),
          };
        }
        throw new Error(`Unexpected table: ${table}`);
      }),
    };
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await createSetlist(
      fakeReq,
      WEEK_ID,
      makeLookup("admin", OTHER_CHURCH_GROUP_ID),
    );
    expect(res.status).toBe(404);

    expect(eqCalls).toEqual([
      ["id", WEEK_ID],
      ["church_group_id", OTHER_CHURCH_GROUP_ID],
    ]);
  });

  it("never queries or inserts into setlists when the tenant-scoped week check fails (404 short-circuits)", async () => {
    setUpAuth();
    let setlistsTouched = false;

    const client = {
      from: jest.fn((table: string) => {
        if (table === "service_weeks") {
          return { select: jest.fn(() => makeRecordingChain({ data: null, error: null })) };
        }
        if (table === "setlists") {
          setlistsTouched = true;
          return {
            select: jest.fn(() => makeRecordingChain({ data: null, error: null })),
            insert: jest.fn(() => makeRecordingChain({ data: null, error: null })),
          };
        }
        throw new Error(`Unexpected table: ${table}`);
      }),
    };
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await createSetlist(fakeReq, "nonexistent-week", makeLookup("admin"));
    expect(res.status).toBe(404);
    expect(setlistsTouched).toBe(false);
  });

  it("insert payload never includes a status field (DB default 'draft' must be used, per spec)", async () => {
    setUpAuth();
    let capturedPayload: Record<string, unknown> | undefined;

    const client = {
      from: jest.fn((table: string) => {
        if (table === "service_weeks") {
          return {
            select: jest.fn(() =>
              makeRecordingChain({ data: { id: WEEK_ID }, error: null }),
            ),
          };
        }
        if (table === "setlists") {
          return {
            select: jest.fn(() => makeRecordingChain({ data: null, error: null })),
            insert: jest.fn((payload: Record<string, unknown>) => {
              capturedPayload = payload;
              return makeRecordingChain({ data: draftSetlistRow, error: null });
            }),
          };
        }
        throw new Error(`Unexpected table: ${table}`);
      }),
    };
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await createSetlist(fakeReq, WEEK_ID, makeLookup("admin"));
    expect(res.status).toBe(201);
    expect(capturedPayload).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(capturedPayload!, "status")).toBe(false);
  });

  it("does not read the request body — POST works with a request whose json() would throw if called", async () => {
    setUpAuth();
    const throwingReq = {
      json: jest.fn(() => {
        throw new Error("json() should never be called for zero-song setlist creation");
      }),
    } as unknown as NextRequest;

    const client = {
      from: jest.fn((table: string) => {
        if (table === "service_weeks") {
          return {
            select: jest.fn(() => makeRecordingChain({ data: { id: WEEK_ID }, error: null })),
          };
        }
        if (table === "setlists") {
          return {
            select: jest.fn(() => makeRecordingChain({ data: null, error: null })),
            insert: jest.fn(() => makeRecordingChain({ data: draftSetlistRow, error: null })),
          };
        }
        throw new Error(`Unexpected table: ${table}`);
      }),
    };
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await createSetlist(throwingReq, WEEK_ID, makeLookup("set_leader"));
    expect(res.status).toBe(201);
    expect((throwingReq.json as jest.Mock)).not.toHaveBeenCalled();
  });

  it("double POST (get-or-create idempotency, end-to-end across two calls) never inserts twice and second call returns 200 with the same row", async () => {
    setUpAuth();
    let insertCount = 0;
    let currentRow: typeof draftSetlistRow | null = null;

    function client() {
      return {
        from: jest.fn((table: string) => {
          if (table === "service_weeks") {
            return {
              select: jest.fn(() => makeRecordingChain({ data: { id: WEEK_ID }, error: null })),
            };
          }
          if (table === "setlists") {
            return {
              select: jest.fn(() =>
                makeRecordingChain({ data: currentRow, error: null }),
              ),
              insert: jest.fn(() => {
                insertCount += 1;
                currentRow = draftSetlistRow;
                return makeRecordingChain({ data: draftSetlistRow, error: null });
              }),
            };
          }
          throw new Error(`Unexpected table: ${table}`);
        }),
      };
    }

    mockGetSupabaseClient.mockReturnValue(client());
    const first = await createSetlist(fakeReq, WEEK_ID, makeLookup("admin"));
    expect(first.status).toBe(201);
    expect(insertCount).toBe(1);

    mockGetSupabaseClient.mockReturnValue(client());
    const second = await createSetlist(fakeReq, WEEK_ID, makeLookup("admin"));
    expect(second.status).toBe(200);
    expect(insertCount).toBe(1);

    const secondBody = await second.json();
    expect(secondBody.data.setlist.id).toBe(SETLIST_ID);
  });
});
