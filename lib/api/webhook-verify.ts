import "server-only";

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

// TODO(Sprint 4 #59): verify using RESEND_WEBHOOK_SECRET.
export async function verifyResendWebhook(_rawBody: string, _headers: Headers): Promise<boolean> {
  throw new Error("verifyResendWebhook not implemented — see Sprint 4 #59");
}

// TODO(Phase 3/4 transcription work): verify using MODAL_WEBHOOK_SECRET.
export async function verifyModalWebhook(_rawBody: string, _headers: Headers): Promise<boolean> {
  throw new Error("verifyModalWebhook not implemented — see transcription pipeline work");
}
