// Supplementary tests written independently by the Tester stage for #67's
// change to GET /api/cron/invitation-reminders (the sendSms call-site
// migration to the options-object signature and status-based counters).
//
// The coder's own suite (cron-invitation-reminders-route.test.ts) exercises
// sendSms resolving "sent" and rejecting (smsFailed), and the pre-loop
// `!phone || sms_opted_in !== true` guard (via the tester-supplement file
// for #45). It does not exercise sendSms *resolving* with
// `{ status: "skipped", reason: ... }` from inside the try block — e.g. a
// row that passes the route's own coarse guard (has a phone, is opted in)
// but sendSms itself decides to skip (an unparseable phone number stored in
// the DB). Per spec §6, that must be counted as smsSkipped, not smsSent or
// smsFailed.

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

// As of #69 send_invitation_reminders returns { member_reminders, admin_reminders }.
function rpcOk(memberReminders: unknown[], adminReminders: unknown[] = []) {
  return {
    data: { member_reminders: memberReminders, admin_reminders: adminReminders },
    error: null,
  };
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

describe("GET /api/cron/invitation-reminders — issue #67 tester supplement", () => {
  it("counts a sendSms { status: 'skipped' } resolution as smsSkipped, not smsSent or smsFailed", async () => {
    const client = makeSupabaseClient(rpcOk([reminderRow()]));
    mockGetAnonSupabaseClient.mockReturnValue(client);
    mockSendSms.mockResolvedValue({ status: "skipped", reason: "invalid_phone" });

    const res = await GET(makeReq(`Bearer ${CRON_SECRET}`));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data).toEqual({
      processed: 1,
      smsSent: 0,
      smsSkipped: 1,
      smsFailed: 0,
      adminNotified: 0,
    });
  });

  it("calls sendSms with the options-object signature (to/body/smsOptedIn), not positional args", async () => {
    const client = makeSupabaseClient(rpcOk([reminderRow()]));
    mockGetAnonSupabaseClient.mockReturnValue(client);
    mockSendSms.mockResolvedValue({ status: "sent", messageId: "m1" });

    await GET(makeReq(`Bearer ${CRON_SECRET}`));

    expect(mockSendSms).toHaveBeenCalledTimes(1);
    const [arg] = mockSendSms.mock.calls[0] as [unknown];
    expect(arg).toMatchObject({
      to: "+15551234567",
      smsOptedIn: true,
    });
    expect(typeof (arg as { body: unknown }).body).toBe("string");
  });

  it("tallies sent, skipped, and failed independently across a mixed batch", async () => {
    const client = makeSupabaseClient(
      rpcOk([
        reminderRow({ invitation_id: "inv-1", phone: "+15551111111" }),
        reminderRow({ invitation_id: "inv-2", phone: "+15552222222" }),
        reminderRow({ invitation_id: "inv-3", phone: "+15553333333" }),
      ]),
    );
    mockGetAnonSupabaseClient.mockReturnValue(client);
    mockSendSms
      .mockResolvedValueOnce({ status: "sent", messageId: "m1" })
      .mockResolvedValueOnce({ status: "skipped", reason: "invalid_phone" })
      .mockRejectedValueOnce(new Error("Pingram send failed with status 500"));

    const res = await GET(makeReq(`Bearer ${CRON_SECRET}`));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data).toEqual({
      processed: 3,
      smsSent: 1,
      smsSkipped: 1,
      smsFailed: 1,
      adminNotified: 0,
    });
  });
});
