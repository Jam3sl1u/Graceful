// Coder-stage coverage for #69 §3c — the admin SMS loop added to
// GET /api/cron/invitation-reminders. PRD §14: "Invitation reminder | Member +
// Admin | SMS" — SMS only, no email. Uses the real dispatchNotification with
// sendSms / sendEmail mocked so the "email is never attempted" guarantee is
// verified against the real helper.

jest.mock("@/lib/supabase/client", () => ({ getAnonSupabaseClient: jest.fn() }));
jest.mock("@/lib/pingram/client", () => ({ sendSms: jest.fn() }));
jest.mock("@/lib/resend/client", () => ({ sendEmail: jest.fn() }));

import type { NextRequest } from "next/server";
import { getAnonSupabaseClient } from "@/lib/supabase/client";
import { sendSms } from "@/lib/pingram/client";
import { sendEmail } from "@/lib/resend/client";
import { GET } from "@/app/api/cron/invitation-reminders/route";

const mockGetAnon = getAnonSupabaseClient as unknown as jest.Mock;
const mockSendSms = sendSms as unknown as jest.Mock;
const mockSendEmail = sendEmail as unknown as jest.Mock;

const CRON_SECRET = "test-cron-secret";

function makeReq(authHeader?: string): NextRequest {
  return {
    headers: { get: jest.fn((n: string) => (n === "authorization" && authHeader ? authHeader : null)) },
  } as unknown as NextRequest;
}
function rpcClient(data: unknown) {
  return { rpc: jest.fn().mockResolvedValue({ data, error: null }) };
}

const memberReminder = (o: Record<string, unknown> = {}) => ({
  invitation_id: "inv-1",
  user_id: "member-1",
  member_name: "Jane Member",
  phone: "+15551110000",
  sms_opted_in: true,
  service_week_id: "week-1",
  service_date: "2026-08-01",
  week_title: null,
  ...o,
});
const adminReminder = (o: Record<string, unknown> = {}) => ({
  user_id: "admin-1",
  name: "Alex Admin",
  phone: "+15559990000",
  sms_opted_in: true,
  service_week_id: "week-1",
  service_date: "2026-08-01",
  week_title: null,
  pending_count: 3,
  ...o,
});

beforeEach(() => {
  mockGetAnon.mockReset();
  mockSendSms.mockReset();
  mockSendEmail.mockReset();
  mockSendSms.mockResolvedValue({ status: "sent", messageId: "m1" });
  process.env.CRON_SECRET = CRON_SECRET;
});
afterEach(() => delete process.env.CRON_SECRET);

describe("GET /api/cron/invitation-reminders — admin SMS loop (§3c)", () => {
  it("sends an SMS per admin_reminders entry, uses the pending_count, and never calls sendEmail", async () => {
    mockGetAnon.mockReturnValue(
      rpcClient({
        member_reminders: [],
        admin_reminders: [adminReminder({ pending_count: 5 })],
      }),
    );

    const res = await GET(makeReq(`Bearer ${CRON_SECRET}`));
    expect(res.status).toBe(200);

    expect(mockSendSms).toHaveBeenCalledTimes(1);
    const arg = mockSendSms.mock.calls[0][0];
    expect(arg.to).toBe("+15559990000");
    expect(arg.body).toContain("5");
    expect(mockSendEmail).not.toHaveBeenCalled();

    const body = await res.json();
    expect(body.data).toEqual({
      processed: 0,
      smsSent: 1,
      smsSkipped: 0,
      smsFailed: 0,
      adminNotified: 1,
    });
  });

  it("aggregates member + admin counters across both loops", async () => {
    mockGetAnon.mockReturnValue(
      rpcClient({
        member_reminders: [memberReminder(), memberReminder({ invitation_id: "inv-2", phone: null })],
        admin_reminders: [
          adminReminder({ user_id: "admin-1" }),
          adminReminder({ user_id: "admin-2" }),
        ],
      }),
    );
    // member inv-1 sends; member inv-2 skipped (no phone); both admins send.
    mockSendSms
      .mockResolvedValueOnce({ status: "sent", messageId: "a" }) // member inv-1
      .mockResolvedValueOnce({ status: "sent", messageId: "b" }) // admin-1
      .mockResolvedValueOnce({ status: "sent", messageId: "c" }); // admin-2

    const res = await GET(makeReq(`Bearer ${CRON_SECRET}`));
    const body = await res.json();

    expect(body.data).toEqual({
      processed: 2,
      smsSent: 3,
      smsSkipped: 1,
      smsFailed: 0,
      adminNotified: 2,
    });
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("member loop behavior is unchanged: opted-out member is skipped before dispatch", async () => {
    mockGetAnon.mockReturnValue(
      rpcClient({
        member_reminders: [memberReminder({ sms_opted_in: false })],
        admin_reminders: [],
      }),
    );

    const res = await GET(makeReq(`Bearer ${CRON_SECRET}`));
    const body = await res.json();

    expect(mockSendSms).not.toHaveBeenCalled();
    expect(body.data).toEqual({
      processed: 1,
      smsSent: 0,
      smsSkipped: 1,
      smsFailed: 0,
      adminNotified: 0,
    });
  });

  it("an admin sendSms failure is isolated (smsFailed++) and still returns 200", async () => {
    mockGetAnon.mockReturnValue(
      rpcClient({ member_reminders: [], admin_reminders: [adminReminder()] }),
    );
    mockSendSms.mockRejectedValueOnce(new Error("Pingram 500"));

    const res = await GET(makeReq(`Bearer ${CRON_SECRET}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.smsFailed).toBe(1);
    expect(body.data.adminNotified).toBe(1);
  });
});
