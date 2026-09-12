// Independent tester-stage coverage for issue #71 (in-app notification inbox).
// Separate from the coder's notifications-inbox-route.test.ts: this file targets
// spec edge cases that were under-covered — the 401-no-JWT path on the two
// mutating handlers, the guest `.in` scope filter on unread-count, a 500 on the
// PATCH update leg, non-guest visibility of null-link rows, and the pageSize=100
// boundary.
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

describe("spec item 10: missing Supabase JWT -> 401 on all four endpoints", () => {
  it("markNotificationRead returns 401 UNAUTHENTICATED when getToken yields no JWT", async () => {
    setUpAuth(null);
    const res = await markNotificationRead(makeReq(), UUID, makeLookup("member"));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("listNotifications returns 401 when getToken yields no JWT", async () => {
    setUpAuth(null);
    const res = await listNotifications(makeReq(), makeLookup("guest"));
    expect(res.status).toBe(401);
  });

  it("markAllNotificationsRead returns 401 when getToken yields no JWT", async () => {
    setUpAuth(null);
    const res = await markAllNotificationsRead(makeReq(), makeLookup("member"));
    expect(res.status).toBe(401);
  });

  it("getUnreadNotificationCount returns 401 when getToken yields no JWT", async () => {
    setUpAuth(null);
    const res = await getUnreadNotificationCount(makeReq(), makeLookup("guest"));
    expect(res.status).toBe(401);
  });
});

describe("spec item 3: null link_entity_id rows are visible to non-guest roles", () => {
  const nullLinkRow = {
    id: "n-null",
    type: "google_calendar_reauth_required",
    title: "Reauth",
    body: null,
    link_entity_type: "google_calendar",
    link_entity_id: null,
    is_read: false,
    created_at: "2026-08-03T00:00:00.000Z",
  };

  it.each<UserRole>(["admin", "set_leader", "member"])(
    "%s sees a null-link notification and no .in filter is applied",
    async (role) => {
      setUpAuth();
      const client = makeClient({
        "notifications:select": { data: [nullLinkRow], error: null, count: 1 },
      });
      mockGetSupabaseClient.mockReturnValue(client);

      const res = await listNotifications(makeReq(), makeLookup(role));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.notifications).toHaveLength(1);
      expect(body.data.notifications[0].linkEntityId).toBeNull();
      expect(client.calls.in).toEqual([]);
      expect(client.calls.from).not.toContain("invitations");
    },
  );

  it("markNotificationRead lets a member mark a null-link row read (no 404)", async () => {
    setUpAuth();
    const client = makeClient({
      "notifications:select": { data: { ...unreadRow, link_entity_id: null }, error: null },
      "notifications:update": {
        data: { ...unreadRow, link_entity_id: null, is_read: true },
        error: null,
      },
    });
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await markNotificationRead(makeReq(), UUID, makeLookup("member"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.notification.isRead).toBe(true);
  });
});

describe("guest scope filter on unread-count", () => {
  it("applies the scoped link_entity_id .in filter for a guest with invitations", async () => {
    setUpAuth();
    const client = makeClient({
      "invitations:select": {
        data: [{ id: "inv-1", service_week_id: "wk-1" }],
        error: null,
      },
      "setlists:select": { data: [{ id: "sl-9" }], error: null },
      "notifications:select": { data: null, error: null, count: 2 },
    });
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await getUnreadNotificationCount(makeReq(), makeLookup("guest"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.unreadCount).toBe(2);
    expect(client.calls.in).toContainEqual({
      table: "notifications",
      col: "link_entity_id",
      val: ["inv-1", "wk-1", "sl-9"],
    });
    expect(client.calls.eq).toContainEqual({
      table: "notifications",
      col: "is_read",
      val: false,
    });
  });
});

describe("failure case: DB error on the PATCH update leg -> 500 INTERNAL", () => {
  it("returns 500 and leaks no driver detail when the update errors", async () => {
    setUpAuth();
    const client = makeClient({
      "notifications:select": { data: unreadRow, error: null },
      "notifications:update": { data: null, error: { message: "deadlock detected" } },
    });
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await markNotificationRead(makeReq(), UUID, makeLookup("member"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
    expect(body.error).toBe("Internal error");
  });

  it("returns 404 when the update leg finds no row to write", async () => {
    setUpAuth();
    const client = makeClient({
      "notifications:select": { data: unreadRow, error: null },
      "notifications:update": { data: null, error: null },
    });
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await markNotificationRead(makeReq(), UUID, makeLookup("member"));
    expect(res.status).toBe(404);
  });
});

describe("pagination boundary: pageSize=100 is accepted, 100 is the max", () => {
  it("accepts pageSize=100 and computes the range", async () => {
    setUpAuth();
    const client = makeClient({
      "notifications:select": { data: [], error: null, count: 0 },
    });
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await listNotifications(
      makeReq({ page: "2", pageSize: "100" }),
      makeLookup("member"),
    );
    expect(res.status).toBe(200);
    expect(client.calls.range).toEqual([{ from: 100, to: 199 }]);
  });

  it("rejects a negative page", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeClient({ "notifications:select": { data: [], error: null, count: 0 } }),
    );
    const res = await listNotifications(makeReq({ page: "-1" }), makeLookup("member"));
    expect(res.status).toBe(400);
  });
});

describe("guest with a withdrawn-only invitation still resolves a non-empty scope", () => {
  // The spec's key decision: guest-inbox-scope uses ALL invitation rows
  // regardless of status, so an invitation_withdrawn notification stays visible.
  it("includes the invitation id and its week id in the guest .in filter", async () => {
    setUpAuth();
    const client = makeClient({
      "invitations:select": {
        data: [{ id: "inv-withdrawn", service_week_id: "wk-x" }],
        error: null,
      },
      "setlists:select": { data: [], error: null },
      "notifications:select": {
        data: [
          {
            id: "n-w",
            type: "invitation_withdrawn",
            title: "Withdrawn",
            body: null,
            link_entity_type: "invitation",
            link_entity_id: "inv-withdrawn",
            is_read: false,
            created_at: "2026-08-05T00:00:00.000Z",
          },
        ],
        error: null,
        count: 1,
      },
    });
    mockGetSupabaseClient.mockReturnValue(client);

    const res = await listNotifications(makeReq(), makeLookup("guest"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.notifications).toHaveLength(1);
    expect(client.calls.in).toContainEqual({
      table: "notifications",
      col: "link_entity_id",
      val: ["inv-withdrawn", "wk-x"],
    });
    // invitations query must NOT filter by status
    const invEqCols = client.calls.eq
      .filter((c) => c.table === "invitations")
      .map((c) => c.col);
    expect(invEqCols).toEqual(["user_id"]);
  });
});
