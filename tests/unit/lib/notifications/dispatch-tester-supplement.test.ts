// Tester-stage independent supplement for issue #69.
//
// The coding stage shipped tests/unit/lib/notifications/dispatch.test.ts. This
// file re-verifies the load-bearing guarantees from a different angle rather
// than trusting that suite:
//   - happy path: fan-out to multiple distinct recipients aggregates counts
//   - spec edge case 5: userId dedupe with more than one duplicate
//   - spec edge case 10: a null reason never renders as "null" / "Reason:" in
//     the real SMS + email copy (not a mock)
//   - spec edge case 8: appNotificationUrl with NEXT_PUBLIC_APP_URL unset yields
//     a relative link that the real email renderer rejects but the real SMS
//     builder accepts
//   - failure case: sendSms / sendEmail throwing SYNCHRONOUSLY (not a rejected
//     promise) is still swallowed and never propagates out of dispatchNotification

jest.mock("@/lib/pingram/client", () => ({ sendSms: jest.fn() }));
jest.mock("@/lib/resend/client", () => ({ sendEmail: jest.fn() }));

import { sendSms } from "@/lib/pingram/client";
import { sendEmail } from "@/lib/resend/client";
import { dispatchNotification, appNotificationUrl } from "@/lib/notifications/dispatch";
import { invitationDeniedSms, setInvitationSms } from "@/lib/notifications/sms-templates";
import { renderEmailTemplate } from "@/lib/resend/templates";

const mockSendSms = sendSms as unknown as jest.Mock;
const mockSendEmail = sendEmail as unknown as jest.Mock;

const EMAIL = {
  template: "set_invitation" as const,
  data: { date: "Aug 1, 2026", adminName: "Pat", link: "https://app.example.com/invite/x" },
};

let consoleErrorSpy: jest.SpyInstance;

beforeEach(() => {
  mockSendSms.mockReset();
  mockSendEmail.mockReset();
  mockSendSms.mockResolvedValue({ status: "sent" });
  mockSendEmail.mockResolvedValue({ id: "e1" });
  consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
});

describe("dispatchNotification — happy path (multi-recipient)", () => {
  it("sends one SMS and one email per distinct recipient and aggregates the counts", async () => {
    const counts = await dispatchNotification({
      recipients: [
        { userId: "a", name: "A", email: "a@x.com", phone: "+15551110000", smsOptedIn: true },
        { userId: "b", name: "B", email: "b@x.com", phone: "+15551110001", smsOptedIn: true },
        { userId: "c", name: "C", email: "c@x.com", phone: "+15551110002", smsOptedIn: true },
      ],
      sms: { body: "Graceful: heads up" },
      email: EMAIL,
    });

    expect(mockSendSms).toHaveBeenCalledTimes(3);
    expect(mockSendEmail).toHaveBeenCalledTimes(3);
    expect(counts).toEqual({
      smsSent: 3,
      smsSkipped: 0,
      smsFailed: 0,
      emailSent: 3,
      emailSkipped: 0,
      emailFailed: 0,
    });
  });

  it("mixes per-recipient outcomes into the right buckets", async () => {
    mockSendSms
      .mockResolvedValueOnce({ status: "sent" })
      .mockResolvedValueOnce({ status: "skipped", reason: "not_opted_in" })
      .mockRejectedValueOnce(new Error("dispatch failed"));

    const counts = await dispatchNotification({
      recipients: [
        { userId: "a", name: "A", email: "a@x.com", phone: "+15551110000", smsOptedIn: true },
        { userId: "b", name: "B", email: null, phone: "+15551110001", smsOptedIn: false },
        { userId: "c", name: "C", email: "c@x.com", phone: "+15551110002", smsOptedIn: true },
      ],
      sms: { body: "Graceful: heads up" },
      email: EMAIL,
    });

    expect(counts).toEqual({
      smsSent: 1,
      smsSkipped: 1,
      smsFailed: 1,
      emailSent: 2,
      emailSkipped: 1,
      emailFailed: 0,
    });
  });
});

describe("dispatchNotification — spec edge case 5 (dedupe)", () => {
  it("collapses three entries with the same userId to a single SMS + email", async () => {
    const counts = await dispatchNotification({
      recipients: [
        { userId: "dup", name: "First", email: "first@x.com", phone: "+15550000001", smsOptedIn: true },
        { userId: "dup", name: "Second", email: "second@x.com", phone: "+15550000002", smsOptedIn: true },
        { userId: "dup", name: "Third", email: "third@x.com", phone: "+15550000003", smsOptedIn: true },
      ],
      sms: { body: "Graceful: heads up" },
      email: EMAIL,
    });

    expect(mockSendSms).toHaveBeenCalledTimes(1);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    // first occurrence wins
    expect(mockSendEmail.mock.calls[0][0]).toBe("first@x.com");
    expect(counts).toMatchObject({ smsSent: 1, emailSent: 1 });
  });
});

describe("dispatchNotification — failure case (synchronous throws)", () => {
  it("never rejects when sendSms throws synchronously", async () => {
    mockSendSms.mockImplementation(() => {
      throw new Error("sync boom");
    });

    const counts = await dispatchNotification({
      recipients: [
        { userId: "a", name: "A", email: "a@x.com", phone: "+15551110000", smsOptedIn: true },
      ],
      sms: { body: "Graceful: heads up" },
      email: EMAIL,
    });

    expect(counts).toMatchObject({ smsFailed: 1, emailSent: 1 });
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("never rejects when both channels throw synchronously for every recipient", async () => {
    mockSendSms.mockImplementation(() => {
      throw new Error("sms sync boom");
    });
    mockSendEmail.mockImplementation(() => {
      throw new Error("email sync boom");
    });

    const counts = await dispatchNotification({
      recipients: [
        { userId: "a", name: "A", email: "a@x.com", phone: "+15551110000", smsOptedIn: true },
        { userId: "b", name: "B", email: "b@x.com", phone: "+15551110001", smsOptedIn: true },
      ],
      sms: { body: "Graceful: heads up" },
      email: EMAIL,
    });

    expect(counts).toEqual({
      smsSent: 0,
      smsSkipped: 0,
      smsFailed: 2,
      emailSent: 0,
      emailSkipped: 0,
      emailFailed: 2,
    });
  });
});

describe("spec edge case 10 — null reason in the real copy builders", () => {
  it("invitationDeniedSms omits the reason clause entirely", () => {
    const body = invitationDeniedSms({
      memberName: "Jordan",
      date: "Aug 1, 2026",
      reason: null,
      link: "https://app.example.com/week/w1",
    });

    expect(body).not.toMatch(/reason/i);
    expect(body).not.toContain("null");
  });

  it("the invitation_denied email preview omits the reason clause entirely", () => {
    const rendered = renderEmailTemplate("invitation_denied", {
      memberName: "Jordan",
      date: "Aug 1, 2026",
      reason: null,
      link: "https://app.example.com/week/w1",
    });

    expect(rendered.preview).not.toMatch(/reason/i);
    expect(rendered.preview).not.toContain("null");
    expect(rendered.text).not.toContain("null");
  });
});

describe("spec edge case 8 — relative link when NEXT_PUBLIC_APP_URL is unset", () => {
  const original = process.env.NEXT_PUBLIC_APP_URL;
  afterEach(() => {
    if (original === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = original;
  });

  it("produces a site-relative link that the email renderer rejects but the SMS builder accepts", () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    const link = appNotificationUrl("/week/w1");
    expect(link).toBe("/week/w1");

    expect(() =>
      renderEmailTemplate("set_invitation", { date: "Aug 1, 2026", adminName: "Pat", link }),
    ).toThrow(/absolute HTTPS URL/);

    // SMS builder must not throw on a relative link
    expect(() => setInvitationSms({ date: "Aug 1, 2026", roleNote: null, link })).not.toThrow();
  });
});
