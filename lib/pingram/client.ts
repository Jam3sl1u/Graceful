import "server-only";
import { SMS_MAX_LENGTH } from "@/lib/notifications/sms-templates";

// --- Pingram vendor contract (issue #67 §7 — PROVISIONAL DEFAULTS) ---
// The repo has no confirmed Pingram API contract (no endpoint, header names,
// payload shape, or SDK dependency anywhere). These constants are an
// unverified best guess pending a human confirming them against Pingram's
// own docs/dashboard (see .pipeline/spec.md OPEN QUESTION Q1). Keeping them
// in one block here (and the mirrored block in lib/api/webhook-verify.ts for
// Q2) makes a corrected contract a one-place edit.
//   Send endpoint: POST ${PINGRAM_API_BASE_URL ?? DEFAULT_BASE_URL}/messages
//   Auth header:   Authorization: Bearer ${PINGRAM_API_KEY}
//   Request body:  { to, text, from? } — "from" only when PINGRAM_SENDER is set
//   Response id:   "id", falling back to "message_id", then null
const PINGRAM_DEFAULT_BASE_URL = "https://api.pingram.io/v1";
const SEND_TIMEOUT_MS = 10_000;

export class SmsNotConfiguredError extends Error {
  constructor(
    message = "Pingram is not configured — missing required environment variable(s)",
  ) {
    super(message);
    this.name = "SmsNotConfiguredError";
  }
}

export class SmsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmsValidationError";
  }
}

export class SmsDispatchError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SmsDispatchError";
  }
}

export type SendSmsParams = {
  to: string | null; // raw phone as stored in users.phone
  body: string; // rendered SMS copy
  smsOptedIn: boolean; // caller-supplied users.sms_opted_in — required
};

export type SendSmsSkipReason = "not_opted_in" | "no_phone" | "invalid_phone";

export type SendSmsResult =
  | { status: "sent"; messageId: string | null }
  | { status: "skipped"; reason: SendSmsSkipReason };

// Normalizes `raw` to E.164 (US-only — PRD confirms Pingram handles US A2P
// 10DLC). Returns null when `raw` cannot be normalized. Exported for unit
// tests.
export function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;

  const stripped = raw.replace(/[\s\-.()]/g, "");

  if (/^\+\d{8,15}$/.test(stripped)) {
    return stripped;
  }
  if (/^\d{10}$/.test(stripped)) {
    return `+1${stripped}`;
  }
  if (/^1\d{10}$/.test(stripped)) {
    return `+${stripped}`;
  }
  return null;
}

// Dispatches one SMS via Pingram. Enforces sms_opted_in itself (the only
// available Supabase clients are RLS-scoped and cannot look this up
// server-side, so callers must supply it — see .pipeline/spec.md decision 5).
// Order of operations is load-bearing: consent is checked before anything
// else, and no network call happens on any skip/validation/config path.
export async function sendSms(params: SendSmsParams): Promise<SendSmsResult> {
  const { to, body, smsOptedIn } = params;

  if (smsOptedIn !== true) {
    return { status: "skipped", reason: "not_opted_in" };
  }

  if (!to || !to.trim()) {
    return { status: "skipped", reason: "no_phone" };
  }

  const normalizedTo = toE164(to);
  if (!normalizedTo) {
    return { status: "skipped", reason: "invalid_phone" };
  }

  if (!body.trim()) {
    throw new SmsValidationError("SMS body must not be empty");
  }

  if (body.length > SMS_MAX_LENGTH) {
    throw new SmsValidationError(
      `SMS body exceeds ${SMS_MAX_LENGTH} characters (was ${body.length})`,
    );
  }

  // Read env at call time, not module scope.
  const apiKey = process.env.PINGRAM_API_KEY;
  if (!apiKey) {
    throw new SmsNotConfiguredError();
  }

  const baseUrl = process.env.PINGRAM_API_BASE_URL || PINGRAM_DEFAULT_BASE_URL;
  const sender = process.env.PINGRAM_SENDER;

  const requestBody: { to: string; text: string; from?: string } = {
    to: normalizedTo,
    text: body,
  };
  if (sender) {
    requestBody.from = sender;
  }

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch (err) {
    // Network error or timeout — never log the api key, recipient, or body.
    throw new SmsDispatchError(
      `Pingram send request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!res.ok) {
    throw new SmsDispatchError(`Pingram send failed with status ${res.status}`, res.status);
  }

  let messageId: string | null = null;
  try {
    const json = (await res.json()) as { id?: unknown; message_id?: unknown };
    const id = json.id ?? json.message_id;
    messageId = typeof id === "string" ? id : null;
  } catch {
    // 2xx with a non-JSON body is still a success.
    messageId = null;
  }

  return { status: "sent", messageId };
}
