// Coder-stage coverage for #69 §6 — Scheduling conflict SMS + Email to admins.
// Part A exercises dispatchConflictNotifications directly (recipient
// resolution, spec edge case 13 = the triggering member never notifies
// themselves, the scheduling_conflict template + /conflicts link, best-effort
// silence on error). Part B drives the real setAvailability / deleteAvailability
// handlers end to end (only @/lib/notifications/dispatch is mocked) and checks
// the conflict email fires exactly when a conflict row was recorded.

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({ getSupabaseClient: jest.fn() }));
jest.mock("@/lib/notifications/dispatch", () => ({
  dispatchNotification: jest.fn().mockResolvedValue({
    smsSent: 1,
    smsSkipped: 0,
    smsFailed: 0,
    emailSent: 1,
    emailSkipped: 0,
    emailFailed: 0,
  }),
  appNotificationUrl: (path: string) => `https://app.test${path}`,
}));

import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { getSupabaseClient } from "@/lib/supabase/client";
import { dispatchNotification } from "@/lib/notifications/dispatch";
import { dispatchConflictNotifications } from "@/lib/scheduling/conflict-detection";
import { setAvailability, deleteAvailability } from "@/app/api/availability/handler";
import type { AuthContext, UserLookup } from "@/lib/api/auth";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";

const mockAuth = auth as unknown as jest.Mock;
const mockGetSupabaseClient = getSupabaseClient as unknown as jest.Mock;
const mockDispatch = dispatchNotification as unknown as jest.Mock;

type QueryResult = { data: unknown; error: unknown };

const actor = { userId: "member-1", churchGroupId: "group-1" };
const adminRow = (id: string) => ({
  id,
  name: `Admin ${id}`,
  email: `${id}@example.com`,
  phone: "+15550001111",
  sms_opted_in: true,
});

beforeEach(() => {
  mockAuth.mockReset();
  mockGetSupabaseClient.mockReset();
  mockDispatch.mockClear();
});

// ---------------------------------------------------------------------------
// Part A — dispatchConflictNotifications, direct
// ---------------------------------------------------------------------------

function directChain(result: QueryResult, neqCalls: unknown[][]) {
  const c: Record<string, unknown> & PromiseLike<QueryResult> = {
    eq: jest.fn(() => c),
    in: jest.fn(() => c),
    neq: jest.fn((...args: unknown[]) => {
      neqCalls.push(args);
      return c;
    }),
    select: jest.fn(() => c),
    maybeSingle: jest.fn(() => Promise.resolve(result)),
    then: (res: (v: QueryResult) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(res, rej),
  } as unknown as Record<string, unknown> & PromiseLike<QueryResult>;
  return c;
}

function directSupabase(queues: Record<string, QueryResult[]>) {
  const counts: Record<string, number> = {};
  const neqCalls: unknown[][] = [];
  const next = (t: string) => {
    const q = queues[t] ?? [];
    const i = counts[t] ?? 0;
    counts[t] = i + 1;
    return q[i] ?? q[q.length - 1] ?? { data: null, error: null };
  };
  const client = {
    from: jest.fn((t: string) => ({ select: jest.fn(() => directChain(next(t), neqCalls)) })),
  } as unknown as SupabaseClient<Database>;
  return { client, neqCalls };
}

describe("dispatchConflictNotifications", () => {
  it("dispatches scheduling_conflict SMS + Email to admins with the /conflicts link", async () => {
    const { client } = directSupabase({
      users: [
        { data: { name: "Jordan Member" }, error: null },
        { data: [adminRow("admin-a"), adminRow("admin-b")], error: null },
      ],
    });

    await dispatchConflictNotifications(client, actor, "2026-08-01");

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const arg = mockDispatch.mock.calls[0][0];
    expect(arg.email.template).toBe("scheduling_conflict");
    expect(arg.email.data.link).toBe("https://app.test/conflicts");
    expect(arg.email.data.memberName).toBe("Jordan Member");
    expect(arg.sms.body).toContain("https://app.test/conflicts");
    expect(arg.recipients).toHaveLength(2);
  });

  it("edge 13: the recipient query excludes the triggering member (.neq on their id)", async () => {
    const { client, neqCalls } = directSupabase({
      users: [
        { data: { name: "Jordan" }, error: null },
        { data: [adminRow("admin-a")], error: null },
      ],
    });

    await dispatchConflictNotifications(client, actor, "2026-08-01");
    expect(neqCalls).toContainEqual(["id", "member-1"]);
  });

  it("zero recipients -> no dispatch", async () => {
    const { client } = directSupabase({
      users: [
        { data: { name: "Jordan" }, error: null },
        { data: [], error: null },
      ],
    });
    await dispatchConflictNotifications(client, actor, "2026-08-01");
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("a query error -> returns silently, no dispatch, no throw", async () => {
    const { client } = directSupabase({
      users: [
        { data: { name: "Jordan" }, error: null },
        { data: null, error: { message: "connection reset" } },
      ],
    });
    await expect(dispatchConflictNotifications(client, actor, "2026-08-01")).resolves.toBeUndefined();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("never throws even if the client itself throws", async () => {
    const throwing = {
      from: jest.fn(() => {
        throw new Error("boom");
      }),
    } as unknown as SupabaseClient<Database>;
    await expect(
      dispatchConflictNotifications(throwing, actor, "2026-08-01"),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Part B — real setAvailability / deleteAvailability handlers
// ---------------------------------------------------------------------------

function req(body?: unknown): NextRequest {
  return { json: jest.fn().mockResolvedValue(body) } as unknown as NextRequest;
}
function lookup(): UserLookup {
  const ctx: AuthContext = { userId: "member-1", churchGroupId: "group-1", role: "member" };
  return async () => ctx;
}

// Fake covering: availability upsert/delete/select, users lookups for
// dispatchConflictNotifications, and rpc("record_availability_conflict").
function handlerSupabase(conflictRecorded: boolean) {
  const usersQueue: QueryResult[] = [
    { data: { name: "Jordan Member" }, error: null },
    { data: [adminRow("admin-a")], error: null },
  ];
  let usersIdx = 0;
  const makeChain = (result: QueryResult) => {
    const c: Record<string, unknown> & PromiseLike<QueryResult> = {
      upsert: jest.fn(() => c),
      delete: jest.fn(() => c),
      select: jest.fn(() => c),
      eq: jest.fn(() => c),
      in: jest.fn(() => c),
      neq: jest.fn(() => c),
      order: jest.fn(() => c),
      maybeSingle: jest.fn(() => Promise.resolve(result)),
      then: (res: (v: QueryResult) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(result).then(res, rej),
    } as unknown as Record<string, unknown> & PromiseLike<QueryResult>;
    return c;
  };
  return {
    from: jest.fn((t: string) => {
      if (t === "users") return makeChain(usersQueue[usersIdx++] ?? usersQueue[usersQueue.length - 1]!);
      return makeChain({ data: [], error: null });
    }),
    rpc: jest.fn(() => Promise.resolve({ data: conflictRecorded, error: null })),
  };
}

describe("availability handlers — conflict email wiring", () => {
  beforeEach(() => {
    mockAuth.mockResolvedValue({ userId: "clerk", getToken: jest.fn().mockResolvedValue("jwt") });
  });

  it("setAvailability(unavailable) fires the conflict email when the RPC records a conflict", async () => {
    mockGetSupabaseClient.mockReturnValue(handlerSupabase(true));

    const res = await setAvailability(
      req({ entries: [{ date: "2026-08-01", isAvailable: false }] }),
      lookup(),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.conflictTriggered).toBe(true);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockDispatch.mock.calls[0][0].email.template).toBe("scheduling_conflict");
  });

  it("setAvailability does NOT fire the conflict email when the RPC records nothing", async () => {
    mockGetSupabaseClient.mockReturnValue(handlerSupabase(false));

    const res = await setAvailability(
      req({ entries: [{ date: "2026-08-01", isAvailable: false }] }),
      lookup(),
    );
    expect(res.status).toBe(200);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("deleteAvailability fires the conflict email when the delete triggers a conflict", async () => {
    mockGetSupabaseClient.mockReturnValue(handlerSupabase(true));

    const res = await deleteAvailability(req(), "2026-08-01", lookup());
    expect(res.status).toBe(200);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  it("deleteAvailability does NOT fire when no conflict is triggered", async () => {
    mockGetSupabaseClient.mockReturnValue(handlerSupabase(false));

    const res = await deleteAvailability(req(), "2026-08-01", lookup());
    expect(res.status).toBe(200);
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});
