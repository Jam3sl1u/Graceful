// Supplementary tests written independently by the Tester stage for #45
// (GET /api/cron/invitation-reminders).
//
// The coder's own cron-invitation-reminders-route.test.ts covers the auth
// gates, RPC error, sendSms rejection, and the empty-array case well, but
// leaves a couple of gaps this file closes:
//   1. Its only "skipped" fixture combines *both* `phone: null` AND
//      `sms_opted_in: false` in the same row. The handler's skip condition
//      is `!phone || sms_opted_in !== true` (OR) — but a regression that
//      swapped this to `!phone && sms_opted_in !== true` (AND) would
//      produce an identical result for that combined row (still skips) and
//      would still pass the coder's suite, while incorrectly dispatching
//      SMS for phone-present-but-opted-out or phone-absent-but-opted-in
//      members in production. This file exercises each condition alone.
//   2. The route defensively does `data ?? []` (spec/route contract), but
//      no test exercises the RPC actually resolving `{ data: null, error:
//      null }` (a plausible Supabase client shape distinct from
//      `{ data: [], error: null }`) — only the empty-array shape is tested.

jest.mock("@/lib/supabase/client", () => ({ getAnonSupabaseClient: jest.fn() }));
jest.mock("@/lib/pingram/client", () => ({ sendSms: jest.fn() }));

import type { NextRequest } from "next/server";
import { getAnonSupabaseClient } from "@/lib/supabase/client";
import { sendSms } from "@/lib/pingram/client";
import { GET } from "@/app/api/cron/invitation-reminders/route";

const mockGetAnonSupabaseClient = getAnonSupabaseClient as unknown as jest.Mock;
const mockSendSms = sendSms as unknown as jest.Mock;

const CRON_SECRET = "test-cron-secret";

function makeReq(authHeader?: string): NextRequest {
  return {
    headers: {
      get: jest.fn((name: string) => (name === "authorization" && authHeader ? authHeader : null)),
    },
  } as unknown as NextRequest;
}

function makeSupabaseClient(rpcResult: { data: unknown; error: unknown }) {
  return { rpc: jest.fn().mockResolvedValue(rpcResult) };
}

const reminderRow = (overrides: Partial<Record<string, unknown>> = {}) => ({
  invitation_id: "inv-1",
  user_id: "user-1",
  member_name: "Jane Doe",
  phone: "+15551234567",
  sms_opted_in: true,
  service_week_id: "week-1",
  service_date: "2026-08-01",
  week_title: null,
  ...overrides,
});

beforeEach(() => {
  mockGetAnonSupabaseClient.mockReset();
  mockSendSms.mockReset();
  process.env.CRON_SECRET = CRON_SECRET;
});

afterEach(() => {
  delete process.env.CRON_SECRET;
});

describe("GET /api/cron/invitation-reminders — tester supplement", () => {
  it("skips SMS for a member with a phone but sms_opted_in: false (phone alone is not sufficient)", async () => {
    const client = makeSupabaseClient({
      data: [reminderRow({ phone: "+15559876543", sms_opted_in: false })],
      error: null,
    });
    mockGetAnonSupabaseClient.mockReturnValue(client);

    const res = await GET(makeReq(`Bearer ${CRON_SECRET}`));
    expect(res.status).toBe(200);
    expect(mockSendSms).not.toHaveBeenCalled();

    const body = await res.json();
    expect(body.data).toEqual({ processed: 1, smsSent: 0, smsSkipped: 1, smsFailed: 0 });
  });

  it("skips SMS for a member opted in but with no phone on file (opt-in alone is not sufficient)", async () => {
    const client = makeSupabaseClient({
      data: [reminderRow({ phone: null, sms_opted_in: true })],
      error: null,
    });
    mockGetAnonSupabaseClient.mockReturnValue(client);

    const res = await GET(makeReq(`Bearer ${CRON_SECRET}`));
    expect(res.status).toBe(200);
    expect(mockSendSms).not.toHaveBeenCalled();

    const body = await res.json();
    expect(body.data).toEqual({ processed: 1, smsSent: 0, smsSkipped: 1, smsFailed: 0 });
  });

  it("treats an RPC response of { data: null, error: null } the same as an empty array", async () => {
    const client = makeSupabaseClient({ data: null, error: null });
    mockGetAnonSupabaseClient.mockReturnValue(client);

    const res = await GET(makeReq(`Bearer ${CRON_SECRET}`));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data).toEqual({ processed: 0, smsSent: 0, smsSkipped: 0, smsFailed: 0 });
    expect(mockSendSms).not.toHaveBeenCalled();
  });
});
