# Implementation Spec — Issue #67: Pingram SMS dispatch and webhook verification

## OPEN QUESTION — RESOLVED 2026-08-27

Pingram's wire contract is now confirmed against its public documentation:

- https://www.pingram.io/docs/sms/overview
- https://www.pingram.io/docs/api-reference/operations/sms_send
- https://www.pingram.io/docs/features/events-webhook

The Events Webhook documentation specifies a Unix timestamp in **milliseconds**;
verification must compare it with `Date.now()` using the documented five-minute
tolerance. The prior provisional seconds-based contract is removed.

## Scope

Correct the existing #67 implementation, tests, and handoff artifacts. Do not
wire additional notification triggers or persist delivery events.

### 1. Pingram send contract

- `lib/pingram/client.ts` sends `POST ${PINGRAM_API_BASE_URL ??
  "https://api.pingram.io"}/sms` with Bearer authentication.
- The JSON body is `{ type: "graceful_notification", to, message, from? }`.
  `from` is included only if `PINGRAM_SENDER` is set.
- A success identifier is `trackingId`. A JSON body containing `error` is a
  dispatch failure even when the HTTP status is 200. Non-2xx remains a failure.
- Preserve server-only execution, call-time environment reads, skip ordering,
  empty/overlength validation, timeout, and no-secret logging. Restrict phone
  normalization to US `+1` plus ten digits.

### 2. Pingram webhook contract

- Verify `X-Pingram-Id`, `X-Pingram-Signature`, and
  `X-Pingram-Timestamp`. The signature is `v1,{hex}` over
  `${trackingId}.${timestamp}.${rawBody}` using HMAC-SHA256.
- Use a constant-time comparison after stripping `v1,` and normalizing hex
  case. Reject missing/malformed headers and timestamps outside five minutes;
  missing configuration remains an internal error.
- `X-Pingram-Id` is treated as the payload tracking ID, as documented; confirm
  it with the first staging callback.
- Accept `{ eventType, trackingId, channel?, userId?, notificationId?,
  failureCode? }`; strip unknown keys. Map the five exact SMS event types to
  themselves, all others to `UNKNOWN`, and acknowledge all valid events.

### 3. SMS copy length guarantees

- Linked templates must preserve the complete terminal link within 160
  characters by truncating prose first. Field truncation returns exactly its
  configured maximum using a single ellipsis.
- Use ASCII hyphens rather than em dashes in SMS copy and PRD section 30.
- Bound cron member reminder name and week label fields so the live caller
  never reaches the dispatch overlength failure.

### 4. Configuration and tests

- Normalize the Pingram `.env.example` guidance to a preceding comment.
- Update Pingram client, verifier, schema, route, SMS-template, and reminder/
  cron tests for the corrected contract, long inputs, link preservation, ASCII
  output, and failure behavior.

## Verification

Run `bun run lint`, `bun run typecheck`, `bun run test`, and
`bun run check:workflows`. Inspect the final diff and confirm SMS paths contain
no em dashes or non-ASCII characters.
