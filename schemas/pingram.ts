import { z } from "zod";

// POST /api/webhooks/pingram body (#67), confirmed against
// https://www.pingram.io/docs/features/events-webhook. Zod strips unknown
// keys so extra provider fields do not reject a callback.
export const pingramWebhookSchema = z.object({
  eventType: z.string().min(1),
  trackingId: z.string().min(1),
  channel: z.string().optional(),
  userId: z.string().optional(),
  notificationId: z.string().optional(),
  failureCode: z.string().nullish(),
});
export type PingramWebhookPayload = z.infer<typeof pingramWebhookSchema>;

export type PingramSmsEventType =
  | "SMS_DELIVERED"
  | "SMS_FAILED"
  | "SMS_INBOUND"
  | "SMS_SUBSCRIBE"
  | "SMS_UNSUBSCRIBE"
  | "UNKNOWN";

const KNOWN_SMS_EVENTS: ReadonlySet<string> = new Set([
  "SMS_DELIVERED",
  "SMS_FAILED",
  "SMS_INBOUND",
  "SMS_SUBSCRIBE",
  "SMS_UNSUBSCRIBE",
]);

// Maps a raw provider status string to our canonical set. Unrecognized
// provider statuses map to "unknown" — the route still 200s so Pingram does
// not retry a callback we simply do not model yet.
export function toSmsEventType(raw: string): PingramSmsEventType {
  return KNOWN_SMS_EVENTS.has(raw) ? (raw as PingramSmsEventType) : "UNKNOWN";
}
