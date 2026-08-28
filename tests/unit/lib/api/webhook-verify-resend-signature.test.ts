// Real Svix signature coverage for verifyResendWebhook. This intentionally
// does not mock `svix`, complementing the mocked branch/error-path suites.

import { Webhook } from "svix";
import { verifyResendWebhook } from "@/lib/api/webhook-verify";

const SECRET = `whsec_${Buffer.from("resend-test-secret").toString("base64")}`;
const OTHER_SECRET = `whsec_${Buffer.from("other-resend-test-secret").toString("base64")}`;
const MESSAGE_ID = "msg_resend_signature_test";
const PAYLOAD = JSON.stringify({ type: "email.delivered", data: { email_id: "email-1" } });

function signedHeaders(secret: string, payload: string, timestamp = new Date()): Headers {
  const webhook = new Webhook(secret);
  return new Headers({
    "svix-id": MESSAGE_ID,
    "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
    "svix-signature": webhook.sign(MESSAGE_ID, timestamp, payload),
  });
}

describe("verifyResendWebhook — real Svix signatures", () => {
  beforeEach(() => {
    process.env.RESEND_WEBHOOK_SECRET = SECRET;
  });

  afterEach(() => {
    delete process.env.RESEND_WEBHOOK_SECRET;
  });

  it("accepts a payload signed with the configured secret", async () => {
    await expect(verifyResendWebhook(PAYLOAD, signedHeaders(SECRET, PAYLOAD))).resolves.toBe(true);
  });

  it("rejects a body changed after signing", async () => {
    await expect(
      verifyResendWebhook(`${PAYLOAD} `, signedHeaders(SECRET, PAYLOAD)),
    ).resolves.toBe(false);
  });

  it("rejects a payload signed with another valid secret", async () => {
    await expect(verifyResendWebhook(PAYLOAD, signedHeaders(OTHER_SECRET, PAYLOAD))).resolves.toBe(false);
  });

  it("rejects a payload outside Svix's timestamp tolerance", async () => {
    const staleTimestamp = new Date(Date.now() - 10 * 60 * 1000);
    await expect(
      verifyResendWebhook(PAYLOAD, signedHeaders(SECRET, PAYLOAD, staleTimestamp)),
    ).resolves.toBe(false);
  });
});
