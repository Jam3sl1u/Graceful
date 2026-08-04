import { z } from "zod";

// POST /api/webhooks/pingram body (#67). Field names come from Pingram's
// delivery-status callback (.pipeline/spec.md OPEN QUESTION Q3 — PROVISIONAL
// DEFAULTS, §7). Zod v3 strips unknown keys by default — keep that so extra
// provider fields don't 400 the callback.
export const pingramWebhookSchema = z.object({
  message_id: z.string().min(1),
  status: z.string().min(1),
  to: z.string().optional(),
  error_code: z.string().nullish(),
  occurred_at: z.string().optional(),
});
export type PingramWebhookPayload = z.infer<typeof pingramWebhookSchema>;

export type PingramDeliveryStatus =
  | "queued"
  | "sent"
  | "delivered"
  | "failed"
  | "undelivered"
  | "unknown";

const KNOWN_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "sent",
  "delivered",
  "failed",
  "undelivered",
]);

// Maps a raw provider status string to our canonical set. Unrecognized
// provider statuses map to "unknown" — the route still 200s so Pingram does
// not retry a callback we simply do not model yet.
export function toDeliveryStatus(raw: string): PingramDeliveryStatus {
  return KNOWN_STATUSES.has(raw) ? (raw as PingramDeliveryStatus) : "unknown";
}
