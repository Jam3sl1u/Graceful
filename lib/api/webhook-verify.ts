import "server-only";
import { createHmac, timingSafeEqual } from "crypto";

// Each verifier validates an inbound webhook signature against the relevant
// *_WEBHOOK_SECRET env var before the payload is trusted. All four follow the
// same shape: raw body + signature header(s) in, boolean (or throw) out.

// TODO(Sprint 0 #5): verify via svix using CLERK_WEBHOOK_SECRET.
export async function verifyClerkWebhook(_rawBody: string, _headers: Headers): Promise<boolean> {
  throw new Error("verifyClerkWebhook not implemented — see Sprint 0 #5");
}

// --- Pingram webhook signature contract (confirmed 2026-08-27) ---
// https://www.pingram.io/docs/features/events-webhook
// X-Pingram-Id is assumed to be the trackingId in the signed string; verify
// that documented relationship with the first real staging callback.
const PINGRAM_ID_HEADER = "x-pingram-id";
const PINGRAM_SIGNATURE_HEADER = "x-pingram-signature";
const PINGRAM_TIMESTAMP_HEADER = "x-pingram-timestamp";
const PINGRAM_SIGNATURE_PREFIX = "v1,";
const PINGRAM_REPLAY_WINDOW_SECONDS = 300;

// Verifies an inbound Pingram delivery-status callback. Never throws for bad
// input — only for missing config (a config fault is a 500, not a 401,
// mirroring the missing-CRON_SECRET branch in
// app/api/cron/invitation-reminders/route.ts).
export async function verifyPingramWebhook(rawBody: string, headers: Headers): Promise<boolean> {
  const secret = process.env.PINGRAM_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error("PINGRAM_WEBHOOK_SECRET is not set");
  }

  const signatureHeader = headers.get(PINGRAM_SIGNATURE_HEADER);
  const timestampHeader = headers.get(PINGRAM_TIMESTAMP_HEADER);
  const trackingId = headers.get(PINGRAM_ID_HEADER);
  if (!signatureHeader || !timestampHeader || !trackingId) {
    return false;
  }

  if (!/^-?\d+$/.test(timestampHeader)) {
    return false;
  }
  const timestamp = Number.parseInt(timestampHeader, 10);
  if (Math.abs(Date.now() - timestamp) / 1000 > PINGRAM_REPLAY_WINDOW_SECONDS) {
    return false;
  }

  const providedSignature = signatureHeader.startsWith(PINGRAM_SIGNATURE_PREFIX)
    ? signatureHeader.slice(PINGRAM_SIGNATURE_PREFIX.length)
    : signatureHeader;

  const signedPayload = `${trackingId}.${timestampHeader}.${rawBody}`;
  const expectedSignature = createHmac("sha256", secret).update(signedPayload).digest("hex");

  const providedBuffer = Buffer.from(providedSignature.toLowerCase(), "utf8");
  const expectedBuffer = Buffer.from(expectedSignature, "utf8");
  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(providedBuffer, expectedBuffer);
}

// TODO(Sprint 4 #59): verify using RESEND_WEBHOOK_SECRET.
export async function verifyResendWebhook(_rawBody: string, _headers: Headers): Promise<boolean> {
  throw new Error("verifyResendWebhook not implemented — see Sprint 4 #59");
}

// TODO(Phase 3/4 transcription work): verify using MODAL_WEBHOOK_SECRET.
export async function verifyModalWebhook(_rawBody: string, _headers: Headers): Promise<boolean> {
  throw new Error("verifyModalWebhook not implemented — see transcription pipeline work");
}
