// Coder-stage coverage for #69 §2 — Set invitation SMS + Email to the member
// (createInvitation) and the guest variant (createGuestInvitation). Asserts the
// dispatchNotification call: the email template key, the rendered deep link,
// and spec edge cases 12 (guest existing-user vs new-user link) and 14
// (cross-group userId -> lookup miss -> skip dispatch, still 201).

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn(), currentUser: jest.fn() }));
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
import { createInvitation, createGuestInvitation } from "@/app/api/invitations/handler";
import type { AuthContext, UserLookup } from "@/lib/api/auth";

const mockAuth = auth as unknown as jest.Mock;
const mockGetSupabaseClient = getSupabaseClient as unknown as jest.Mock;
const mockDispatch = dispatchNotification as unknown as jest.Mock;

const JWT = "jwt";
const ADMIN_ID = "admin-1";
const GROUP_ID = "group-1";
const MEMBER_ID = "11111111-1111-4111-8111-111111111111";
const WEEK_ID = "22222222-2222-4222-8222-222222222222";
const TOKEN = "a".repeat(64);

function makeReq(body?: unknown): NextRequest {
  return { json: jest.fn().mockResolvedValue(body) } as unknown as NextRequest;
}
function lookup(role: AuthContext["role"] = "admin"): UserLookup {
  return async () => ({ userId: ADMIN_ID, churchGroupId: GROUP_ID, role });
}
function setUpAuth(jwt: string | null = JWT) {
  mockAuth.mockResolvedValue({ userId: "clerk", getToken: jest.fn().mockResolvedValue(jwt) });
}

const weekRow = {
  id: WEEK_ID,
  church_group_id: GROUP_ID,
  service_date: "2026-07-12",
  title: "Sunday Service",
  is_cancelled: false,
};
const invitationRow = {
  id: "inv-1",
  church_group_id: GROUP_ID,
  service_week_id: WEEK_ID,
  user_id: MEMBER_ID,
  role_note: "Lead guitar",
  status: "pending",
  response_token: TOKEN,
  responded_at: null,
  denial_reason: null,
  denial_count: 0,
  response_deadline: "2026-07-15T00:00:00Z",
  invited_by: ADMIN_ID,
  created_at: "2026-07-12T00:00:00Z",
};
const memberUserRow = {
  id: MEMBER_ID,
  name: "Jordan Member",
  email: "jordan@example.com",
  phone: "+15551230000",
  sms_opted_in: true,
};
const adminUserRow = {
  id: ADMIN_ID,
  name: "Alex Admin",
  email: "alex@example.com",
  phone: "+15559990000",
  sms_opted_in: true,
};

type QueryResult = { data: unknown; error: unknown };

// Chain that records the final .in()/.eq() and resolves the configured result.
function chain(result: QueryResult) {
  const c: Record<string, unknown> & PromiseLike<QueryResult> = {
    eq: jest.fn(() => c),
    neq: jest.fn(() => c),
    in: jest.fn(() => c),
    is: jest.fn(() => c),
    ilike: jest.fn(() => c),
    limit: jest.fn(() => c),
    order: jest.fn(() => c),
    select: jest.fn(() => c),
    maybeSingle: jest.fn(() => Promise.resolve(result)),
    then: (res: (v: QueryResult) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(res, rej),
  } as unknown as Record<string, unknown> & PromiseLike<QueryResult>;
  return c;
}

// Per-table queue of results, consumed in call order.
function makeSupabase(queues: Record<string, QueryResult[]>, rpc?: jest.Mock) {
  const counts: Record<string, number> = {};
  return {
    from: jest.fn((table: string) => {
      const next = () => {
        const q = queues[table] ?? [];
        const i = counts[table] ?? 0;
        counts[table] = i + 1;
        return q[i] ?? q[q.length - 1] ?? { data: null, error: null };
      };
      return {
        select: jest.fn(() => chain(next())),
        insert: jest.fn(() => chain(next())),
      };
    }),
    rpc: rpc ?? jest.fn(() => Promise.resolve({ data: null, error: null })),
  };
}

beforeEach(() => {
  mockAuth.mockReset();
  mockGetSupabaseClient.mockReset();
  mockDispatch.mockClear();
});

describe("createInvitation — set invitation notification (§2a)", () => {
  it("dispatches set_invitation email + SMS to the member with the rendered /invite/<token> link", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabase({
        service_weeks: [{ data: weekRow, error: null }],
        invitations: [
          { data: [], error: null }, // denied-for-week
          { data: [], error: null }, // accepted (double-booking)
          { data: invitationRow, error: null }, // insert .select().maybeSingle()
        ],
        users: [{ data: [memberUserRow, adminUserRow], error: null }],
      }),
    );

    const res = await createInvitation(
      makeReq({ serviceWeekId: WEEK_ID, userId: MEMBER_ID, roleNote: "Lead guitar" }),
      lookup(),
    );
    expect(res.status).toBe(201);

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const arg = mockDispatch.mock.calls[0][0];
    expect(arg.email.template).toBe("set_invitation");
    expect(arg.email.data.link).toBe(`https://app.test/invite/${TOKEN}`);
    expect(arg.email.data.adminName).toBe("Alex Admin");
    expect(arg.sms.body).toContain(`https://app.test/invite/${TOKEN}`);
    expect(arg.recipients).toHaveLength(1);
    expect(arg.recipients[0].userId).toBe(MEMBER_ID);
  });

  it("edge 14: cross-group userId -> users lookup returns nothing -> skips dispatch, still 201", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(
      makeSupabase({
        service_weeks: [{ data: weekRow, error: null }],
        invitations: [
          { data: [], error: null },
          { data: [], error: null },
          { data: invitationRow, error: null },
        ],
        users: [{ data: [], error: null }], // RLS hides the cross-group row
      }),
    );

    const res = await createInvitation(
      makeReq({ serviceWeekId: WEEK_ID, userId: MEMBER_ID }),
      lookup(),
    );
    expect(res.status).toBe(201);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("a thrown users lookup does not 500 the request (best-effort dispatch)", async () => {
    setUpAuth();
    const supa = makeSupabase({
      service_weeks: [{ data: weekRow, error: null }],
      invitations: [
        { data: [], error: null },
        { data: [], error: null },
        { data: invitationRow, error: null },
      ],
    });
    const originalFrom = supa.from;
    supa.from = jest.fn((table: string) => {
      if (table === "users") {
        return {
          select: jest.fn(() => {
            throw new Error("boom");
          }),
        } as never;
      }
      return originalFrom(table);
    });
    mockGetSupabaseClient.mockReturnValue(supa);

    const res = await createInvitation(
      makeReq({ serviceWeekId: WEEK_ID, userId: MEMBER_ID }),
      lookup(),
    );
    expect(res.status).toBe(201);
  });
});

describe("createGuestInvitation — guest set invitation notification (§2b)", () => {
  const guestBody = { serviceWeekId: WEEK_ID, email: "guest@example.com" };

  function guestQueues(isNewUser: boolean) {
    return {
      service_weeks: [{ data: weekRow, error: null }],
      users: [
        // existing-user lookup by email
        isNewUser
          ? { data: [], error: null }
          : { data: [{ id: MEMBER_ID }], error: null },
        // the post-insert [guest, admin] contact lookup
        { data: [memberUserRow, adminUserRow], error: null },
      ],
      invitations: isNewUser
        ? [{ data: { ...invitationRow, user_id: MEMBER_ID }, error: null }]
        : [
            { data: [], error: null }, // denied-for-week
            { data: [], error: null }, // accepted
            { data: { ...invitationRow, user_id: MEMBER_ID }, error: null }, // insert
          ],
    };
  }

  it("edge 12: existing-user branch -> link is the /invite/<token> page", async () => {
    setUpAuth();
    mockGetSupabaseClient.mockReturnValue(makeSupabase(guestQueues(false)));

    const res = await createGuestInvitation(makeReq(guestBody), lookup());
    expect(res.status).toBe(201);

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const arg = mockDispatch.mock.calls[0][0];
    expect(arg.email.template).toBe("set_invitation");
    // §2b reuses the existing inviteUrl/accountSetupUrl (built with the local
    // appUrl helper), so the link ends with /invite/<token> for an existing user.
    expect(arg.email.data.link).toBe(`/invite/${TOKEN}`);
    expect(arg.sms.body).toContain(`/invite/${TOKEN}`);
  });

  it("edge 12: new-user branch -> link is the /guest/<token> account-setup page", async () => {
    setUpAuth();
    const rpc = jest.fn(() => Promise.resolve({ data: { id: MEMBER_ID }, error: null }));
    mockGetSupabaseClient.mockReturnValue(makeSupabase(guestQueues(true), rpc));

    const res = await createGuestInvitation(makeReq(guestBody), lookup());
    expect(res.status).toBe(201);

    const arg = mockDispatch.mock.calls[0][0];
    expect(arg.email.data.link).toBe(`/guest/${TOKEN}`);
  });
});
