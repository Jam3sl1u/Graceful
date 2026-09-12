// Coder-stage coverage for #69 §5 — Setlist released SMS + Email to confirmed
// members on publish. Covers spec edge case 4 (zero confirmed members -> no
// dispatch, still 200) and 11 (songCount === 0 still dispatches, BR-01).

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
import { publishSetlist } from "@/app/api/setlists/[id]/handler";
import type { AuthContext, UserLookup } from "@/lib/api/auth";

const mockAuth = auth as unknown as jest.Mock;
const mockGetSupabaseClient = getSupabaseClient as unknown as jest.Mock;
const mockDispatch = dispatchNotification as unknown as jest.Mock;

const GROUP_ID = "group-1";
const SETLIST_ID = "setlist-1";
const WEEK_ID = "week-1";

function makeReq(): NextRequest {
  return { json: jest.fn().mockResolvedValue(undefined) } as unknown as NextRequest;
}
function lookup(): UserLookup {
  const ctx: AuthContext = { userId: "u-1", churchGroupId: GROUP_ID, role: "admin" };
  return async () => ctx;
}
function setUpAuth() {
  mockAuth.mockResolvedValue({ userId: "clerk", getToken: jest.fn().mockResolvedValue("jwt") });
}

type QueryResult = { data: unknown; error: unknown };
function chain(result: QueryResult) {
  const c: Record<string, unknown> & PromiseLike<QueryResult> = {
    eq: jest.fn(() => c),
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
  const next = (t: string) => {
    const q = queues[t] ?? [];
    const i = counts[t] ?? 0;
    counts[t] = i + 1;
    return q[i] ?? q[q.length - 1] ?? { data: null, error: null };
  };
  return {
    from: jest.fn((t: string) => ({
      select: jest.fn(() => chain(next(t))),
      update: jest.fn(() => chain(next(t))),
      insert: jest.fn(() => chain(next(t))),
    })),
  };
}

const draftRow = {
  id: SETLIST_ID,
  church_group_id: GROUP_ID,
  service_week_id: WEEK_ID,
  status: "draft",
  published_at: null,
  notes: null,
  created_by: "u-1",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};
const publishedRow = { ...draftRow, status: "published", published_at: "2026-01-02T00:00:00Z" };
const contactRow = (id: string) => ({
  id,
  name: `Member ${id}`,
  email: `${id}@example.com`,
  phone: "+15550001111",
  sms_opted_in: true,
});
const weekRow = { title: "Sunday Service", service_date: "2026-07-12" };

beforeEach(() => {
  mockAuth.mockReset();
  mockGetSupabaseClient.mockReset();
  mockDispatch.mockClear();
  setUpAuth();
});

it("happy path: dispatches setlist_released to deduped confirmed members with songCount + /week link", async () => {
  mockGetSupabaseClient.mockReturnValue(
    makeSupabase({
      setlists: [
        { data: draftRow, error: null }, // load
        { data: publishedRow, error: null }, // update .select().maybeSingle()
      ],
      setlist_songs: [{ data: [{ id: "s1" }, { id: "s2" }], error: null }],
      invitations: [
        { data: [{ user_id: "m1" }, { user_id: "m1" }, { user_id: "m2" }], error: null },
      ],
      users: [{ data: [contactRow("m1"), contactRow("m2")], error: null }],
      service_weeks: [{ data: weekRow, error: null }],
    }),
  );

  const res = await publishSetlist(makeReq(), SETLIST_ID, lookup());
  expect(res.status).toBe(200);

  expect(mockDispatch).toHaveBeenCalledTimes(1);
  const arg = mockDispatch.mock.calls[0][0];
  expect(arg.email.template).toBe("setlist_released");
  expect(arg.email.data.songCount).toBe(2);
  expect(arg.email.data.link).toBe(`https://app.test/week/${WEEK_ID}`);
  expect(arg.recipients.map((r: { userId: string }) => r.userId).sort()).toEqual(["m1", "m2"]);
});

it("edge 11: songCount === 0 still dispatches (BR-01 empty setlist publish)", async () => {
  mockGetSupabaseClient.mockReturnValue(
    makeSupabase({
      setlists: [
        { data: draftRow, error: null },
        { data: publishedRow, error: null },
      ],
      setlist_songs: [{ data: [], error: null }],
      invitations: [{ data: [{ user_id: "m1" }], error: null }],
      users: [{ data: [contactRow("m1")], error: null }],
      service_weeks: [{ data: weekRow, error: null }],
    }),
  );

  const res = await publishSetlist(makeReq(), SETLIST_ID, lookup());
  expect(res.status).toBe(200);
  expect(mockDispatch).toHaveBeenCalledTimes(1);
  expect(mockDispatch.mock.calls[0][0].email.data.songCount).toBe(0);
});

it("edge 4: zero confirmed members -> no dispatch, still 200", async () => {
  mockGetSupabaseClient.mockReturnValue(
    makeSupabase({
      setlists: [
        { data: draftRow, error: null },
        { data: publishedRow, error: null },
      ],
      setlist_songs: [{ data: [{ id: "s1" }], error: null }],
      invitations: [{ data: [], error: null }],
    }),
  );

  const res = await publishSetlist(makeReq(), SETLIST_ID, lookup());
  expect(res.status).toBe(200);
  expect(mockDispatch).not.toHaveBeenCalled();
});

it("a contact/week query error skips dispatch but still returns 200", async () => {
  mockGetSupabaseClient.mockReturnValue(
    makeSupabase({
      setlists: [
        { data: draftRow, error: null },
        { data: publishedRow, error: null },
      ],
      setlist_songs: [{ data: [{ id: "s1" }], error: null }],
      invitations: [{ data: [{ user_id: "m1" }], error: null }],
      users: [{ data: null, error: { message: "boom" } }],
      service_weeks: [{ data: weekRow, error: null }],
    }),
  );

  const res = await publishSetlist(makeReq(), SETLIST_ID, lookup());
  expect(res.status).toBe(200);
  expect(mockDispatch).not.toHaveBeenCalled();
});
