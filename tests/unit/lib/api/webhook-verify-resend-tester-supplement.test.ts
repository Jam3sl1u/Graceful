// Supplementary tests written independently by the Tester stage for #68
// (verifyResendWebhook in lib/api/webhook-verify.ts).
//
// The coder's own webhook-verify-resend.test.ts covers the happy path,
// verify() throwing, and each svix header being entirely *absent*
// (`headers.set` never called for that key). It does not cover a header
// that is present but set to an empty string — a distinct case for
// `Headers` (`get()` returns `""`, not `null`), and a plausible mutation
// (e.g. swapping `!svixId` for `svixId === null`) would let an empty
// header slip through to `verify()` instead of short-circuiting to
// `false`.

const mockVerify = jest.fn();

jest.mock("svix", () => ({
  Webhook: jest.fn().mockImplementation(() => ({ verify: mockVerify })),
}));

import { Webhook } from "svix";
import { verifyResendWebhook } from "@/lib/api/webhook-verify";

const mockWebhookCtor = Webhook as unknown as jest.Mock;

const SECRET = "whsec_test_secret";

describe("verifyResendWebhook — tester supplement", () => {
  beforeEach(() => {
    mockWebhookCtor.mockClear();
    mockVerify.mockReset();
    process.env.RESEND_WEBHOOK_SECRET = SECRET;
  });

  afterEach(() => {
    delete process.env.RESEND_WEBHOOK_SECRET;
  });

  it.each(["svix-id", "svix-timestamp", "svix-signature"])(
    "returns false without calling verify() when %s is present but an empty string",
    async (emptyHeader) => {
      const headers = new Headers({
        "svix-id": "msg_123",
        "svix-timestamp": "1712345678",
        "svix-signature": "v1,signature",
      });
      headers.set(emptyHeader, "");

      const result = await verifyResendWebhook("raw-body", headers);

      expect(result).toBe(false);
      expect(mockVerify).not.toHaveBeenCalled();
    },
  );

  it("does not swallow a constructor throw (malformed secret is a config error, not a bad signature)", async () => {
    mockWebhookCtor.mockImplementationOnce(() => {
      throw new Error("malformed webhook secret");
    });
    const headers = new Headers({
      "svix-id": "msg_123",
      "svix-timestamp": "1712345678",
      "svix-signature": "v1,signature",
    });

    await expect(verifyResendWebhook("raw-body", headers)).rejects.toThrow(
      "malformed webhook secret",
    );
    expect(mockVerify).not.toHaveBeenCalled();
  });
});
