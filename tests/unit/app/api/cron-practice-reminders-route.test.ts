// Coder-stage coverage for #69 OQ1 — GET /api/cron/practice-reminders.
// PRD §14: "Practice reminder | Confirmed members | SMS + Email". All the
// due-pair resolution + per-user lead time + idempotency lives in the
// send_practice_reminders RPC; this route just dispatches SMS + Email for each
// row it returns. Uses the real dispatchNotification with sendSms / sendEmail
// mocked.

jest.mock("@/lib/supabase/client", () => ({ getAnonSupabaseClient: jest.fn() }));
jest.mock("@/lib/pingram/client", () => ({ sendSms: jest.fn() }));
jest.mock("@/lib/resend/client", () => ({ sendEmail: jest.fn() }));

import type { NextRequest } from "next/server";
import { getAnonSupabaseClient } from "@/lib/supabase/client";
import { sendSms } from "@/lib/pingram/client";
import { sendEmail } from "@/lib/resend/client";
import { GET } from "@/app/api/cron/practice-reminders/route";

const mockGetAnon = getAnonSupabaseClient as unknown as jest.Mock;
const mockSendSms = sendSms as unknown as jest.Mock;
const mockSendEmail = sendEmail as unknown as jest.Mock;

const CRON_SECRET = "test-cron-secret";

function makeReq(authHeader?: string): NextRequest {
  return {
    headers: { get: jest.fn((n: string) => (n === "authorization" && authHeader ? authHeader : null)) },
  } as unknown as NextRequest;
}
function rpcClient(result: { data: unknown; error: unknown }) {
  return { rpc: jest.fn().mockResolvedValue(result) };
}

const reminderRow = (o: Record<string, unknown> = {}) => ({
  event_id: "event-1",
  user_id: "member-1",
  member_name: "Jane Member",
  email: "jane@example.com",
  phone: "+15551110000",
  sms_opted_in: true,
  event_name: "Saturday Rehearsal",
  location: "Main Hall",
  start_time: "2026-08-01T18:00:00.000Z",
  service_week_id: "week-1",
  reminder_hours_before: 24,
  ...o,
});

beforeEach(() => {
  mockGetAnon.mockReset();
  mockSendSms.mockReset();
  mockSendEmail.mockReset();
  mockSendSms.mockResolvedValue({ status: "sent", messageId: "m1" });
  mockSendEmail.mockResolvedValue({ id: "e1" });
  process.env.CRON_SECRET = CRON_SECRET;
});
afterEach(() => delete process.env.CRON_SECRET);

describe("GET /api/cron/practice-reminders", () => {
  it("401s without the CRON_SECRET bearer and never calls the RPC", async () => {
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
    expect(mockGetAnon).not.toHaveBeenCalled();
  });

  it("500s when the RPC errors", async () => {
    mockGetAnon.mockReturnValue(rpcClient({ data: null, error: { message: "boom" } }));
    const res = await GET(makeReq(`Bearer ${CRON_SECRET}`));
    expect(res.status).toBe(500);
  });

  it("dispatches SMS + Email for each reminder and reports the counters", async () => {
    mockGetAnon.mockReturnValue(rpcClient({ data: [reminderRow()], error: null }));

    const res = await GET(makeReq(`Bearer ${CRON_SECRET}`));
    expect(res.status).toBe(200);

    expect(mockSendSms).toHaveBeenCalledTimes(1);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const [, template, data] = mockSendEmail.mock.calls[0];
    expect(template).toBe("practice_reminder");
    expect(data.eventName).toBe("Saturday Rehearsal");
    expect(data.location).toBe("Main Hall");

    const body = await res.json();
    expect(body.data).toMatchObject({
      processed: 1,
      smsSent: 1,
      emailSent: 1,
    });
  });

  it("null location falls back to 'TBD' for the email template", async () => {
    mockGetAnon.mockReturnValue(rpcClient({ data: [reminderRow({ location: null })], error: null }));

    await GET(makeReq(`Bearer ${CRON_SECRET}`));
    const [, , data] = mockSendEmail.mock.calls[0];
    expect(data.location).toBe("TBD");
  });

  it("returns zeroed counters when there are no due reminders", async () => {
    mockGetAnon.mockReturnValue(rpcClient({ data: [], error: null }));

    const res = await GET(makeReq(`Bearer ${CRON_SECRET}`));
    const body = await res.json();
    expect(body.data.processed).toBe(0);
    expect(mockSendSms).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("a total dispatch failure still returns 200", async () => {
    mockGetAnon.mockReturnValue(rpcClient({ data: [reminderRow()], error: null }));
    mockSendSms.mockRejectedValue(new Error("Pingram down"));
    mockSendEmail.mockRejectedValue(new Error("Resend down"));

    const res = await GET(makeReq(`Bearer ${CRON_SECRET}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({ processed: 1, smsFailed: 1, emailFailed: 1 });
  });
});
