import { NextRequest } from "next/server";
import { ok, fail } from "@/lib/api/response";
import { ErrorCode } from "@/lib/api/errors";
import { verifyPingramWebhook } from "@/lib/api/webhook-verify";
import { pingramWebhookSchema, toSmsEventType } from "@/schemas/pingram";

// POST /api/webhooks/pingram (#67) — Pingram delivery-status callback. Public
// route (middleware.ts already makes /api/webhooks(.*) public); no Clerk
// auth, no Supabase client. Nothing is persisted (.pipeline/spec.md decision
// 1) — this route verifies, validates, and emits one structured log line per
// callback, then 200s.
export async function POST(req: NextRequest): Promise<Response> {
  // Must read the raw text before any JSON parsing — the signature is over
  // the raw bytes.
  const rawBody = await req.text();

  let verified: boolean;
  try {
    verified = await verifyPingramWebhook(rawBody, req.headers);
  } catch (err) {
    console.error("pingram webhook: signature verification failed", err);
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }

  if (!verified) {
    return fail("Invalid webhook signature", ErrorCode.UNAUTHENTICATED, 401);
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawBody);
  } catch {
    return fail("Invalid JSON body", ErrorCode.VALIDATION_FAILED, 400);
  }

  const result = pingramWebhookSchema.safeParse(parsedBody);
  if (!result.success) {
    return fail("Invalid webhook payload", ErrorCode.VALIDATION_FAILED, 400);
  }

  const { eventType: rawEventType, trackingId, failureCode } = result.data;
  const event = toSmsEventType(rawEventType);

  // Never log the raw body or the full recipient number.
  console.info("pingram webhook: sms event", { trackingId, event, rawEventType, failureCode });

  return ok({ received: true, trackingId, event }, 200);
}
