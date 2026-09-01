// Coverage for #69 OQ1 — GET /api/cron/practice-reminders.
// PRD §14: "Practice reminder | Confirmed members | SMS + Email". The claim of
// due (event × confirmed member) pairs + per-user lead time + per-user channel
// choice lives in the secret-gated send_practice_reminders(secret) RPC; the
// delivery confirmation is the separate secret-gated
// confirm_practice_reminder_sent(secret, event, user) RPC (review B2 / B2-R1 /
// B2-R2 / M3 — the secret gate + claim/confirm keeps a stray anon call from
// permanently suppressing reminders, and a transient failure is retried not
// lost). This route dispatches the enabled channels for each row, then confirms
// the pair only after a clean dispatch. Uses the real dispatchNotification with
// sendSms / sendEmail mocked.

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

// Route the two RPCs the handler calls: send_practice_reminders (the row list)
// and confirm_practice_reminder_sent (returns boolean). Both receive the secret
// as their first argument.
function rpcClient(opts: {
  reminders?: { data: unknown; error: unknown };
  confirm?: { data: unknown; error: unknown };
}) {
  const reminders = opts.reminders ?? { data: [], error: null };
  const confirm = opts.confirm ?? { data: true, error: null };
  const rpc = jest.fn((name: string) =>
    Promise.resolve(name === "confirm_practice_reminder_sent" ? confirm : reminders),
  );
  return { rpc };
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
  reminder_sms: true,
  reminder_email: true,
  sms_done: false,
  email_done: false,
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

  it("passes the cron secret through to send_practice_reminders", async () => {
    const client = rpcClient({ reminders: { data: [], error: null } });
    mockGetAnon.mockReturnValue(client);

    await GET(makeReq(`Bearer ${CRON_SECRET}`));
    expect(client.rpc).toHaveBeenCalledWith("send_practice_reminders", {
      p_cron_secret: CRON_SECRET,
    });
  });

  it("500s when the RPC errors (e.g. the secret is not seeded → FORBIDDEN)", async () => {
    mockGetAnon.mockReturnValue(rpcClient({ reminders: { data: null, error: { message: "FORBIDDEN" } } }));
    const res = await GET(makeReq(`Bearer ${CRON_SECRET}`));
    expect(res.status).toBe(500);
  });

  it("dispatches SMS + Email for each reminder and reports the counters", async () => {
    mockGetAnon.mockReturnValue(rpcClient({ reminders: { data: [reminderRow()], error: null } }));

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
      confirmed: 1,
    });
  });

  it("honours per-user channel choice: reminder_email false → no email, reminder_sms false → no sms", async () => {
    mockGetAnon.mockReturnValue(
      rpcClient({
        reminders: {
          data: [
            reminderRow({ user_id: "sms-only", reminder_email: false }),
            reminderRow({ event_id: "event-2", user_id: "email-only", reminder_sms: false }),
          ],
          error: null,
        },
      }),
    );

    await GET(makeReq(`Bearer ${CRON_SECRET}`));

    expect(mockSendSms).toHaveBeenCalledTimes(1);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
  });

  it("skips the channel already marked done and only re-sends the outstanding one (review MED-1)", async () => {
    // Prior attempt: SMS succeeded, email failed. This run must send email only.
    const client = rpcClient({
      reminders: {
        data: [reminderRow({ sms_done: true, email_done: false })],
        error: null,
      },
    });
    mockGetAnon.mockReturnValue(client);

    await GET(makeReq(`Bearer ${CRON_SECRET}`));

    expect(mockSendSms).not.toHaveBeenCalled();
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(client.rpc).toHaveBeenCalledWith("confirm_practice_reminder_sent", {
      p_cron_secret: CRON_SECRET,
      p_event_id: "event-1",
      p_user_id: "member-1",
      p_sms_done: true,
      p_email_done: true,
    });
  });

  it("null location falls back to 'TBD' for the email template", async () => {
    mockGetAnon.mockReturnValue(
      rpcClient({ reminders: { data: [reminderRow({ location: null })], error: null } }),
    );

    await GET(makeReq(`Bearer ${CRON_SECRET}`));
    const [, , data] = mockSendEmail.mock.calls[0];
    expect(data.location).toBe("TBD");
  });

  it("returns zeroed counters when there are no due reminders", async () => {
    mockGetAnon.mockReturnValue(rpcClient({ reminders: { data: [], error: null } }));

    const res = await GET(makeReq(`Bearer ${CRON_SECRET}`));
    const body = await res.json();
    expect(body.data.processed).toBe(0);
    expect(mockSendSms).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("a total dispatch failure still returns 200 and marks neither channel done (review M3 / B2-R2)", async () => {
    const client = rpcClient({ reminders: { data: [reminderRow()], error: null } });
    mockGetAnon.mockReturnValue(client);
    mockSendSms.mockRejectedValue(new Error("Pingram down"));
    mockSendEmail.mockRejectedValue(new Error("Resend down"));

    const res = await GET(makeReq(`Bearer ${CRON_SECRET}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({ processed: 1, smsFailed: 1, emailFailed: 1 });
    // Both channels hard-failed → confirm is still called, but with both flags
    // false, so the selector re-picks the pair next run (bounded to 3 attempts).
    expect(client.rpc).toHaveBeenCalledWith("confirm_practice_reminder_sent", {
      p_cron_secret: CRON_SECRET,
      p_event_id: "event-1",
      p_user_id: "member-1",
      p_sms_done: false,
      p_email_done: false,
    });
  });

  it("partial failure: SMS sends, email fails → sms_done true, email_done false", async () => {
    const client = rpcClient({ reminders: { data: [reminderRow()], error: null } });
    mockGetAnon.mockReturnValue(client);
    mockSendEmail.mockRejectedValue(new Error("Resend down"));

    await GET(makeReq(`Bearer ${CRON_SECRET}`));

    expect(client.rpc).toHaveBeenCalledWith("confirm_practice_reminder_sent", {
      p_cron_secret: CRON_SECRET,
      p_event_id: "event-1",
      p_user_id: "member-1",
      p_sms_done: true,
      p_email_done: false,
    });
  });

  it("confirms each pair via confirm_practice_reminder_sent after a clean dispatch", async () => {
    const client = rpcClient({
      reminders: {
        data: [reminderRow(), reminderRow({ event_id: "event-2", user_id: "member-2" })],
        error: null,
      },
    });
    mockGetAnon.mockReturnValue(client);

    const res = await GET(makeReq(`Bearer ${CRON_SECRET}`));
    const body = await res.json();

    expect(body.data).toMatchObject({ processed: 2, confirmed: 2 });
    expect(client.rpc).toHaveBeenCalledWith("confirm_practice_reminder_sent", {
      p_cron_secret: CRON_SECRET,
      p_event_id: "event-1",
      p_user_id: "member-1",
      p_sms_done: true,
      p_email_done: true,
    });
    expect(client.rpc).toHaveBeenCalledWith("confirm_practice_reminder_sent", {
      p_cron_secret: CRON_SECRET,
      p_event_id: "event-2",
      p_user_id: "member-2",
      p_sms_done: true,
      p_email_done: true,
    });
  });

  it("does not count a pair the confirm RPC reports as unchanged", async () => {
    const client = rpcClient({
      reminders: { data: [reminderRow()], error: null },
      confirm: { data: false, error: null },
    });
    mockGetAnon.mockReturnValue(client);

    const res = await GET(makeReq(`Bearer ${CRON_SECRET}`));
    const body = await res.json();
    expect(body.data).toMatchObject({ processed: 1, smsSent: 1, emailSent: 1, confirmed: 0 });
  });
});
