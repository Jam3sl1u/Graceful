# Spec — Issue #67: Integrate Pingram SMS dispatch + webhook verification

## OPEN QUESTION (BLOCKING — do not implement until a human answers)

**The repo contains no Pingram API contract, and I could not derive one from
source.** Everything below is fully specified *except* the vendor wire details.
Guessing them would produce code that looks correct, passes its own mocked
tests, and silently fails in production (an invented signature header means every
real Pingram callback is rejected with 401 — the exact opposite of the AC).

Verified: the only Pingram references anywhere in this repo are
`PINGRAM_API_KEY` / `PINGRAM_WEBHOOK_SECRET` in `.env.example`, the stubs in
`lib/pingram/client.ts` + `lib/api/webhook-verify.ts`, prose in
`documentation/prd/graceful_requirements_v10.md`, and
`documentation/staging-environment.md`. No endpoint, no header names, no payload
shape, and no SDK dependency in `package.json`.

Three answers are needed (all from Pingram's own docs / dashboard for the
account provisioned in #10):

**Q1 — Outbound send.** Base URL + path, auth header format, request body field
names, whether a sender/from number is required (i.e. whether a new env var is
needed), and which response field carries the provider message id.

**Q2 — Webhook signature.** The exact signature header name, the exact string
that is signed (raw body alone, or `timestamp.rawBody`, or similar), the HMAC
algorithm and digest encoding (hex vs base64), whether a separate timestamp
header exists, and any prefix on the header value (e.g. `sha256=`).

**Q3 — Delivery-status payload.** Field names and the full set of status values
Pingram sends.

**Provisional defaults.** If the human answers "use the defaults", implement
exactly the constants in §7 below and nothing changes elsewhere in this spec.
Any other answer changes *only* §7 — the rest of the spec is independent of the
vendor contract.

---

## Goal

Replace the two Pingram stubs with a real implementation: an outbound SMS
dispatch utility callable from any notification trigger, and a delivery-status
webhook endpoint that verifies the request signature before processing and
rejects unsigned/invalid requests with 401. Enforce `sms_opted_in` inside the
dispatch utility itself.

PRD refs: §15.7 (webhook signature verification, doc line 1452), §30
(Notification Content Templates, doc lines 1692-1707).

## Current state (verified)

- `lib/pingram/client.ts` — stub: `sendSms(_to, _body)` throws.
- `lib/api/webhook-verify.ts` — four stubs; only `verifyPingramWebhook` is in
  scope. Leave `verifyClerkWebhook`, `verifyResendWebhook`, `verifyModalWebhook`
  untouched.
- `app/api/webhooks/pingram/route.ts` — stub returning `notImplemented(...)`
  (501).
- `middleware.ts` line 12 already makes `/api/webhooks(.*)` public — no
  middleware change needed.
- `app/api/cron/invitation-reminders/route.ts` is the **only** existing caller
  of `sendSms` (2-arg positional, inside a try/catch that counts `smsFailed`).
  It already gates on `reminder.phone` + `reminder.sms_opted_in`.
- `users.phone varchar(20)` (nullable) and `users.sms_opted_in boolean not null
  default false` exist (`supabase/migrations/20260702000001_cluster_1_organization.sql`
  lines 35-36). There is **no** table for SMS delivery status.
- No Pingram SDK in `package.json`; use `fetch` + Node `crypto`. **Do not add a
  dependency.**
- `zod@^3` is available; per-area schema files live in `schemas/`.

## Decisions (resolved — not open questions)

1. **No new DB table / migration.** Nothing in the schema stores delivery
   status, and the issue does not ask for one. The webhook verifies, validates,
   and emits one structured log line per callback, then 200s. Persistence is a
   follow-up.
2. **No retry/backoff and no queueing.** `sendSms` throws on provider failure;
   the caller decides. (The cron route already isolates failures.) Out of scope
   for this issue.
3. **`lib/scheduling/reminder.ts` is not touched.** Its `buildMemberReminderSms`
   copy cannot be swapped for the PRD §30 member-reminder template because that
   template requires a respond link, and `send_invitation_reminders` does not
   return a response token. Rewiring live triggers to the templates is #69.
4. **The new template builders are intentionally not wired to a caller yet** —
   #69 consumes them. They are covered by their own unit tests. This is not dead
   code to be "cleaned up".
5. **`sendSms` gets an options-object signature** (breaking the current 2-arg
   positional call). Opt-in cannot be looked up inside `sendSms`: the only
   available Supabase clients are RLS-scoped, `users` is not readable
   cross-user by an anon client, and service-role usage is banned in this
   codebase. The consent flag must therefore be a **required** parameter so no
   caller can dispatch without asserting it. The one existing caller and one
   test assertion are updated accordingly (§5, §6).

## Files

### 1. MODIFY `lib/pingram/client.ts` (replace the whole file)

Keep `import "server-only";`. Pattern to copy for env validation + lazy config:
`lib/r2/client.ts`. Pattern to copy for `fetch` + non-2xx handling:
`lib/google-calendar/sync.ts` (`upsertCalendarEvent`).

```ts
export class SmsNotConfiguredError extends Error {}
export class SmsValidationError extends Error {}
export class SmsDispatchError extends Error {
  constructor(message: string, readonly status?: number);
}

export type SendSmsParams = {
  to: string | null;      // raw phone as stored in users.phone
  body: string;           // rendered SMS copy
  smsOptedIn: boolean;    // caller-supplied users.sms_opted_in — required
};

export type SendSmsSkipReason = "not_opted_in" | "no_phone" | "invalid_phone";

export type SendSmsResult =
  | { status: "sent"; messageId: string | null }
  | { status: "skipped"; reason: SendSmsSkipReason };

// Exported for unit tests. Returns null when `raw` cannot be normalized.
export function toE164(raw: string | null | undefined): string | null;

export async function sendSms(params: SendSmsParams): Promise<SendSmsResult>;
```

`sendSms` order of operations (this order is load-bearing — consent is checked
before anything else, and no network call happens on any skip path):

1. `smsOptedIn !== true` → return `{ status: "skipped", reason: "not_opted_in" }`.
2. `to` null/empty/whitespace → `{ status: "skipped", reason: "no_phone" }`.
3. `toE164(to)` returns null → `{ status: "skipped", reason: "invalid_phone" }`.
4. `body` empty/whitespace-only → throw `SmsValidationError`.
5. `body.length > SMS_MAX_LENGTH` (160, imported from
   `lib/notifications/sms-templates.ts`) → throw `SmsValidationError`. (Fail
   loudly: the free tier is 100 SMS/month; never silently send a multi-segment
   message.)
6. Missing/empty `PINGRAM_API_KEY` → throw `SmsNotConfiguredError` (message
   `"Pingram is not configured — missing required environment variable(s)"`,
   mirroring `lib/r2/client.ts`). Read env at call time, not module scope.
7. `fetch` the send endpoint (§7) with `signal: AbortSignal.timeout(10_000)`.
   Non-2xx → throw `SmsDispatchError` carrying `res.status`. Network
   error/timeout → throw `SmsDispatchError`.
8. Parse the JSON response; return `{ status: "sent", messageId }`, with
   `messageId: null` if the field is absent or the body is not JSON (a 2xx is
   still a success).

`toE164` rules (US-only — PRD confirms Pingram handles US A2P 10DLC):
- Strip spaces, `-`, `.`, `(`, `)`.
- `+` followed by 8-15 digits → return as-is.
- Exactly 10 digits → `+1` + digits.
- Exactly 11 digits starting with `1` → `+` + digits.
- Anything else (letters, wrong length, empty) → `null`.

Never log the API key, the full recipient number, or the message body.

### 2. MODIFY `lib/api/webhook-verify.ts` — implement `verifyPingramWebhook` only

Keep the signature exactly: `(rawBody: string, headers: Headers) => Promise<boolean>`.
Use `createHmac` + `timingSafeEqual` from `crypto` (same import style as
`lib/google-calendar/token-crypto.ts`).

- Missing/empty `PINGRAM_WEBHOOK_SECRET` → **throw** `new Error("PINGRAM_WEBHOOK_SECRET is not set")`
  (a config fault is a 500, not a 401 — mirrors the missing-`CRON_SECRET` branch
  in `app/api/cron/invitation-reminders/route.ts`).
- Missing signature header, or missing/non-integer timestamp header → return
  `false`.
- Timestamp outside ±300s of `Date.now()` → return `false` (replay window).
- Compute `HMAC-SHA256(secret, signedPayload)` per §7; compare against the
  header value (after stripping an optional `sha256=` prefix) with
  `timingSafeEqual`. **Buffers of unequal length must return `false`, not
  throw** — length-check before calling `timingSafeEqual`.
- Return `false` for any signature mismatch. Never throw for bad input; only for
  missing config.

### 3. MODIFY `app/api/webhooks/pingram/route.ts` (replace the whole file)

```ts
export async function POST(req: NextRequest): Promise<Response>
```

Use `ok` / `fail` from `@/lib/api/response` and `ErrorCode` from
`@/lib/api/errors` (same imports as `app/api/cron/invitation-reminders/route.ts`).
No Clerk auth, no Supabase client.

1. `const rawBody = await req.text();` — must read the raw text **before** any
   JSON parsing; the signature is over the raw bytes.
2. `verifyPingramWebhook(rawBody, req.headers)` inside try/catch. Thrown error →
   `console.error(...)` + `fail("Internal error", ErrorCode.INTERNAL, 500)`.
3. Falsy result → `fail("Invalid webhook signature", ErrorCode.UNAUTHENTICATED, 401)`.
   **No parsing or processing may happen before this gate.**
4. `JSON.parse(rawBody)` in try/catch → on throw,
   `fail("Invalid JSON body", ErrorCode.VALIDATION_FAILED, 400)`.
5. `pingramWebhookSchema.safeParse(...)` → on failure,
   `fail("Invalid webhook payload", ErrorCode.VALIDATION_FAILED, 400)`.
6. Process: map the raw provider status to a canonical status (§4) and emit one
   `console.info("pingram webhook: delivery status", { messageId, status, rawStatus, errorCode })`.
   Never log the raw body or the full recipient number (redact to last 4 digits
   if logged at all).
7. `return ok({ received: true, messageId, status }, 200);`

Export **only** `POST` (Next.js returns 405 for other methods automatically).

### 4. CREATE `schemas/pingram.ts`

Style to copy: `schemas/invitations.ts` (commented, named exports + inferred
type). Field names come from Q3; the shape below uses the §7 defaults.

```ts
export const pingramWebhookSchema = z.object({
  message_id: z.string().min(1),
  status: z.string().min(1),
  to: z.string().optional(),
  error_code: z.string().nullish(),
  occurred_at: z.string().optional(),
});
export type PingramWebhookPayload = z.infer<typeof pingramWebhookSchema>;

export type PingramDeliveryStatus =
  | "queued" | "sent" | "delivered" | "failed" | "undelivered" | "unknown";

// Unrecognized provider statuses map to "unknown" — the route still 200s so
// Pingram does not retry a callback we simply do not model yet.
export function toDeliveryStatus(raw: string): PingramDeliveryStatus;
```

Zod v3 strips unknown keys by default — keep that (forward-compatible with extra
provider fields).

### 5. CREATE `lib/notifications/sms-templates.ts`

Pure module — **no** `import "server-only"` (same rationale as
`lib/scheduling/reminder.ts`: unit-testable, reusable).

```ts
export const SMS_MAX_LENGTH = 160;

export function setInvitationSms(p: { date: string; roleNote: string | null; link: string }): string;
export function memberReminderSms(p: { date: string; link: string }): string;
export function adminReminderSms(p: { count: number; date: string; link: string }): string;
export function invitationDeniedSms(p: { memberName: string; date: string; reason: string | null; link: string }): string;
export function schedulingConflictSms(p: { memberName: string; date: string; link: string }): string;
export function setlistPublishedSms(p: { date: string; link: string }): string;
export function practiceReminderSms(p: { eventName: string; when: string; time: string; location: string | null }): string;
```

Copy is transcribed verbatim from PRD §30 (doc lines 1698-1707) with
placeholders substituted:

| Builder | Rendered copy |
| --- | --- |
| `setInvitationSms` | `Graceful: You're invited to lead worship on {date}. Role: {roleNote}. Respond here: {link}` |
| `memberReminderSms` | `Graceful: Reminder — your invitation for {date} is still pending. Respond: {link}` |
| `adminReminderSms` | `Graceful: {count} invitation(s) for {date} still awaiting response. View roster: {link}` |
| `invitationDeniedSms` | `Graceful: {memberName} can't make {date}. Reason: {reason}. View roster: {link}` |
| `schedulingConflictSms` | `Graceful: CONFLICT — {memberName} is now unavailable for {date}. View: {link}` |
| `setlistPublishedSms` | `Graceful: The setlist for {date} is live. View it here: {link}` |
| `practiceReminderSms` | `Graceful: {eventName} is {when} at {time} — {location}` |

Optional-field rules: when `roleNote` is null omit ` Role: {roleNote}.`; when
`reason` is null omit ` Reason: {reason}.`; when `location` is null omit
` — {location}`. No double spaces in the result.

160-char guarantee (DB columns allow far longer free text — `role_note` 500,
`reason` 200, `name` 100):
- Truncate free-text inputs before substitution, appending `...` when truncated:
  `memberName` 40, `roleNote` 40, `reason` 60, `eventName` 40, `location` 40.
- Every builder returns its result through a final clamp to `SMS_MAX_LENGTH`.
- Links are always last so a pathological clamp degrades the link, not the
  meaning.

### 6. MODIFY `app/api/cron/invitation-reminders/route.ts`

Only the `sendSms` call site changes (lines 47-62). Replace the positional call
with:

```ts
const result = await sendSms({
  to: reminder.phone,
  body: buildMemberReminderSms(...unchanged...),
  smsOptedIn: reminder.sms_opted_in === true,
});
```

Count `result.status === "sent"` as `smsSent` and `result.status === "skipped"`
as `smsSkipped`; keep the existing try/catch → `smsFailed`. The existing
pre-loop `if (!reminder.phone || reminder.sms_opted_in !== true) { smsSkipped++; continue; }`
guard stays as-is (defense in depth; the response counters keep their current
meaning). Update the stale comment on lines 57-59 that says `sendSms` is a stub.
**Do not change anything else in this file.**

### 7. MODIFY `tests/unit/app/api/cron-invitation-reminders-route.test.ts`

Line 112 asserts the old positional shape:
`expect(mockSendSms).toHaveBeenCalledWith("+15551234567", expect.stringContaining("Jane Doe"))`.
Update it to the options object, and make `mockSendSms.mockResolvedValue({ status: "sent", messageId: "m1" })`
(line 106) instead of `undefined`. No other test in that file, and nothing in
`cron-invitation-reminders-route-tester-supplement.test.ts` (which only asserts
`not.toHaveBeenCalled()`), needs to change.

### 8. MODIFY `.env.example` (Pingram block, lines 26-28)

Add, only if Q1's answer requires them:

```
PINGRAM_API_BASE_URL=   # optional override; defaults to the documented base URL
PINGRAM_SENDER=         # sender number/ID, if Pingram requires one
```

`PINGRAM_SENDER` is included in the send payload only when set and non-empty.

### 9. MODIFY `documentation/staging-environment.md` (line 60)

If §8 adds env vars, add them to the `| Pingram | ... |` row's variable list.
Mark `PINGRAM_API_BASE_URL` / `PINGRAM_SENDER` as shared-or-distinct consistent
with the Q1 answer. No other edit to this doc.

---

## §7 Vendor constants (PROVISIONAL — replace with the Q1/Q2/Q3 answers)

Put these in one clearly-commented block at the top of `lib/pingram/client.ts`
(send) and above `verifyPingramWebhook` in `lib/api/webhook-verify.ts`
(signature), so a corrected contract is a one-place edit.

| Thing | Provisional default |
| --- | --- |
| Send endpoint | `POST ${PINGRAM_API_BASE_URL ?? "https://api.pingram.io/v1"}/messages` |
| Auth header | `Authorization: Bearer ${PINGRAM_API_KEY}` |
| Request body | `{ to, text, from? }` (`from` only when `PINGRAM_SENDER` is set) |
| Response message id | `id` (fall back to `message_id`, then `null`) |
| Signature header | `x-pingram-signature` (optional `sha256=` prefix) |
| Timestamp header | `x-pingram-timestamp` (unix seconds) |
| Signed payload | `` `${timestamp}.${rawBody}` `` |
| Digest | HMAC-SHA256, lowercase hex |
| Replay window | ±300 seconds |
| Webhook payload | `{ message_id, status, to?, error_code?, occurred_at? }` |
| Status values | `queued`, `sent`, `delivered`, `failed`, `undelivered` |

## Edge cases the implementation must handle

**Dispatch**
- `smsOptedIn` false → skipped, **no network call** (AC: enforce opt-in here).
- `smsOptedIn` false *and* phone missing → `not_opted_in` wins (consent checked
  first).
- `to` null / `""` / whitespace → `no_phone`, no network call.
- `to` unparseable (letters, 7 digits, 12 digits) → `invalid_phone`, no network
  call.
- `to` already E.164 (`+15551234567`) → passed through unchanged.
- `to` formatted (`(555) 123-4567`, `555-123-4567`) → normalized to `+1...`.
- Body empty/whitespace → `SmsValidationError`, no network call.
- Body exactly 160 chars → allowed. 161 → `SmsValidationError`.
- `PINGRAM_API_KEY` unset **or** empty string → `SmsNotConfiguredError`, no
  network call.
- Provider 4xx and 5xx → `SmsDispatchError` with `status`.
- Network error / 10s timeout → `SmsDispatchError`.
- 2xx with a non-JSON or id-less body → `{ status: "sent", messageId: null }`.

**Webhook verification**
- No signature header → `false` → route 401.
- Signature present but wrong → `false` → 401.
- Signature of the correct length but different bytes → `false` (timing-safe).
- Signature of a *different* length → `false`, must not throw.
- Timestamp header missing / non-numeric → `false`.
- Timestamp older than 300s (replay) or more than 300s in the future → `false`.
- Body mutated after signing (same signature, different body) → `false`.
- `PINGRAM_WEBHOOK_SECRET` unset/empty → throws → route 500 (**not** 401, and
  **not** a silent pass).

**Webhook route**
- Empty request body → signature gate runs first; if it somehow verifies, JSON
  parse fails → 400.
- Valid signature + malformed JSON → 400 (never 500).
- Valid signature + JSON missing `message_id`/`status` → 400.
- Valid signature + unrecognized status string → 200 with
  `status: "unknown"` (do not 400 — that would make Pingram retry forever).
- Duplicate/repeat callback for the same `message_id` → 200, no error (nothing
  is persisted, so this is naturally idempotent).
- Extra unknown fields in the payload → ignored, still 200.

**Templates**
- Every builder with maximum-length inputs returns `length <= 160`.
- Null `roleNote` / `reason` / `location` produce grammatical copy with no
  double spaces and no dangling separators.
- `count` of 1 still renders `1 invitation(s)` (PRD copy is verbatim).

## Tests the Coder must add

Follow the existing unit-test conventions: `jest.mock` at the top before
imports, `NextRequest` faked as a plain object (see
`tests/unit/app/api/cron-invitation-reminders-route.test.ts` `makeReq`), env vars
set/cleared per test (see `tests/unit/lib/r2/client.test.ts`).

- `tests/unit/lib/pingram/client.test.ts` — mock global `fetch`; cover every
  dispatch edge case above, including "no network call on skip/validation/config
  failure".
- `tests/unit/lib/api/webhook-verify.test.ts` — real `crypto` HMAC to build
  valid signatures; cover every verification edge case above. Only the Pingram
  verifier; leave the other three stubs unasserted.
- `tests/unit/app/api/webhooks-pingram-route.test.ts` — mock
  `@/lib/api/webhook-verify`; assert 401 body has `code: "UNAUTHENTICATED"`,
  assert the 500 config path, the 400 paths, and that a rejected signature never
  reaches JSON parsing.
- `tests/unit/lib/notifications/sms-templates.test.ts` — exact-copy assertions
  per PRD §30 plus the ≤160 property for all seven builders.

## Verification

`bun run lint`, `bun run typecheck`, `bun run test` must all pass. Do not run
`bun test`. Do not add any dependency.
