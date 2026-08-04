// Tests for lib/api/webhook-verify.ts's verifyPingramWebhook (#67). Uses real
// `crypto` HMAC to build valid signatures (no mocking of the crypto module).
// Only the Pingram verifier is covered — verifyClerkWebhook,
// verifyResendWebhook, and verifyModalWebhook remain unimplemented stubs
// (out of scope for #67) and are intentionally left unasserted.

import { createHmac } from "crypto";
import { verifyPingramWebhook } from "@/lib/api/webhook-verify";

const SECRET = "test-webhook-secret";

function sign(secret: string, timestamp: string, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

function headersFor(overrides: Partial<{ signature: string | null; timestamp: string | null }>) {
  const map = new Map<string, string>();
  if (overrides.signature !== null) {
    map.set("x-pingram-signature", overrides.signature ?? "");
  }
  if (overrides.timestamp !== null) {
    map.set("x-pingram-timestamp", overrides.timestamp ?? "");
  }
  return {
    get: (name: string) => map.get(name.toLowerCase()) ?? null,
  } as unknown as Headers;
}

beforeEach(() => {
  process.env.PINGRAM_WEBHOOK_SECRET = SECRET;
});

afterEach(() => {
  delete process.env.PINGRAM_WEBHOOK_SECRET;
});

describe("verifyPingramWebhook", () => {
  it("throws when PINGRAM_WEBHOOK_SECRET is unset", async () => {
    delete process.env.PINGRAM_WEBHOOK_SECRET;
    await expect(
      verifyPingramWebhook("{}", headersFor({ signature: "abc", timestamp: "123" })),
    ).rejects.toThrow("PINGRAM_WEBHOOK_SECRET is not set");
  });

  it("throws when PINGRAM_WEBHOOK_SECRET is an empty string", async () => {
    process.env.PINGRAM_WEBHOOK_SECRET = "";
    await expect(
      verifyPingramWebhook("{}", headersFor({ signature: "abc", timestamp: "123" })),
    ).rejects.toThrow("PINGRAM_WEBHOOK_SECRET is not set");
  });

  it("returns true for a valid signature (no prefix)", async () => {
    const rawBody = JSON.stringify({ message_id: "m1", status: "delivered" });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign(SECRET, timestamp, rawBody);

    await expect(
      verifyPingramWebhook(rawBody, headersFor({ signature, timestamp })),
    ).resolves.toBe(true);
  });

  it("returns true for a valid signature with an sha256= prefix", async () => {
    const rawBody = JSON.stringify({ message_id: "m1", status: "delivered" });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = `sha256=${sign(SECRET, timestamp, rawBody)}`;

    await expect(
      verifyPingramWebhook(rawBody, headersFor({ signature, timestamp })),
    ).resolves.toBe(true);
  });

  it("returns false when the signature header is missing", async () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    await expect(
      verifyPingramWebhook("{}", headersFor({ signature: null, timestamp })),
    ).resolves.toBe(false);
  });

  it("returns false when the signature is wrong", async () => {
    const rawBody = JSON.stringify({ message_id: "m1", status: "delivered" });
    const timestamp = String(Math.floor(Date.now() / 1000));

    await expect(
      verifyPingramWebhook(rawBody, headersFor({ signature: "deadbeef".repeat(8), timestamp })),
    ).resolves.toBe(false);
  });

  it("returns false (timing-safe) for a signature of the correct length but different bytes", async () => {
    const rawBody = JSON.stringify({ message_id: "m1", status: "delivered" });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const correct = sign(SECRET, timestamp, rawBody);
    // Flip the last hex char, keeping the same length.
    const lastChar = correct[correct.length - 1];
    const flipped = lastChar === "0" ? "1" : "0";
    const wrongSameLength = correct.slice(0, -1) + flipped;

    await expect(
      verifyPingramWebhook(rawBody, headersFor({ signature: wrongSameLength, timestamp })),
    ).resolves.toBe(false);
  });

  it("returns false, and does not throw, for a signature of a different length", async () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    await expect(
      verifyPingramWebhook("{}", headersFor({ signature: "short", timestamp })),
    ).resolves.toBe(false);
  });

  it("returns false when the timestamp header is missing", async () => {
    const rawBody = "{}";
    await expect(
      verifyPingramWebhook(rawBody, headersFor({ signature: "abc", timestamp: null })),
    ).resolves.toBe(false);
  });

  it("returns false when the timestamp header is non-numeric", async () => {
    const rawBody = "{}";
    await expect(
      verifyPingramWebhook(rawBody, headersFor({ signature: "abc", timestamp: "not-a-number" })),
    ).resolves.toBe(false);
  });

  it("returns false when the timestamp is older than the 300s replay window", async () => {
    const rawBody = JSON.stringify({ message_id: "m1", status: "delivered" });
    const timestamp = String(Math.floor(Date.now() / 1000) - 301);
    const signature = sign(SECRET, timestamp, rawBody);

    await expect(
      verifyPingramWebhook(rawBody, headersFor({ signature, timestamp })),
    ).resolves.toBe(false);
  });

  it("returns false when the timestamp is more than 300s in the future", async () => {
    const rawBody = JSON.stringify({ message_id: "m1", status: "delivered" });
    const timestamp = String(Math.floor(Date.now() / 1000) + 301);
    const signature = sign(SECRET, timestamp, rawBody);

    await expect(
      verifyPingramWebhook(rawBody, headersFor({ signature, timestamp })),
    ).resolves.toBe(false);
  });

  it("returns false when the body is mutated after signing (same signature, different body)", async () => {
    const rawBody = JSON.stringify({ message_id: "m1", status: "delivered" });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign(SECRET, timestamp, rawBody);
    const mutatedBody = JSON.stringify({ message_id: "m1", status: "failed" });

    await expect(
      verifyPingramWebhook(mutatedBody, headersFor({ signature, timestamp })),
    ).resolves.toBe(false);
  });
});
