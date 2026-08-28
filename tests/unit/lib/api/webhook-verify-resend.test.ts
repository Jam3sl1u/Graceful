// Tests for verifyResendWebhook (#68) in lib/api/webhook-verify.ts. Mocks the
// `svix` SDK — no network calls, no real signature verification.

const mockVerify = jest.fn();

jest.mock("svix", () => ({
  Webhook: jest.fn().mockImplementation(() => ({ verify: mockVerify })),
}));

import { Webhook } from "svix";
import { verifyResendWebhook } from "@/lib/api/webhook-verify";

const mockWebhookCtor = Webhook as unknown as jest.Mock;

const SECRET = "whsec_test_secret";

function makeHeaders(overrides: Partial<Record<string, string>> = {}): Headers {
  const base: Record<string, string> = {
    "svix-id": "msg_123",
    "svix-timestamp": "1712345678",
    "svix-signature": "v1,signature",
    ...overrides,
  };
  const headers = new Headers();
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) headers.set(key, value);
  }
  return headers;
}

describe("verifyResendWebhook", () => {
  beforeEach(() => {
    mockWebhookCtor.mockClear();
    mockVerify.mockReset();
    process.env.RESEND_WEBHOOK_SECRET = SECRET;
  });

  afterEach(() => {
    delete process.env.RESEND_WEBHOOK_SECRET;
  });

  it("returns true on a valid signature", async () => {
    mockVerify.mockReturnValue({ type: "email.sent" });

    const result = await verifyResendWebhook("raw-body", makeHeaders());

    expect(result).toBe(true);
    expect(mockWebhookCtor).toHaveBeenCalledWith(SECRET);
    expect(mockVerify).toHaveBeenCalledWith("raw-body", {
      "svix-id": "msg_123",
      "svix-timestamp": "1712345678",
      "svix-signature": "v1,signature",
    });
  });

  it("returns false when svix verify() throws (bad signature)", async () => {
    mockVerify.mockImplementation(() => {
      throw new Error("bad signature");
    });

    const result = await verifyResendWebhook("raw-body", makeHeaders());

    expect(result).toBe(false);
  });

  it.each(["svix-id", "svix-timestamp", "svix-signature"])(
    "returns false without calling verify() when %s is missing",
    async (missingHeader) => {
      const headers = makeHeaders({ [missingHeader]: undefined });

      const result = await verifyResendWebhook("raw-body", headers);

      expect(result).toBe(false);
      expect(mockVerify).not.toHaveBeenCalled();
    },
  );

  it("rejects when RESEND_WEBHOOK_SECRET is missing", async () => {
    delete process.env.RESEND_WEBHOOK_SECRET;

    await expect(verifyResendWebhook("raw-body", makeHeaders())).rejects.toThrow(
      "Resend webhook is not configured — RESEND_WEBHOOK_SECRET must be set",
    );
    expect(mockWebhookCtor).not.toHaveBeenCalled();
  });

  it("rejects when RESEND_WEBHOOK_SECRET is an empty string", async () => {
    process.env.RESEND_WEBHOOK_SECRET = "";

    await expect(verifyResendWebhook("raw-body", makeHeaders())).rejects.toThrow(
      "Resend webhook is not configured — RESEND_WEBHOOK_SECRET must be set",
    );
  });
});
