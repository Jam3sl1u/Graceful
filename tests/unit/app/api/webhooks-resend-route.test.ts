// Tests for POST /api/webhooks/resend (#68). Mock scaffolding mirrors
// tests/unit/app/api/cron-invitation-reminders-route.test.ts (jest.mock the
// collaborators, fake NextRequest). Mocks @/lib/api/webhook-verify and
// @/lib/resend/client — no network calls.

jest.mock("@/lib/api/webhook-verify", () => ({ verifyResendWebhook: jest.fn() }));
jest.mock("@/lib/resend/client", () => ({ mapResendEventToStatus: jest.fn() }));

import type { NextRequest } from "next/server";
import { verifyResendWebhook } from "@/lib/api/webhook-verify";
import { mapResendEventToStatus } from "@/lib/resend/client";
import { POST } from "@/app/api/webhooks/resend/route";

const mockVerifyResendWebhook = verifyResendWebhook as unknown as jest.Mock;
const mockMapResendEventToStatus = mapResendEventToStatus as unknown as jest.Mock;

function makeReq(rawBody: string): NextRequest {
  const textMock = jest.fn().mockResolvedValue(rawBody);
  const jsonMock = jest.fn().mockRejectedValue(new Error("req.json() must not be called"));
  return {
    text: textMock,
    json: jsonMock,
    headers: new Headers({
      "svix-id": "msg_123",
      "svix-timestamp": "1712345678",
      "svix-signature": "v1,signature",
    }),
  } as unknown as NextRequest;
}

beforeEach(() => {
  mockVerifyResendWebhook.mockReset();
  mockMapResendEventToStatus.mockReset();
});

describe("POST /api/webhooks/resend", () => {
  it("valid signed email.delivered payload: 200 with { received: true, emailId, status }", async () => {
    mockVerifyResendWebhook.mockResolvedValue(true);
    mockMapResendEventToStatus.mockReturnValue("delivered");
    const req = makeReq(JSON.stringify({ type: "email.delivered", data: { email_id: "email-1" } }));

    const res = await POST(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data).toEqual({ received: true, emailId: "email-1", status: "delivered" });
    expect(req.json).not.toHaveBeenCalled();
    expect(req.text).toHaveBeenCalled();
  });

  it("bad signature: 401 + UNAUTHENTICATED, JSON.parse is never reached", async () => {
    mockVerifyResendWebhook.mockResolvedValue(false);
    const req = makeReq(JSON.stringify({ type: "email.delivered", data: { email_id: "email-1" } }));

    const res = await POST(req);
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(mockMapResendEventToStatus).not.toHaveBeenCalled();
  });

  it("bad signature short-circuits before malformed JSON is parsed", async () => {
    mockVerifyResendWebhook.mockResolvedValue(false);

    const res = await POST(makeReq("not-json{{{"));

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(mockMapResendEventToStatus).not.toHaveBeenCalled();
  });

  it("verify throws: 500 + INTERNAL", async () => {
    mockVerifyResendWebhook.mockRejectedValue(
      new Error("Resend webhook is not configured — RESEND_WEBHOOK_SECRET must be set"),
    );
    const req = makeReq(JSON.stringify({ type: "email.delivered", data: { email_id: "email-1" } }));

    const res = await POST(req);
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.code).toBe("INTERNAL");
  });

  it("malformed JSON body: 400 + VALIDATION_FAILED", async () => {
    mockVerifyResendWebhook.mockResolvedValue(true);
    const req = makeReq("not-json{{{");

    const res = await POST(req);
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("missing data.email_id: 400 + VALIDATION_FAILED", async () => {
    mockVerifyResendWebhook.mockResolvedValue(true);
    const req = makeReq(JSON.stringify({ type: "email.delivered", data: {} }));

    const res = await POST(req);
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("non-email event: 200 ignored without requiring email_id or mapping a status", async () => {
    mockVerifyResendWebhook.mockResolvedValue(true);
    const req = makeReq(JSON.stringify({ type: "contact.created", data: { contact_id: "contact-1" } }));

    const res = await POST(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data).toEqual({ received: true, status: "ignored" });
    expect(mockMapResendEventToStatus).not.toHaveBeenCalled();
  });

  it("logs delivery events but suppresses high-volume engagement events", async () => {
    mockVerifyResendWebhook.mockResolvedValue(true);
    const consoleInfo = jest.spyOn(console, "info").mockImplementation();

    mockMapResendEventToStatus.mockReturnValue("delivered");
    await POST(makeReq(JSON.stringify({ type: "email.delivered", data: { email_id: "email-1" } })));
    expect(consoleInfo).toHaveBeenCalledWith("resend webhook", {
      type: "email.delivered",
      emailId: "email-1",
      status: "delivered",
    });

    consoleInfo.mockClear();
    mockMapResendEventToStatus.mockReturnValue("opened");
    await POST(makeReq(JSON.stringify({ type: "email.opened", data: { email_id: "email-1" } })));
    expect(consoleInfo).not.toHaveBeenCalled();

    mockMapResendEventToStatus.mockReturnValue("clicked");
    await POST(makeReq(JSON.stringify({ type: "email.clicked", data: { email_id: "email-1" } })));
    expect(consoleInfo).not.toHaveBeenCalled();
    consoleInfo.mockRestore();
  });

  it("missing type: 400 + VALIDATION_FAILED", async () => {
    mockVerifyResendWebhook.mockResolvedValue(true);
    const req = makeReq(JSON.stringify({ data: { email_id: "email-1" } }));

    const res = await POST(req);
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe("VALIDATION_FAILED");
  });

  it("unknown event type: 200 with status: 'ignored', never 4xx", async () => {
    mockVerifyResendWebhook.mockResolvedValue(true);
    mockMapResendEventToStatus.mockReturnValue(null);
    const req = makeReq(JSON.stringify({ type: "email.unsubscribed", data: { email_id: "email-1" } }));

    const res = await POST(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data).toEqual({ received: true, emailId: "email-1", status: "ignored" });
  });
});
