// Tests for POST /api/conflicts/:id/resolve (#47). Mock scaffolding style
// mirrors tests/unit/app/api/invitations-withdraw-route.test.ts (makeReq,
// makeLookup, setUpAuth, chainable Supabase mock), extended with a
// `.delete()` chain for the withdraw path's event_attendees cleanup.

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({ getSupabaseClient: jest.fn() }));

import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { getSupabaseClient } from "@/lib/supabase/client";
import { resolveConflict, type ResolvedConflictResponse } from "@/app/api/conflicts/handler";
import type { AuthContext, UserLookup } from "@/lib/api/auth";
import type { UserRole } from "@/types/domain";

const mockAuth = auth as unknown as jest.Mock;
const mockGetSupabaseClient = getSupabaseClient as unknown as jest.Mock;

const JWT = "supabase-jwt";
const USER_ID = "admin-1";
const CHURCH_GROUP_ID = "group-1";
const CONFLICT_ID = "44444444-4444-4444-4444-444444444444";
const INVITATION_ID = "33333333-3333-3333-3333-333333333333";
const SERVICE_WEEK_ID = "22222222-2222-2222-2222-222222222222";
const MEMBER_ID = "11111111-1111-1111-1111-111111111111";
const EVENT_ID = "55555555-5555-5555-5555-555555555555";

function makeReq(body?: unknown): NextRequest {
  return { json: jest.fn().mockResolvedValue(body) } as unknown as NextRequest;
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

type QueryResult = { data: unknown; error: unknown };
type TableFixture = {
  // Each call to .select(...) on this table consumes the next entry (the
  // last entry is reused once the array is exhausted).
  selects?: QueryResult[];
  update?: QueryResult;
  insert?: QueryResult;
  delete?: QueryResult;
};

function makeChain(result: QueryResult) {
  const chain: Record<string, unknown> & PromiseLike<QueryResult> = {
    eq: jest.fn(() => chain),
    in: jest.fn(() => chain),
    is: jest.fn(() => chain),
    order: jest.fn(() => chain),
    select: jest.fn(() => chain),
    maybeSingle: jest.fn(() => Promise.resolve(result)),
    then: (resolve: (value: QueryResult) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  } as unknown as Record<string, unknown> & PromiseLike<QueryResult>;
  return chain;
}

function makeSupabaseClient(
  fixtures: Partial<Record<string, TableFixture>> = {},
  hooks?: {
    rpc?: jest.Mock;
    onUpdate?: (table: string, payload: unknown) => void;
    onInsert?: (table: string, payload: unknown) => void;
    onDelete?: (table: string, chain: Record<string, unknown>) => void;
  },
) {
  const selectCallIndex: Record<string, number> = {};

  return {
    from: jest.fn((table: string) => {
      const tableFixture = fixtures[table] ?? {};
      return {
        select: jest.fn(() => {
          const idx = selectCallIndex[table] ?? 0;
          selectCallIndex[table] = idx + 1;
          const selects = tableFixture.selects ?? [{ data: null, error: null }];
          const result = selects[Math.min(idx, selects.length - 1)] ?? { data: null, error: null };
          return makeChain(result);
        }),
        update: jest.fn((payload: unknown) => {
          hooks?.onUpdate?.(table, payload);
          return makeChain(tableFixture.update ?? { data: null, error: null });
        }),
        insert: jest.fn((payload: unknown) => {
          hooks?.onInsert?.(table, payload);
          return makeChain(tableFixture.insert ?? { data: null, error: null });
        }),
        delete: jest.fn(() => {
          const chain = makeChain(tableFixture.delete ?? { data: null, error: null });
          hooks?.onDelete?.(table, chain);
          return chain;
        }),
      };
    }),
    rpc: hooks?.rpc ?? jest.fn(() => Promise.resolve({ data: null, error: null })),
  };
}

const openConflictRow = {
  id: CONFLICT_ID,
  church_group_id: CHURCH_GROUP_ID,
  invitation_id: INVITATION_ID,
  triggered_by: null,
  trigger_reason: "double-booked",
  replacement_suggestion_user_id: null,
  resolved_at: null,
  resolution_type: null,
  created_at: "2026-07-12T00:00:00Z",
};

const alreadyResolvedConflictRow = {
  ...openConflictRow,
  resolved_at: "2026-07-11T00:00:00Z",
  resolution_type: "admin_dismissed",
};

const acceptedInvitationRow = {
  id: INVITATION_ID,
  church_group_id: CHURCH_GROUP_ID,
  service_week_id: SERVICE_WEEK_ID,
  user_id: MEMBER_ID,
  status: "accepted",
};

function resolvedConflictUpdateRow(resolutionType: string) {
  return {
    ...openConflictRow,
    resolution_type: resolutionType,
    resolved_at: "2026-07-13T00:00:00Z",
  };
}

beforeEach(() => {
  mockAuth.mockReset();
  mockGetSupabaseClient.mockReset();
});

describe("POST /api/conflicts/:id/resolve", () => {
  it("returns 403 FORBIDDEN when caller role is member", async () => {
    setUpAuth();

    const res = await resolveConflict(
      makeReq({ resolution: "withdraw" }),
      CONFLICT_ID,
      makeLookup("member"),
    );
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.code).toBe("FORBIDDEN");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 400 VALIDATION_FAILED when resolution is invalid", async () => {
    setUpAuth();

    const res = await resolveConflict(
      makeReq({ resolution: "not-a-real-value" }),
      CONFLICT_ID,
      makeLookup("admin"),
    );
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 400 VALIDATION_FAILED when the body is missing/unparseable", async () => {
    setUpAuth();

    const res = await resolveConflict(makeReq(null), CONFLICT_ID, makeLookup("admin"));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("returns 401 UNAUTHENTICATED when getToken yields no JWT", async () => {
    setUpAuth(null);

    const res = await resolveConflict(
      makeReq({ resolution: "withdraw" }),
      CONFLICT_ID,
      makeLookup("admin"),
    );
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 404 NOT_FOUND when the conflict does not exist / is not in the caller's group", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        conflicts: { selects: [{ data: null, error: null }] },
      }),
    );

    const res = await resolveConflict(
      makeReq({ resolution: "admin_dismissed" }),
      CONFLICT_ID,
      makeLookup("admin"),
    );
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });

  it("returns 409 CONFLICT when the conflict is already resolved, with no side effects", async () => {
    setUpAuth();
    const onUpdate = jest.fn();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient(
        {
          conflicts: { selects: [{ data: alreadyResolvedConflictRow, error: null }] },
        },
        { onUpdate },
      ),
    );

    const res = await resolveConflict(
      makeReq({ resolution: "member_reconfirmed" }),
      CONFLICT_ID,
      makeLookup("admin"),
    );
    expect(res.status).toBe(409);

    const body = await res.json();
    expect(body.code).toBe("CONFLICT");
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("returns 500 INTERNAL when the conflict lookup query errors", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabaseClient({
        conflicts: { selects: [{ data: null, error: { message: "connection refused" } }] },
      }),
    );

    const res = await resolveConflict(
      makeReq({ resolution: "withdraw" }),
      CONFLICT_ID,
      makeLookup("admin"),
    );
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });

  describe("resolution: withdraw", () => {
    it("happy path: withdraws the invitation, deletes event_attendees, notifies the member, resolves the conflict, and writes audit", async () => {
      setUpAuth();
      const rpc = jest.fn(() => Promise.resolve({ data: null, error: null }));
      const updates: { table: string; payload: unknown }[] = [];
      const inserts: { table: string; payload: unknown }[] = [];
      let deleteChain: Record<string, unknown> | undefined;

      const client = makeSupabaseClient(
        {
          conflicts: {
            selects: [{ data: openConflictRow, error: null }],
            update: { data: resolvedConflictUpdateRow("withdrawn"), error: null },
          },
          invitations: {
            selects: [{ data: acceptedInvitationRow, error: null }],
            update: { data: { ...acceptedInvitationRow, status: "withdrawn" }, error: null },
          },
          events: {
            selects: [{ data: [{ id: EVENT_ID }], error: null }],
          },
          event_attendees: {
            delete: { data: null, error: null },
          },
          notifications: {
            insert: { data: null, error: null },
          },
        },
        {
          rpc,
          onUpdate: (table, payload) => updates.push({ table, payload }),
          onInsert: (table, payload) => inserts.push({ table, payload }),
          onDelete: (_table, chain) => (deleteChain = chain),
        },
      );
      mockGetSupabaseClient.mockReturnValue(client);

      const res = await resolveConflict(
        makeReq({ resolution: "withdraw" }),
        CONFLICT_ID,
        makeLookup("admin"),
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      const conflict: ResolvedConflictResponse = body.data.conflict;
      expect(conflict).toEqual({
        id: CONFLICT_ID,
        resolutionType: "withdrawn",
        resolvedAt: "2026-07-13T00:00:00Z",
      });

      const invitationUpdate = updates.find((u) => u.table === "invitations");
      expect(invitationUpdate?.payload).toEqual({ status: "withdrawn" });

      const conflictUpdate = updates.find((u) => u.table === "conflicts");
      expect(conflictUpdate?.payload).toMatchObject({ resolution_type: "withdrawn" });

      expect(deleteChain?.in).toHaveBeenCalledWith("event_id", [EVENT_ID]);
      expect(deleteChain?.eq).toHaveBeenCalledWith("user_id", MEMBER_ID);

      const notification = inserts.find((i) => i.table === "notifications");
      expect(notification?.payload).toMatchObject({
        user_id: MEMBER_ID,
        type: "invitation_withdrawn",
        church_group_id: CHURCH_GROUP_ID,
        link_entity_type: "invitation",
        link_entity_id: INVITATION_ID,
      });

      expect(rpc).toHaveBeenCalledWith(
        "write_audit_log",
        expect.objectContaining({
          p_action: "conflict.resolved",
          p_entity_id: CONFLICT_ID,
          p_metadata: expect.objectContaining({
            resolution: "withdraw",
            invitation_id: INVITATION_ID,
          }),
        }),
      );
    });

    it("edge case: service week has no events -> event_attendees delete is skipped (no-op), still succeeds", async () => {
      setUpAuth();
      let deleteCalled = false;
      const client = makeSupabaseClient(
        {
          conflicts: {
            selects: [{ data: openConflictRow, error: null }],
            update: { data: resolvedConflictUpdateRow("withdrawn"), error: null },
          },
          invitations: {
            selects: [{ data: acceptedInvitationRow, error: null }],
            update: { data: { ...acceptedInvitationRow, status: "withdrawn" }, error: null },
          },
          events: {
            selects: [{ data: [], error: null }],
          },
          notifications: {
            insert: { data: null, error: null },
          },
        },
        { onDelete: () => (deleteCalled = true) },
      );
      mockGetSupabaseClient.mockReturnValue(client);

      const res = await resolveConflict(
        makeReq({ resolution: "withdraw" }),
        CONFLICT_ID,
        makeLookup("admin"),
      );
      expect(res.status).toBe(200);
      expect(deleteCalled).toBe(false);
    });

    it("edge case: invitation is already withdrawn/denied -> no 409, proceeds and resolves the conflict", async () => {
      setUpAuth();
      const client = makeSupabaseClient({
        conflicts: {
          selects: [{ data: openConflictRow, error: null }],
          update: { data: resolvedConflictUpdateRow("withdrawn"), error: null },
        },
        invitations: {
          selects: [{ data: { ...acceptedInvitationRow, status: "denied" }, error: null }],
          update: { data: { ...acceptedInvitationRow, status: "withdrawn" }, error: null },
        },
        events: {
          selects: [{ data: [], error: null }],
        },
        notifications: {
          insert: { data: null, error: null },
        },
      });
      mockGetSupabaseClient.mockReturnValue(client);

      const res = await resolveConflict(
        makeReq({ resolution: "withdraw" }),
        CONFLICT_ID,
        makeLookup("admin"),
      );
      expect(res.status).toBe(200);
    });

    it("returns 404 NOT_FOUND when the underlying invitation is missing", async () => {
      setUpAuth();
      mockGetSupabaseClient.mockReturnValue(
        makeSupabaseClient({
          conflicts: { selects: [{ data: openConflictRow, error: null }] },
          invitations: { selects: [{ data: null, error: null }] },
        }),
      );

      const res = await resolveConflict(
        makeReq({ resolution: "withdraw" }),
        CONFLICT_ID,
        makeLookup("admin"),
      );
      expect(res.status).toBe(404);

      const body = await res.json();
      expect(body.code).toBe("NOT_FOUND");
    });

    it("returns 500 INTERNAL when the notification insert errors (failure case)", async () => {
      setUpAuth();
      const client = makeSupabaseClient({
        conflicts: { selects: [{ data: openConflictRow, error: null }] },
        invitations: {
          selects: [{ data: acceptedInvitationRow, error: null }],
          update: { data: { ...acceptedInvitationRow, status: "withdrawn" }, error: null },
        },
        events: { selects: [{ data: [], error: null }] },
        notifications: { insert: { data: null, error: { message: "insert failed" } } },
      });
      mockGetSupabaseClient.mockReturnValue(client);

      const res = await resolveConflict(
        makeReq({ resolution: "withdraw" }),
        CONFLICT_ID,
        makeLookup("admin"),
      );
      expect(res.status).toBe(500);

      const body = await res.json();
      expect(body.code).toBe("INTERNAL");
    });
  });

  describe("resolution: member_reconfirmed / admin_dismissed", () => {
    it("member_reconfirmed: resolves the conflict with the correct resolution_type and makes NO invitations/event_attendees writes", async () => {
      setUpAuth();
      const updates: { table: string; payload: unknown }[] = [];
      let deleteCalled = false;
      const client = makeSupabaseClient(
        {
          conflicts: {
            selects: [{ data: openConflictRow, error: null }],
            update: { data: resolvedConflictUpdateRow("member_reconfirmed"), error: null },
          },
        },
        {
          onUpdate: (table, payload) => updates.push({ table, payload }),
          onDelete: () => (deleteCalled = true),
        },
      );
      mockGetSupabaseClient.mockReturnValue(client);

      const res = await resolveConflict(
        makeReq({ resolution: "member_reconfirmed" }),
        CONFLICT_ID,
        makeLookup("set_leader"),
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.conflict.resolutionType).toBe("member_reconfirmed");

      expect(updates.some((u) => u.table === "invitations")).toBe(false);
      expect(deleteCalled).toBe(false);
      const conflictUpdate = updates.find((u) => u.table === "conflicts");
      expect(conflictUpdate?.payload).toMatchObject({ resolution_type: "member_reconfirmed" });
    });

    it("admin_dismissed: resolves the conflict with the correct resolution_type and makes NO invitations/event_attendees writes", async () => {
      setUpAuth();
      const updates: { table: string; payload: unknown }[] = [];
      let deleteCalled = false;
      const client = makeSupabaseClient(
        {
          conflicts: {
            selects: [{ data: openConflictRow, error: null }],
            update: { data: resolvedConflictUpdateRow("admin_dismissed"), error: null },
          },
        },
        {
          onUpdate: (table, payload) => updates.push({ table, payload }),
          onDelete: () => (deleteCalled = true),
        },
      );
      mockGetSupabaseClient.mockReturnValue(client);

      const res = await resolveConflict(
        makeReq({ resolution: "admin_dismissed" }),
        CONFLICT_ID,
        makeLookup("admin"),
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.conflict.resolutionType).toBe("admin_dismissed");

      expect(updates.some((u) => u.table === "invitations")).toBe(false);
      expect(deleteCalled).toBe(false);
    });
  });
});
