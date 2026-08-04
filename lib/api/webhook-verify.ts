import "server-only";
import { Webhook } from "svix";

// Each verifier validates an inbound webhook signature against the relevant
// *_WEBHOOK_SECRET env var before the payload is trusted. All four follow the
// same shape: raw body + signature header(s) in, boolean (or throw) out.

// TODO(Sprint 0 #5): verify via svix using CLERK_WEBHOOK_SECRET.
export async function verifyClerkWebhook(_rawBody: string, _headers: Headers): Promise<boolean> {
  throw new Error("verifyClerkWebhook not implemented — see Sprint 0 #5");
}

// TODO(Sprint 4 #58): verify using PINGRAM_WEBHOOK_SECRET.
export async function verifyPingramWebhook(_rawBody: string, _headers: Headers): Promise<boolean> {
  throw new Error("verifyPingramWebhook not implemented — see Sprint 4 #58");
}

// Verifies a Resend webhook delivery using its Svix signature (Resend signs
// webhooks with Svix) and RESEND_WEBHOOK_SECRET (issue #68).
export async function verifyResendWebhook(rawBody: string, headers: Headers): Promise<boolean> {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error("Resend webhook is not configured — RESEND_WEBHOOK_SECRET must be set");
  }

  const svixId = headers.get("svix-id");
  const svixTimestamp = headers.get("svix-timestamp");
  const svixSignature = headers.get("svix-signature");
  if (!svixId || !svixTimestamp || !svixSignature) {
    return false;
  }

  const webhook = new Webhook(secret);
  try {
    webhook.verify(rawBody, {
      "svix-id": svixId,
      "svix-timestamp": svixTimestamp,
      "svix-signature": svixSignature,
    });
    return true;
  } catch {
    return false;
  }
}

// TODO(Phase 3/4 transcription work): verify using MODAL_WEBHOOK_SECRET.
export async function verifyModalWebhook(_rawBody: string, _headers: Headers): Promise<boolean> {
  throw new Error("verifyModalWebhook not implemented — see transcription pipeline work");
}
