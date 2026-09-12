jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({ getSupabaseClient: jest.fn() }));

import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { getSupabaseClient } from "@/lib/supabase/client";
import {
  listNotifications,
  getUnreadNotificationCount,
  markNotificationRead,
  markAllNotificationsRead,
} from "@/app/api/notifications/handler";
import type { AuthContext, UserLookup } from "@/lib/api/auth";
import type { UserRole } from "@/types/domain";

const mockAuth = auth as unknown as jest.Mock;
const mockGetSupabaseClient = getSupabaseClient as unknown as jest.Mock;

const JWT = "supabase-jwt";
const USER_ID = "user-1";
const CHURCH_GROUP_ID = "group-1";
const UUID = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

function makeReq(query: Record<string, string> = {}): NextRequest {
  return {
    nextUrl: { searchParams: new URLSearchParams(query) },
  } as unknown as NextRequest;
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

type Result = { data?: unknown; error?: unknown; count?: number | null };

// A chainable, thenable fake query builder. Every filter/order method returns
// the same builder; `range()`, `maybeSingle()` and awaiting the builder itself
// all resolve to the fixture keyed by `<table>:<op>` where op is "update" once
// `.update()` has been called, else "select".
function makeClient(fixtures: Record<string, Result>) {
  const calls = {
    from: [] as string[],
    eq: [] as { table: string; col: string; val: unknown }[],
    in: [] as { table: string; col: string; val: unknown }[],
    order: [] as { col: string; opts: unknown }[],
    range: [] as { from: number; to: number }[],
    select: [] as { table: string; cols: string; opts: unknown }[],
    update: [] as { table: string; patch: unknown }[],
  };

  function builder(table: string) {
    let op: "select" | "update" = "select";
    const pick = (): Result => {
      const key = `${table}:${op}`;
      const fixture = fixtures[key];
      if (!fixture) throw new Error(`no fixture for ${key}`);
      return fixture;
    };
    const b: Record<string, unknown> = {
      select: jest.fn((cols: string, opts?: unknown) => {
        calls.select.push({ table, cols, opts });
        return b;
      }),
      update: jest.fn((patch: unknown) => {
        op = "update";
        calls.update.push({ table, patch });
        return b;
      }),
      eq: jest.fn((col: string, val: unknown) => {
        calls.eq.push({ table, col, val });
        return b;
      }),
      in: jest.fn((col: string, val: unknown) => {
        calls.in.push({ table, col, val });
        return b;
      }),
      order: jest.fn((col: string, opts?: unknown) => {
        calls.order.push({ col, opts });
        return b;
      }),
      range: jest.fn((from: number, to: number) => {
        calls.range.push({ from, to });
        return Promise.resolve(pick());
      }),
      maybeSingle: jest.fn(() => Promise.resolve(pick())),
      then: (resolve: (v: Result) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(pick()).then(resolve, reject),
    };
    return b;
  }

  return {
    calls,
    from: jest.fn((table: string) => {
      calls.from.push(table);
      return builder(table);
    }),
  };
}

beforeEach(() => {
  mockAuth.mockReset();
  mockGetSupabaseClient.mockReset();
});

describe("GET /api/notifications (listNotifications)", () => {
  const rows = [
    {
      id: "n-2",
      type: "setlist_released",
      title: "Setlist published",
      body: "b2",
      link_entity_type: "setlist",
      link_entity_id: "sl-1",
      is_read: false,
      created_at: "2026-08-02T00:00:00.000Z",
    },
    {
      id: "n-1",
      type: "google_calendar_event",
      title: "GCal",
      body: null,
      link_entity_type: "google_calendar",
      link_entity_id: null,
      is_read: true,
      created_at: "2026-08-01T00:00:00.000Z",
    },
  ];

  it("401 UNAUTHENTICATED when Clerk userId is null (lookup never consulted)", async () => {
    mockAuth.mockResolvedValue({ userId: null, getToken: jest.fn() });
    const lookup = jest.fn();
    const res = await listNotifications(makeReq(), lookup as unknown as UserLookup);
    expect(res.status).toBe(401);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("401 UNAUTHENTICATED when getToken yields no JWT", async () => {
    setUpAuth(null);
    const res = await listNotifications(makeReq(), makeLookup("member"));
    expect(res.status).toBe(401);
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("200 for a member: maps rows to camelCase with pagination and default page/pageSize", async () => {
    setUpAuth();
    const client = makeClient({
      "notifications:select": { data: rows, error: null, count: 2 },
    });
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await listNotifications(makeReq(), makeLookup("member"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.notifications).toEqual([
      {
        id: "n-2",
        type: "setlist_released",
        title: "Setlist published",
        body: "b2",
        linkEntityType: "setlist",
        linkEntityId: "sl-1",
        isRead: false,
        createdAt: "2026-08-02T00:00:00.000Z",
      },
      {
        id: "n-1",
        type: "google_calendar_event",
        title: "GCal",
        body: null,
        linkEntityType: "google_calendar",
        linkEntityId: null,
        isRead: true,
        createdAt: "2026-08-01T00:00:00.000Z",
      },
    ]);
    expect(body.data.pagination).toEqual({ page: 1, pageSize: 20, total: 2 });
    // scope filters + ordering + range
    expect(client.calls.eq).toEqual(
      expect.arrayContaining([
        { table: "notifications", col: "user_id", val: USER_ID },
        { table: "notifications", col: "church_group_id", val: CHURCH_GROUP_ID },
      ]),
    );
    expect(client.calls.order).toEqual([
      { col: "created_at", opts: { ascending: false } },
      { col: "id", opts: { ascending: false } },
    ]);
    expect(client.calls.range).toEqual([{ from: 0, to: 19 }]);
    // no guest .in filter for a member
    expect(client.calls.in).toEqual([]);
  });

  it("applies range from page/pageSize", async () => {
    setUpAuth();
    const client = makeClient({
      "notifications:select": { data: [], error: null, count: 0 },
    });
    mockGetSupabaseClient.mockReturnValue(client);
    await listNotifications(makeReq({ page: "3", pageSize: "10" }), makeLookup("member"));
    expect(client.calls.range).toEqual([{ from: 20, to: 29 }]);
  });

  it("treats a null count as total: 0 (page past the end)", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeClient({ "notifications:select": { data: [], error: null, count: null } }),
    );
    const res = await listNotifications(makeReq({ page: "99" }), makeLookup("member"));
    const body = await res.json();
    expect(body.data.notifications).toEqual([]);
    expect(body.data.pagination.total).toBe(0);
  });

  it.each<Record<string, string>>([
    { page: "0" },
    { page: "abc" },
    { pageSize: "0" },
    { pageSize: "101" },
  ])("400 VALIDATION_FAILED for invalid pagination %p", async (query) => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeClient({ "notifications:select": { data: [], error: null, count: 0 } }),
    );
    const res = await listNotifications(makeReq(query), makeLookup("member"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("500 INTERNAL when the DB query errors (no driver detail leaked)", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeClient({
        "notifications:select": {
          data: null,
          error: { message: "connection refused" },
          count: null,
        },
      }),
    );
    const res = await listNotifications(makeReq(), makeLookup("member"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
    expect(body.error).toBe("Internal error");
  });

  describe("guest scoping", () => {
    it("filters notifications by the guest's scoped link_entity_id list", async () => {
      setUpAuth();
      const client = makeClient({
        "invitations:select": {
          data: [{ id: "inv-1", service_week_id: "wk-1" }],
          error: null,
        },
        "setlists:select": { data: [{ id: "sl-1" }], error: null },
        "notifications:select": { data: [], error: null, count: 0 },
      });
      mockGetSupabaseClient.mockReturnValue(client);

      const res = await listNotifications(makeReq(), makeLookup("guest"));
      expect(res.status).toBe(200);
      expect(client.calls.in).toContainEqual({
        table: "notifications",
        col: "link_entity_id",
        val: ["inv-1", "wk-1", "sl-1"],
      });
    });

    it("guest with zero invitations gets an empty page without querying notifications", async () => {
      setUpAuth();
      const client = makeClient({
        "invitations:select": { data: [], error: null },
      });
      mockGetSupabaseClient.mockReturnValue(client);

      const res = await listNotifications(makeReq(), makeLookup("guest"));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.notifications).toEqual([]);
      expect(body.data.pagination).toEqual({ page: 1, pageSize: 20, total: 0 });
      expect(client.calls.from).not.toContain("notifications");
    });

    it("500 INTERNAL when the guest-scope lookup errors", async () => {
      setUpAuth();
      mockGetSupabaseClient.mockReturnValue(
        makeClient({
          "invitations:select": { data: null, error: { message: "boom" } },
        }),
      );
      const res = await listNotifications(makeReq(), makeLookup("guest"));
      expect(res.status).toBe(500);
    });
  });
});

describe("GET /api/notifications/unread-count", () => {
  it("200 with unreadCount from the head count for a member", async () => {
    setUpAuth();
    const client = makeClient({
      "notifications:select": { data: null, error: null, count: 4 },
    });
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await getUnreadNotificationCount(makeReq(), makeLookup("member"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ unreadCount: 4 });
    expect(client.calls.eq).toEqual(
      expect.arrayContaining([
        { table: "notifications", col: "is_read", val: false },
      ]),
    );
  });

  it("coerces a null count to 0", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeClient({ "notifications:select": { data: null, error: null, count: null } }),
    );
    const res = await getUnreadNotificationCount(makeReq(), makeLookup("member"));
    const body = await res.json();
    expect(body.data.unreadCount).toBe(0);
  });

  it("guest with empty scope -> unreadCount 0, no notifications query", async () => {
    setUpAuth();
    const client = makeClient({ "invitations:select": { data: [], error: null } });
    mockGetSupabaseClient.mockReturnValue(client);
    const res = await getUnreadNotificationCount(makeReq(), makeLookup("guest"));
    const body = await res.json();
    expect(body.data.unreadCount).toBe(0);
    expect(client.calls.from).not.toContain("notifications");
  });

  it("500 INTERNAL on DB error", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeClient({
        "notifications:select": { data: null, error: { message: "x" }, count: null },
      }),
    );
    const res = await getUnreadNotificationCount(makeReq(), makeLookup("member"));
    expect(res.status).toBe(500);
  });

  it("401 when no JWT", async () => {
    setUpAuth(null);
    const res = await getUnreadNotificationCount(makeReq(), makeLookup("member"));
    expect(res.status).toBe(401);
  });
});

describe("PATCH /api/notifications/:id/read", () => {
  const unreadRow = {
    id: UUID,
    type: "setlist_released",
    title: "t",
    body: null,
    link_entity_type: "setlist",
    link_entity_id: "sl-1",
    is_read: false,
    created_at: "2026-08-01T00:00:00.000Z",
  };

  it("400 VALIDATION_FAILED for a non-UUID id", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeClient({}));
    const res = await markNotificationRead(makeReq(), "not-a-uuid", makeLookup("member"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("200 marks an unread notification read for a member", async () => {
    setUpAuth();
    const client = makeClient({
      "notifications:select": { data: unreadRow, error: null },
      "notifications:update": { data: { ...unreadRow, is_read: true }, error: null },
    });
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await markNotificationRead(makeReq(), UUID, makeLookup("member"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.notification.isRead).toBe(true);
    expect(client.calls.update).toEqual([
      { table: "notifications", patch: { is_read: true } },
    ]);
  });

  it("200 idempotent: already-read row returned unchanged, no update issued", async () => {
    setUpAuth();
    const client = makeClient({
      "notifications:select": { data: { ...unreadRow, is_read: true }, error: null },
    });
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await markNotificationRead(makeReq(), UUID, makeLookup("member"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.notification.isRead).toBe(true);
    expect(client.calls.update).toEqual([]);
  });

  it("404 NOT_FOUND when the row does not exist / belongs to another user", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeClient({ "notifications:select": { data: null, error: null } }),
    );
    const res = await markNotificationRead(makeReq(), UUID, makeLookup("member"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });

  it("404 NOT_FOUND for a guest when the row is outside their scope", async () => {
    setUpAuth();
    const client = makeClient({
      "invitations:select": {
        data: [{ id: "inv-1", service_week_id: "wk-1" }],
        error: null,
      },
      "setlists:select": { data: [], error: null },
      "notifications:select": {
        data: { ...unreadRow, link_entity_id: "other-sl" },
        error: null,
      },
    });
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await markNotificationRead(makeReq(), UUID, makeLookup("guest"));
    expect(res.status).toBe(404);
    expect(client.calls.update).toEqual([]);
  });

  it("404 NOT_FOUND for a guest when the row has a null link_entity_id", async () => {
    setUpAuth();
    const client = makeClient({
      "invitations:select": {
        data: [{ id: "inv-1", service_week_id: "wk-1" }],
        error: null,
      },
      "setlists:select": { data: [], error: null },
      "notifications:select": {
        data: { ...unreadRow, link_entity_id: null },
        error: null,
      },
    });
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await markNotificationRead(makeReq(), UUID, makeLookup("guest"));
    expect(res.status).toBe(404);
  });

  it("200 for a guest when the row IS in scope", async () => {
    setUpAuth();
    const client = makeClient({
      "invitations:select": {
        data: [{ id: "inv-1", service_week_id: "wk-1" }],
        error: null,
      },
      "setlists:select": { data: [{ id: "sl-1" }], error: null },
      "notifications:select": { data: unreadRow, error: null },
      "notifications:update": { data: { ...unreadRow, is_read: true }, error: null },
    });
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await markNotificationRead(makeReq(), UUID, makeLookup("guest"));
    expect(res.status).toBe(200);
  });

  it("500 INTERNAL when the fetch query errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeClient({
        "notifications:select": { data: null, error: { message: "x" } },
      }),
    );
    const res = await markNotificationRead(makeReq(), UUID, makeLookup("member"));
    expect(res.status).toBe(500);
  });
});

describe("POST /api/notifications/mark-all-read", () => {
  it("200 with updatedCount = number of rows flipped", async () => {
    setUpAuth();
    const client = makeClient({
      "notifications:update": { data: [{ id: "a" }, { id: "b" }, { id: "c" }], error: null },
    });
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await markAllNotificationsRead(makeReq(), makeLookup("member"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ updatedCount: 3 });
    expect(client.calls.update).toEqual([
      { table: "notifications", patch: { is_read: true } },
    ]);
    expect(client.calls.eq).toEqual(
      expect.arrayContaining([
        { table: "notifications", col: "is_read", val: false },
      ]),
    );
  });

  it("200 updatedCount 0 when nothing is unread", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeClient({ "notifications:update": { data: [], error: null } }),
    );
    const res = await markAllNotificationsRead(makeReq(), makeLookup("member"));
    const body = await res.json();
    expect(body.data.updatedCount).toBe(0);
  });

  it("guest with empty scope -> updatedCount 0, no update issued", async () => {
    setUpAuth();
    const client = makeClient({ "invitations:select": { data: [], error: null } });
    mockGetSupabaseClient.mockReturnValue(client);
    const res = await markAllNotificationsRead(makeReq(), makeLookup("guest"));
    const body = await res.json();
    expect(body.data.updatedCount).toBe(0);
    expect(client.calls.update).toEqual([]);
  });

  it("guest with scope -> update filtered by the scoped link_entity_id list", async () => {
    setUpAuth();
    const client = makeClient({
      "invitations:select": {
        data: [{ id: "inv-1", service_week_id: "wk-1" }],
        error: null,
      },
      "setlists:select": { data: [], error: null },
      "notifications:update": { data: [{ id: "a" }], error: null },
    });
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await markAllNotificationsRead(makeReq(), makeLookup("guest"));
    expect(res.status).toBe(200);
    expect(client.calls.in).toContainEqual({
      table: "notifications",
      col: "link_entity_id",
      val: ["inv-1", "wk-1"],
    });
  });

  it("500 INTERNAL on DB error", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeClient({ "notifications:update": { data: null, error: { message: "x" } } }),
    );
    const res = await markAllNotificationsRead(makeReq(), makeLookup("member"));
    expect(res.status).toBe(500);
  });

  it("401 when no JWT", async () => {
    setUpAuth(null);
    const res = await markAllNotificationsRead(makeReq(), makeLookup("member"));
    expect(res.status).toBe(401);
  });
});
