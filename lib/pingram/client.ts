import "server-only";

// TODO(Sprint 4 #58): dispatch outbound SMS via Pingram (PINGRAM_API_KEY).
// Webhook signature verification lives in lib/api/webhook-verify.ts.
export async function sendSms(_to: string, _body: string): Promise<void> {
  throw new Error("sendSms not implemented — see Sprint 4 #58");
}
