// Coder-stage coverage for #69 §4 — Invitation denied SMS + Email to the
// admin, both the authenticated (§4a) and the no-session token (§4b) branch.
// Covers spec edge cases 9 (already-responded dispatches nothing) and 10
// (null reason is passed through as null, never "null"), plus the
// invited_by === null fan-out to every admin/set_leader.

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({
  getSupabaseClient: jest.fn(),
  getAnonSupabaseClient: jest.fn(),
}));
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
import { getSupabaseClient, getAnonSupabaseClient } from "@/lib/supabase/client";
import { dispatchNotification } from "@/lib/notifications/dispatch";
import { denyInvitation } from "@/app/api/invitations/handler";
import type { AuthContext, UserLookup } from "@/lib/api/auth";

const mockAuth = auth as unknown as jest.Mock;
const mockGetSupabaseClient = getSupabaseClient as unknown as jest.Mock;
const mockGetAnonSupabaseClient = getAnonSupabaseClient as unknown as jest.Mock;
const mockDispatch = dispatchNotification as unknown as jest.Mock;

const JWT = "jwt";
const MEMBER_ID = "user-1";
const ADMIN_ID = "admin-1";
const GROUP_ID = "group-1";
const WEEK_ID = "22222222-2222-4222-8222-222222222222";
const INVITATION_ID = "33333333-3333-4333-8333-333333333333";
const TOKEN = "a".repeat(64);

function makeReq(body?: unknown): NextRequest {
  return { json: jest.fn().mockResolvedValue(body) } as unknown as NextRequest;
}
function lookup(): UserLookup {
  const ctx: AuthContext = { userId: MEMBER_ID, churchGroupId: GROUP_ID, role: "member" };
  return async () => ctx;
}
function setUpAuth(jwt: string | null = JWT) {
  mockAuth.mockResolvedValue({ userId: "clerk", getToken: jest.fn().mockResolvedValue(jwt) });
}

type QueryResult = { data: unknown; error: unknown };

function chain(result: QueryResult) {
  const c: Record<string, unknown> & PromiseLike<QueryResult> = {
    eq: jest.fn(() => c),
    neq: jest.fn(() => c),
    in: jest.fn(() => c),
    order: jest.fn(() => c),
    select: jest.fn(() => c),
    maybeSingle: jest.fn(() => Promise.resolve(result)),
    then: (res: (v: QueryResult) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(res, rej),
  } as unknown as Record<string, unknown> & PromiseLike<QueryResult>;
  return c;
}

function makeSupabase(queues: Record<string, QueryResult[]>) {
  const counts: Record<string, number> = {};
  const next = (table: string) => {
    const q = queues[table] ?? [];
    const i = counts[table] ?? 0;
    counts[table] = i + 1;
    return q[i] ?? q[q.length - 1] ?? { data: null, error: null };
  };
  return {
    from: jest.fn((table: string) => ({
      select: jest.fn(() => chain(next(table))),
      update: jest.fn(() => chain(next(table))),
      insert: jest.fn(() => chain(next(table))),
    })),
    rpc: jest.fn(() => Promise.resolve({ data: null, error: null })),
  };
}

const pendingInv = (overrides: Record<string, unknown> = {}) => ({
  id: INVITATION_ID,
  church_group_id: GROUP_ID,
  service_week_id: WEEK_ID,
  user_id: MEMBER_ID,
  role_note: null,
  status: "pending",
  response_token: TOKEN,
  responded_at: null,
  denial_reason: null,
  denial_count: 0,
  response_deadline: "2027-01-01T00:00:00Z",
  invited_by: ADMIN_ID,
  created_at: "2026-07-12T00:00:00Z",
  ...overrides,
});
const deniedInv = (overrides: Record<string, unknown> = {}) => ({
  ...pendingInv(),
  status: "denied",
  denial_count: 1,
  responded_at: "2026-07-12T01:00:00Z",
  ...overrides,
});
const weekRow = { title: "Sunday Service", service_date: "2026-07-12" };
const adminUser = (id: string) => ({
  id,
  name: `Admin ${id}`,
  email: `${id}@example.com`,
  phone: "+15551112222",
  sms_opted_in: true,
});

beforeEach(() => {
  mockAuth.mockReset();
  mockGetSupabaseClient.mockReset();
  mockGetAnonSupabaseClient.mockReset();
  mockDispatch.mockClear();
});

describe("denyInvitation §4a — authenticated path", () => {
  function wire(queues: Record<string, QueryResult[]>) {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabase(queues));
  }

  it("dispatches invitation_denied to the inviting admin with the /week/<id> link", async () => {
    wire({
      invitations: [
        { data: pendingInv(), error: null }, // load
        { data: [], error: null }, // prior denied
        { data: deniedInv(), error: null }, // update .select().maybeSingle()
      ],
      users: [
        { data: { name: "Jordan Member" }, error: null }, // denying member name
        { data: [adminUser(ADMIN_ID)], error: null }, // recipients (invited_by)
      ],
      service_weeks: [{ data: weekRow, error: null }],
    });

    const res = await denyInvitation(
      makeReq({ reason: "Family trip" }),
      INVITATION_ID,
      lookup(),
    );
    expect(res.status).toBe(200);

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const arg = mockDispatch.mock.calls[0][0];
    expect(arg.email.template).toBe("invitation_denied");
    expect(arg.email.data.link).toBe(`https://app.test/week/${WEEK_ID}`);
    expect(arg.email.data.reason).toBe("Family trip");
    expect(arg.email.data.memberName).toBe("Jordan Member");
    expect(arg.recipients.map((r: { userId: string }) => r.userId)).toEqual([ADMIN_ID]);
  });

  it("invited_by === null -> fans out to every admin/set_leader in the group", async () => {
    wire({
      invitations: [
        { data: pendingInv({ invited_by: null }), error: null },
        { data: [], error: null },
        { data: deniedInv({ invited_by: null }), error: null },
      ],
      users: [
        { data: { name: "Jordan Member" }, error: null },
        { data: [adminUser("admin-a"), adminUser("admin-b")], error: null },
      ],
      service_weeks: [{ data: weekRow, error: null }],
    });

    const res = await denyInvitation(makeReq({}), INVITATION_ID, lookup());
    expect(res.status).toBe(200);

    const arg = mockDispatch.mock.calls[0][0];
    expect(arg.recipients).toHaveLength(2);
  });

  it("edge 10: null reason is passed through as null (not the string 'null')", async () => {
    wire({
      invitations: [
        { data: pendingInv(), error: null },
        { data: [], error: null },
        { data: deniedInv(), error: null },
      ],
      users: [
        { data: { name: "Jordan Member" }, error: null },
        { data: [adminUser(ADMIN_ID)], error: null },
      ],
      service_weeks: [{ data: weekRow, error: null }],
    });

    await denyInvitation(makeReq({}), INVITATION_ID, lookup());

    const arg = mockDispatch.mock.calls[0][0];
    expect(arg.email.data.reason).toBeNull();
  });

  it("edge 9: an already-responded invitation dispatches nothing", async () => {
    wire({
      invitations: [{ data: deniedInv(), error: null }],
    });

    const res = await denyInvitation(makeReq({}), INVITATION_ID, lookup());
    expect(res.status).toBe(200);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("a recipient query error skips dispatch but still returns 200", async () => {
    wire({
      invitations: [
        { data: pendingInv(), error: null },
        { data: [], error: null },
        { data: deniedInv(), error: null },
      ],
      users: [
        { data: { name: "Jordan Member" }, error: null },
        { data: null, error: { message: "connection reset" } },
      ],
      service_weeks: [{ data: weekRow, error: null }],
    });

    const res = await denyInvitation(makeReq({}), INVITATION_ID, lookup());
    expect(res.status).toBe(200);
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});

describe("denyInvitation §4b — no-session token path", () => {
  function wireRpc(data: unknown) {
    mockGetAnonSupabaseClient.mockReturnValue({ rpc: jest.fn(() => Promise.resolve({ data, error: null })) });
  }

  it("dispatches from the RPC-provided recipients and never leaks them in the response body", async () => {
    wireRpc({
      status: "denied",
      already_responded: false,
      member_name: "Jordan Member",
      service_week_id: WEEK_ID,
      service_date: "2026-07-12",
      week_title: "Sunday Service",
      reason: "Out of town",
      recipients: [
        { user_id: ADMIN_ID, name: "Alex Admin", email: "alex@example.com", phone: "+1", sms_opted_in: true },
      ],
    });

    const res = await denyInvitation(makeReq({ responseToken: TOKEN, reason: "Out of town" }), INVITATION_ID);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data).toEqual({ invitationId: INVITATION_ID, status: "denied", alreadyResponded: false });
    expect(JSON.stringify(body)).not.toContain("alex@example.com");

    const arg = mockDispatch.mock.calls[0][0];
    expect(arg.email.template).toBe("invitation_denied");
    expect(arg.email.data.link).toBe(`https://app.test/week/${WEEK_ID}`);
    expect(arg.recipients[0].userId).toBe(ADMIN_ID);
  });

  it("edge 9: already_responded -> RPC returns recipients [] -> no dispatch", async () => {
    wireRpc({ status: "accepted", already_responded: true, recipients: [] });

    const res = await denyInvitation(makeReq({ responseToken: TOKEN }), INVITATION_ID);
    expect(res.status).toBe(200);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("edge 10: RPC reason null -> dispatched reason is null", async () => {
    wireRpc({
      status: "denied",
      already_responded: false,
      member_name: "Jordan Member",
      service_week_id: WEEK_ID,
      service_date: "2026-07-12",
      week_title: null,
      reason: null,
      recipients: [
        { user_id: ADMIN_ID, name: "Alex", email: "a@b.com", phone: null, sms_opted_in: false },
      ],
    });

    await denyInvitation(makeReq({ responseToken: TOKEN }), INVITATION_ID);

    const arg = mockDispatch.mock.calls[0][0];
    expect(arg.email.data.reason).toBeNull();
    expect(arg.sms.body).toEqual(expect.any(String));
  });
});
