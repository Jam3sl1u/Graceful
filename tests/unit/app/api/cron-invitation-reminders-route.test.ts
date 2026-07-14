// Tests for GET /api/cron/invitation-reminders (#45). Mock scaffolding
// mirrors tests/unit/app/api/invitations-withdraw-route.test.ts, but mocks
// @/lib/supabase/client (getAnonSupabaseClient) and @/lib/pingram/client
// (sendSms) instead of the Clerk-JWT client.

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

describe("GET /api/cron/invitation-reminders", () => {
  it("returns 401 when the Authorization header is missing or wrong (RPC never called)", async () => {
    const res = await GET(makeReq());
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(mockGetAnonSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 401 when the Authorization header does not match the secret", async () => {
    const res = await GET(makeReq("Bearer wrong-secret"));
    expect(res.status).toBe(401);
    expect(mockGetAnonSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 500 when CRON_SECRET is unset", async () => {
    delete process.env.CRON_SECRET;

    const res = await GET(makeReq(`Bearer ${CRON_SECRET}`));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
    expect(mockGetAnonSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 500 when the RPC returns an error", async () => {
    mockGetAnonSupabaseClient.mockReturnValue(
      makeSupabaseClient({ data: null, error: { message: "connection refused" } }),
    );

    const res = await GET(makeReq(`Bearer ${CRON_SECRET}`));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });

  it("happy path: dispatches SMS for opted-in members with a phone, skips others", async () => {
    const client = makeSupabaseClient({
      data: [
        reminderRow(),
        reminderRow({
          invitation_id: "inv-2",
          user_id: "user-2",
          phone: null,
          sms_opted_in: false,
        }),
      ],
      error: null,
    });
    mockGetAnonSupabaseClient.mockReturnValue(client);
    mockSendSms.mockResolvedValue(undefined);

    const res = await GET(makeReq(`Bearer ${CRON_SECRET}`));
    expect(res.status).toBe(200);

    expect(mockSendSms).toHaveBeenCalledTimes(1);
    expect(mockSendSms).toHaveBeenCalledWith("+15551234567", expect.stringContaining("Jane Doe"));

    const body = await res.json();
    expect(body.data).toEqual({ processed: 2, smsSent: 1, smsSkipped: 1, smsFailed: 0 });
  });

  it("isolates an sendSms failure: still returns 200 and counts smsFailed, job does not throw", async () => {
    const client = makeSupabaseClient({ data: [reminderRow()], error: null });
    mockGetAnonSupabaseClient.mockReturnValue(client);
    mockSendSms.mockRejectedValue(new Error("sendSms not implemented — see Sprint 4 #58"));

    const res = await GET(makeReq(`Bearer ${CRON_SECRET}`));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data).toEqual({ processed: 1, smsSent: 0, smsSkipped: 0, smsFailed: 1 });
  });

  it("returns processed: 0 with no SMS dispatch when there are no due invitations", async () => {
    const client = makeSupabaseClient({ data: [], error: null });
    mockGetAnonSupabaseClient.mockReturnValue(client);

    const res = await GET(makeReq(`Bearer ${CRON_SECRET}`));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data).toEqual({ processed: 0, smsSent: 0, smsSkipped: 0, smsFailed: 0 });
    expect(mockSendSms).not.toHaveBeenCalled();
  });
});
