import { NextRequest } from "next/server";
import { ok, fail } from "@/lib/api/response";
import { ErrorCode } from "@/lib/api/errors";
import { verifyResendWebhook } from "@/lib/api/webhook-verify";
import { mapResendEventToStatus } from "@/lib/resend/client";

// POST /api/webhooks/resend (#68) — processes Resend delivery-event
// callbacks. There is no email/SMS delivery-log table in the schema yet
// (out of scope for this issue), so "processing" a callback means verify ->
// parse -> normalize to a delivery status -> structured log -> 200 ack. Do
// not add a migration or write to any table here.
export async function handleResendWebhook(req: NextRequest): Promise<Response> {
  // The raw bytes are what the signature covers — never call req.json()
  // before verification.
  const rawBody = await req.text();

  let verified: boolean;
  try {
    verified = await verifyResendWebhook(rawBody, req.headers);
  } catch {
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }

  if (!verified) {
    return fail("Invalid webhook signature", ErrorCode.UNAUTHENTICATED, 401);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return fail("Invalid webhook payload", ErrorCode.VALIDATION_FAILED, 400);
  }

  if (typeof payload !== "object" || payload === null) {
    return fail("Invalid webhook payload", ErrorCode.VALIDATION_FAILED, 400);
  }

  const { type, data } = payload as { type?: unknown; data?: unknown };
  if (typeof type !== "string" || !type) {
    return fail("Invalid webhook payload", ErrorCode.VALIDATION_FAILED, 400);
  }

  // This endpoint only tracks email delivery events. A Resend subscription
  // may also include contact/domain callbacks, which do not have email_id;
  // acknowledge them so Resend does not retry a deliberately ignored event.
  if (!type.startsWith("email.")) {
    return ok({ received: true, status: "ignored" });
  }

  const emailId = typeof data === "object" && data !== null ? (data as { email_id?: unknown }).email_id : undefined;
  if (typeof emailId !== "string" || !emailId) {
    return fail("Invalid webhook payload", ErrorCode.VALIDATION_FAILED, 400);
  }

  const status = mapResendEventToStatus(type) ?? "ignored";

  // Never log recipient addresses or the payload — event type, email_id and
  // status only (PRD §25.6). Engagement events are intentionally omitted to
  // avoid per-open/per-click log volume.
  if (status !== "opened" && status !== "clicked") {
    console.info("resend webhook", { type, emailId, status });
  }

  return ok({ received: true, emailId, status });
}
