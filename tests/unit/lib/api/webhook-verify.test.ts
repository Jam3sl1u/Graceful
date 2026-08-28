import { createHmac } from "crypto";
import { verifyPingramWebhook } from "@/lib/api/webhook-verify";

const SECRET = "test-webhook-secret";
const TRACKING_ID = "tracking-1";

function sign(timestamp: string, rawBody: string): string {
  return createHmac("sha256", SECRET)
    .update(`${TRACKING_ID}.${timestamp}.${rawBody}`)
    .digest("hex");
}

function headersFor(overrides: Partial<{ id: string | null; signature: string | null; timestamp: string | null }>) {
  const map = new Map<string, string>();
  for (const [name, value] of Object.entries({
    "x-pingram-id": overrides.id ?? TRACKING_ID,
    "x-pingram-signature": overrides.signature,
    "x-pingram-timestamp": overrides.timestamp,
  })) {
    if (value !== null && value !== undefined) map.set(name, value);
  }
  return { get: (name: string) => map.get(name.toLowerCase()) ?? null } as unknown as Headers;
}

beforeEach(() => {
  process.env.PINGRAM_WEBHOOK_SECRET = SECRET;
});

afterEach(() => {
  delete process.env.PINGRAM_WEBHOOK_SECRET;
});

describe("verifyPingramWebhook", () => {
  it("throws when its secret is unset", async () => {
    delete process.env.PINGRAM_WEBHOOK_SECRET;
    await expect(verifyPingramWebhook("{}", headersFor({ signature: "v1,abc", timestamp: "1" }))).rejects.toThrow(
      "PINGRAM_WEBHOOK_SECRET is not set",
    );
  });

  it("verifies the documented v1 signature over id, millisecond timestamp, and raw body", async () => {
    const rawBody = JSON.stringify({ eventType: "SMS_DELIVERED", trackingId: TRACKING_ID });
    const timestamp = String(Date.now());
    await expect(
      verifyPingramWebhook(rawBody, headersFor({ signature: `v1,${sign(timestamp, rawBody)}`, timestamp })),
    ).resolves.toBe(true);
  });

  it("accepts an uppercase hexadecimal digest", async () => {
    const rawBody = "{}";
    const timestamp = String(Date.now());
    await expect(
      verifyPingramWebhook(rawBody, headersFor({ signature: `v1,${sign(timestamp, rawBody).toUpperCase()}`, timestamp })),
    ).resolves.toBe(true);
  });

  it("returns false for a missing id, bad signature, or non-numeric timestamp", async () => {
    const timestamp = String(Date.now());
    await expect(verifyPingramWebhook("{}", headersFor({ id: null, signature: "v1,abc", timestamp }))).resolves.toBe(false);
    await expect(verifyPingramWebhook("{}", headersFor({ signature: "v1,deadbeef", timestamp }))).resolves.toBe(false);
    await expect(verifyPingramWebhook("{}", headersFor({ signature: "v1,abc", timestamp: "not-a-number" }))).resolves.toBe(false);
  });

  it("rejects timestamps outside the five-minute replay window", async () => {
    const rawBody = "{}";
    const timestamp = String(Date.now() - 300_001);
    await expect(
      verifyPingramWebhook(rawBody, headersFor({ signature: `v1,${sign(timestamp, rawBody)}`, timestamp })),
    ).resolves.toBe(false);
  });

  it("rejects a body changed after signing", async () => {
    const timestamp = String(Date.now());
    const signature = `v1,${sign(timestamp, "{}")}`;
    await expect(verifyPingramWebhook('{"changed":true}', headersFor({ signature, timestamp }))).resolves.toBe(false);
  });
});
