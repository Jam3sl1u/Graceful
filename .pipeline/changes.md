# Changes — Issue #67: Integrate Pingram SMS dispatch + webhook verification

## Human resolution applied

The planner flagged a blocking OPEN QUESTION (no confirmed Pingram API
contract in the repo — send endpoint/auth, webhook signature scheme,
delivery-status payload shape). A human resolved it: **use the provisional
defaults in `.pipeline/spec.md` §7 as-is**, understood to be unverified
guesses at Pingram's real API that may need correction once confirmed against
Pingram's actual docs/dashboard. All vendor-contract constants below are
implemented exactly as specified in §7 and are collected in one clearly
commented block per file so a corrected contract is a one-place edit.

## Files changed

- **`lib/pingram/client.ts`** (replaced stub) — real `sendSms` implementation.
  - `SmsNotConfiguredError`, `SmsValidationError`, `SmsDispatchError` (with
    `status?`) error classes.
  - `toE164(raw)` — US-only phone normalization (strips separators; accepts
    already-E.164, bare 10-digit, or 11-digit-leading-1; else `null`).
  - `sendSms({ to, body, smsOptedIn })` — options-object signature (breaking
    change from the old 2-arg positional stub). Order of operations is
    load-bearing: opt-in check → phone presence → phone format → body
    non-empty → body ≤160 chars → `PINGRAM_API_KEY` configured → `fetch` the
    send endpoint. No network call on any skip/validation/config failure.
  - Provisional vendor constants (§7): `POST
    ${PINGRAM_API_BASE_URL ?? "https://api.pingram.io/v1"}/messages`,
    `Authorization: Bearer ${PINGRAM_API_KEY}`, body `{ to, text, from? }`
    (`from` only when `PINGRAM_SENDER` is set/non-empty), response message id
    from `id` falling back to `message_id`, then `null`. 10s timeout via
    `AbortSignal.timeout`. Never logs the API key, full recipient number, or
    message body.

- **`lib/api/webhook-verify.ts`** (modified — `verifyPingramWebhook` only;
  the other three stubs are untouched) — real HMAC-SHA256 verification using
  `createHmac` + `timingSafeEqual` from `crypto`.
  - Missing/empty `PINGRAM_WEBHOOK_SECRET` → throws (500 config fault, not a
    401).
  - Missing signature/timestamp header, non-integer timestamp, timestamp
    outside ±300s of now, or signature mismatch → returns `false` (never
    throws for bad input).
  - Buffers of unequal length are rejected by a length check *before*
    `timingSafeEqual` is called, so mismatched-length signatures return
    `false` instead of throwing.
  - Provisional vendor constants (§7): header `x-pingram-signature` (optional
    `sha256=` prefix), `x-pingram-timestamp` (unix seconds), signed payload
    `` `${timestamp}.${rawBody}` ``, HMAC-SHA256 lowercase hex, ±300s replay
    window.

- **`app/api/webhooks/pingram/route.ts`** (replaced stub) — real `POST`
  handler. Reads raw text before any JSON parsing (signature is over raw
  bytes) → `verifyPingramWebhook` in try/catch (throw → 500 `INTERNAL`) →
  falsy result → 401 `UNAUTHENTICATED` (this gate runs before any
  parsing/processing) → `JSON.parse` in try/catch (throw → 400
  `VALIDATION_FAILED`) → `pingramWebhookSchema.safeParse` (failure → 400
  `VALIDATION_FAILED`) → maps raw status to canonical status via
  `toDeliveryStatus`, logs one structured `console.info` line (never logs raw
  body or full recipient), returns `ok({ received: true, messageId, status
  })`. Exports only `POST`. No Clerk auth, no Supabase client (middleware
  already makes `/api/webhooks(.*)` public).

- **`schemas/pingram.ts`** (new) — `pingramWebhookSchema` (Zod v3, strips
  unknown keys), `PingramWebhookPayload` type, `PingramDeliveryStatus` union,
  and `toDeliveryStatus(raw)` which maps unrecognized provider status strings
  to `"unknown"` (so the route still 200s and Pingram doesn't retry forever).

- **`lib/notifications/sms-templates.ts`** (new, no `import "server-only"` —
  pure/unit-testable like `lib/scheduling/reminder.ts`) — `SMS_MAX_LENGTH =
  160` plus seven builders transcribed verbatim from PRD §30:
  `setInvitationSms`, `memberReminderSms`, `adminReminderSms`,
  `invitationDeniedSms`, `schedulingConflictSms`, `setlistPublishedSms`,
  `practiceReminderSms`. Free-text inputs are truncated (with a trailing
  `...`) before substitution — `memberName`/`roleNote`/`eventName`/`location`
  at 40 chars, `reason` at 60 — and every builder's result passes through a
  final hard clamp to `SMS_MAX_LENGTH` (links are always last in the
  template, so a pathological clamp degrades the link, not the meaning).
  Optional fields (`roleNote`, `reason`, `location`) are omitted cleanly (no
  double spaces / dangling separators) when null. **Not yet wired to any
  caller** — per spec decision, rewiring live triggers to these templates is
  issue #69; they're covered by their own unit tests only.

- **`app/api/cron/invitation-reminders/route.ts`** (only the `sendSms` call
  site changed, per spec §6) — switched to the new options-object call
  (`{ to, body, smsOptedIn }`); counts `result.status === "sent"` as
  `smsSent` and `"skipped"` as `smsSkipped`; the existing try/catch →
  `smsFailed` and the pre-loop phone/opt-in guard are unchanged. Updated the
  stale "sendSms is a stub" comment.

- **`tests/unit/app/api/cron-invitation-reminders-route.test.ts`** — updated
  the happy-path assertion (line ~106-116) from the old positional-args
  `mockSendSms` call/`undefined` resolution to the new options-object call
  and `{ status: "sent", messageId: "m1" }` resolution, per spec §7. No other
  test in this file changed.

- **`.env.example`** — added `PINGRAM_API_BASE_URL` (optional override) and
  `PINGRAM_SENDER` (sender number/ID, included in the send payload only when
  set) to the Pingram block.

- **`documentation/staging-environment.md`** — added the two new env vars to
  the Pingram row of the §3 variable table, marked distinct/optional
  consistent with the Q1 answer. No other edit to this doc.

- **`.pipeline/spec.md`** — this was already updated in the working tree
  (issue #67's spec, produced by the Planning stage) before this Coding
  session started; included in this commit as part of the normal pipeline
  handoff. No further edits made to it by the Coding stage.

## Tests added

- **`tests/unit/lib/pingram/client.test.ts`** — mocks `global.fetch`; covers
  `toE164` normalization/rejection cases and every `sendSms` edge case from
  the spec (opt-in precedence over missing phone, no-phone, invalid-phone,
  empty/161-char body, 160-char-exactly allowed, missing/empty API key,
  default vs. overridden base URL, conditional `from` field, 4xx/5xx/network
  failures, non-JSON/id-less 2xx body, `message_id` fallback) — asserting no
  network call happens on every skip/validation/config path.
- **`tests/unit/lib/api/webhook-verify.test.ts`** — uses real `crypto` HMAC
  to build valid signatures; covers missing/empty secret (throws), valid
  signature with/without `sha256=` prefix, missing signature/timestamp
  header, wrong signature, same-length-but-different-bytes signature,
  different-length signature (must not throw), non-numeric timestamp,
  timestamp outside the replay window (past and future), and a mutated body
  after signing. Only `verifyPingramWebhook` is asserted; the other three
  stubs are untouched.
- **`tests/unit/app/api/webhooks-pingram-route.test.ts`** — mocks
  `@/lib/api/webhook-verify`; asserts the 500 config-throw path, that a
  rejected signature returns 401 `UNAUTHENTICATED` *before* JSON parsing
  (proved via a malformed-JSON body that only 400s once the signature is
  valid), the 400 malformed-JSON and 400 schema-validation paths, a 200 with
  `status: "unknown"` for an unrecognized provider status, extra unknown
  fields being ignored, and the happy path (200 + structured `console.info`
  log line).
- **`tests/unit/lib/notifications/sms-templates.test.ts`** — exact-copy
  assertions per PRD §30 for all seven builders (including the literal `"1
  invitation(s)"` copy for `count: 1`), optional-field omission with no
  double spaces/dangling separators, truncation-with-`...` at each field's
  limit, and the ≤160 `SMS_MAX_LENGTH` property under maximum-length inputs.

## Verification

- `bun run lint` — clean.
- `bun run typecheck` — clean.
- `bun run test` — 85 suites / 1110 tests passed (includes the 4 new test
  files and the 1 updated cron test).
- No new dependency added; no DB migration added (per spec decisions 1-2).

## What the Tester should focus on

1. **The provisional vendor contract is a guess, not a fact.** Every assumed
   header/field/URL name is confined to the two commented blocks in
   `lib/pingram/client.ts` and `lib/api/webhook-verify.ts` — verify tests
   exercise the *documented* contract (as coded) rather than accidentally
   asserting some other shape.
2. **Signature-gate ordering in the webhook route** — confirm a falsy/absent
   signature never reaches `JSON.parse` (401 path), and that a thrown
   verifier error (missing secret) is a 500, not a 401 or silent pass.
3. **`timingSafeEqual` length handling** — a signature of a different length
   than expected must return `false`, never throw (would otherwise be an
   unhandled 500 on attacker-controlled input).
4. **`sendSms` opt-in precedence** — `smsOptedIn: false` short-circuits
   before the phone is even inspected, and no scenario reaches `fetch` except
   the fully-valid path.
5. **The cron route's counters** — `smsSent` vs `smsSkipped` now come from
   `sendSms`'s returned `status`, not from a boolean return; confirm the
   updated test still matches the route's actual counting logic.
6. **`lib/notifications/sms-templates.ts` is intentionally unwired** — no
   caller change outside the cron route's existing `buildMemberReminderSms`
   call (that one is untouched, per spec decision 3). Don't flag the new
   templates as dead code; wiring them is issue #69.
