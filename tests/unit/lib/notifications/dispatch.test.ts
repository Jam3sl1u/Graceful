// Coder-stage unit coverage for #69's lib/notifications/dispatch.ts:
// dispatchNotification (the SMS + Email fan-out helper every trigger path
// calls) and appNotificationUrl. sendSms / sendEmail are mocked — this file
// exercises the helper's own dedupe / skip / never-throw / PII-safe-logging
// behavior (spec edge cases 1-8 and 15).

jest.mock("@/lib/pingram/client", () => ({ sendSms: jest.fn() }));
jest.mock("@/lib/resend/client", () => ({ sendEmail: jest.fn() }));

import { sendSms } from "@/lib/pingram/client";
import { sendEmail } from "@/lib/resend/client";
import { dispatchNotification, appNotificationUrl } from "@/lib/notifications/dispatch";
import type { NotificationRecipient } from "@/lib/notifications/dispatch";

const mockSendSms = sendSms as unknown as jest.Mock;
const mockSendEmail = sendEmail as unknown as jest.Mock;

function recipient(overrides: Partial<NotificationRecipient> = {}): NotificationRecipient {
  return {
    userId: "user-1",
    name: "Jane Doe",
    email: "jane@example.com",
    phone: "+15551234567",
    smsOptedIn: true,
    ...overrides,
  };
}

const SMS = { body: "Graceful: test message" };
const EMAIL = {
  template: "set_invitation" as const,
  data: { date: "Aug 1, 2026", adminName: "Pat", link: "https://app.example.com/invite/x" },
};

let consoleErrorSpy: jest.SpyInstance;

beforeEach(() => {
  mockSendSms.mockReset();
  mockSendEmail.mockReset();
  mockSendSms.mockResolvedValue({ status: "sent", messageId: "m1" });
  mockSendEmail.mockResolvedValue({ id: "e1" });
  consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
});

describe("appNotificationUrl", () => {
  const original = process.env.NEXT_PUBLIC_APP_URL;
  afterEach(() => {
    if (original === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = original;
  });

  it("prepends NEXT_PUBLIC_APP_URL with trailing slashes stripped", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com///";
    expect(appNotificationUrl("/week/abc")).toBe("https://app.example.com/week/abc");
  });

  it("returns a site-relative path when NEXT_PUBLIC_APP_URL is unset (edge case 8)", () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(appNotificationUrl("/week/abc")).toBe("/week/abc");
  });
});

describe("dispatchNotification", () => {
  it("happy path: one SMS + one email, all counters reflect success", async () => {
    const counts = await dispatchNotification({ recipients: [recipient()], sms: SMS, email: EMAIL });

    expect(mockSendSms).toHaveBeenCalledTimes(1);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(counts).toEqual({
      smsSent: 1,
      smsSkipped: 0,
      smsFailed: 0,
      emailSent: 1,
      emailSkipped: 0,
      emailFailed: 0,
    });
  });

  it("edge 1: sms_opted_in false -> sendSms resolves skipped -> smsSkipped, no email counters touched when email omitted", async () => {
    mockSendSms.mockResolvedValue({ status: "skipped", reason: "not_opted_in" });

    const counts = await dispatchNotification({
      recipients: [recipient({ smsOptedIn: false })],
      sms: SMS,
    });

    expect(counts.smsSkipped).toBe(1);
    expect(counts.smsSent).toBe(0);
    expect(counts.emailSent).toBe(0);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("edge 2: unnormalizable phone -> sendSms resolves skipped -> smsSkipped", async () => {
    mockSendSms.mockResolvedValue({ status: "skipped", reason: "invalid_phone" });

    const counts = await dispatchNotification({ recipients: [recipient({ phone: "abc" })], sms: SMS });

    expect(counts).toMatchObject({ smsSkipped: 1, smsSent: 0, smsFailed: 0 });
  });

  it("edge 3: null / whitespace email -> emailSkipped, sendEmail not called, SMS still runs", async () => {
    const counts = await dispatchNotification({
      recipients: [recipient({ email: "   " }), recipient({ userId: "user-2", email: null })],
      sms: SMS,
      email: EMAIL,
    });

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockSendSms).toHaveBeenCalledTimes(2);
    expect(counts).toMatchObject({ emailSkipped: 2, emailSent: 0, smsSent: 2 });
  });

  it("edge 4: zero recipients -> no send calls, no throw, all counters 0", async () => {
    const counts = await dispatchNotification({ recipients: [], sms: SMS, email: EMAIL });

    expect(mockSendSms).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(counts).toEqual({
      smsSent: 0,
      smsSkipped: 0,
      smsFailed: 0,
      emailSent: 0,
      emailSkipped: 0,
      emailFailed: 0,
    });
  });

  it("edge 5: duplicate userId -> exactly one SMS and one email (first occurrence wins)", async () => {
    const counts = await dispatchNotification({
      recipients: [
        recipient({ userId: "dup", name: "First" }),
        recipient({ userId: "dup", name: "Second" }),
      ],
      sms: SMS,
      email: EMAIL,
    });

    expect(mockSendSms).toHaveBeenCalledTimes(1);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(counts).toMatchObject({ smsSent: 1, emailSent: 1 });
  });

  it("edge 6: sendSms throws -> smsFailed, logged, promise still resolves", async () => {
    mockSendSms.mockRejectedValue(new Error("Pingram send failed with status 500"));

    const counts = await dispatchNotification({ recipients: [recipient()], sms: SMS });

    expect(counts.smsFailed).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("edge 7: sendEmail throws -> emailFailed, promise still resolves, SMS unaffected", async () => {
    mockSendEmail.mockRejectedValue(new Error("Resend email dispatch failed"));

    const counts = await dispatchNotification({ recipients: [recipient()], sms: SMS, email: EMAIL });

    expect(counts).toMatchObject({ emailFailed: 1, emailSent: 0, smsSent: 1 });
  });

  it("edge 8: a link-validation throw from sendEmail is emailFailed while the SMS still sends", async () => {
    mockSendEmail.mockRejectedValue(new Error("Email template link must be an absolute HTTPS URL"));

    const counts = await dispatchNotification({ recipients: [recipient()], sms: SMS, email: EMAIL });

    expect(counts.emailFailed).toBe(1);
    expect(counts.smsSent).toBe(1);
  });

  it("omitting sms -> the SMS channel is never attempted", async () => {
    const counts = await dispatchNotification({ recipients: [recipient()], email: EMAIL });

    expect(mockSendSms).not.toHaveBeenCalled();
    expect(counts).toMatchObject({ smsSent: 0, smsSkipped: 0, smsFailed: 0, emailSent: 1 });
  });

  it("edge 15: failure logging includes the userId and error only — never phone/email/body/subject", async () => {
    mockSendSms.mockRejectedValue(new Error("boom-sms"));
    mockSendEmail.mockRejectedValue(new Error("boom-email"));

    await dispatchNotification({
      recipients: [
        recipient({
          userId: "user-secret",
          phone: "+15559999999",
          email: "secret@example.com",
        }),
      ],
      sms: { body: "TOP SECRET SMS BODY" },
      email: EMAIL,
    });

    const logged = consoleErrorSpy.mock.calls.flat().map((v) => String(v)).join(" | ");
    expect(logged).toContain("user-secret");
    expect(logged).not.toContain("+15559999999");
    expect(logged).not.toContain("secret@example.com");
    expect(logged).not.toContain("TOP SECRET SMS BODY");
  });
});
