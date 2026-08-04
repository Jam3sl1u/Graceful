import "server-only";
import { Resend } from "resend";
import { renderEmailTemplate, type EmailTemplateKey, type EmailTemplateDataMap } from "./templates";

export type SendEmailResult = { id: string };

export type EmailDeliveryStatus =
  | "sent"
  | "delivered"
  | "delayed"
  | "bounced"
  | "complained"
  | "opened"
  | "clicked";

// lazy singleton, follows lib/r2/client.ts's pattern
let client: Resend | null = null;

function getClient(): Resend {
  if (client) return client;

  const apiKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.RESEND_FROM_EMAIL;
  if (!apiKey || !fromEmail) {
    throw new Error("Resend is not configured — missing required environment variable(s)");
  }

  client = new Resend(apiKey);
  return client;
}

export async function sendEmail<K extends EmailTemplateKey>(
  to: string,
  template: K,
  data: EmailTemplateDataMap[K],
): Promise<SendEmailResult> {
  if (!to || !to.trim()) {
    throw new Error("sendEmail requires a recipient address");
  }

  const resend = getClient();
  const { subject, html, text } = renderEmailTemplate(template, data);

  // RESEND_FROM_EMAIL is passed through verbatim (may be "a@b.com" or
  // "Graceful <a@b.com>") — never parse or reformat it.
  const { data: sendData, error } = await resend.emails.send({
    from: process.env.RESEND_FROM_EMAIL!,
    to,
    subject,
    html,
    text,
  });

  if (error || !sendData) {
    // Never log the recipient address, subject, or body (PRD §25.6).
    throw new Error(`Resend email dispatch failed: ${error?.message ?? "unknown error"}`);
  }

  return { id: sendData.id };
}

// Pure mapper — exported for the webhook handler and for tests.
export function mapResendEventToStatus(eventType: string): EmailDeliveryStatus | null {
  switch (eventType) {
    case "email.sent":
      return "sent";
    case "email.delivered":
      return "delivered";
    case "email.delivery_delayed":
      return "delayed";
    case "email.bounced":
      return "bounced";
    case "email.complained":
      return "complained";
    case "email.opened":
      return "opened";
    case "email.clicked":
      return "clicked";
    default:
      return null;
  }
}
