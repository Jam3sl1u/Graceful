# Changes — Issue #67: Correct Pingram wire contract

This patch replaces the prior provisional Pingram integration with the
documented `/sms` and events-webhook contracts.

- **Dispatch:** `lib/pingram/client.ts` now posts `{ type, to, message,
  from? }` to `https://api.pingram.io/sms`, returns `trackingId`, detects a
  structured error in a 200 response, and accepts US phone numbers only.
- **Webhook:** signature verification now uses `X-Pingram-Id`, `v1,{hex}` and
  the documented tracking-id/timestamp/raw-body HMAC payload. Timestamp values
  are milliseconds. The schema and handler consume Pingram event fields and
  acknowledge all valid SMS events, including inbound and unknown events.
- **SMS safety:** link-bearing templates preserve their full terminal link;
  truncation is exact-length and GSM-7-safe. Member reminder inputs are bounded
  before dispatch. PRD section 30 and the templates use ASCII hyphens.
- **Configuration and tests:** environment guidance is normalized and focused
  unit tests cover the corrected contract, failure responses, signatures,
  events, long links, ASCII output, and reminder limits.

Vendor contract citations:

- https://www.pingram.io/docs/sms/overview
- https://www.pingram.io/docs/api-reference/operations/sms_send
- https://www.pingram.io/docs/features/events-webhook
