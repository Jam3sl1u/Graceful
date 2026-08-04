# Test Results — Issue #67: Integrate Pingram SMS dispatch + webhook verification

This overwrites the stale `test-results.md` (for issue #65) that was still
sitting at this path (per AGENTS.md, `.pipeline/` files reflect only the
most recent run).

## Verdict: ALL PASS

All verification commands were re-run independently, from a confirmed
`pwd` of `/Users/jamesliu/Documents/Graceful/.claude/worktrees/issue-67`,
and all pass. No implementation code was changed by this stage — only
tests were added.

## Commands re-run

- `bun run lint` — clean (no errors/warnings).
- `bun run typecheck` — clean (no errors).
- `bun run test` — **87 suites / 1130 tests pass**, 0 failures (85 suites /
  1110 tests from the Coder's commit + 2 new suites / 20 new tests added by
  this stage). No regressions in any pre-existing suite.

## Independent code review against `.pipeline/spec.md`

Read the full diff (`git show --stat HEAD`) and every changed
implementation file, and cross-checked each against spec.md §1–§9 and §7's
provisional vendor constants:

- `lib/pingram/client.ts` — `sendSms`'s order of operations matches the
  spec exactly (opt-in → phone presence → phone format → body empty →
  body >160 chars → API key configured → fetch). `toE164` rules match
  verbatim (strip separators; already-E.164; 10-digit; 11-digit-leading-1;
  else null). §7 vendor constants (base URL, `Authorization: Bearer`
  header, `{to, text, from?}` body, response id fallback chain `id` →
  `message_id` → `null`, 10s `AbortSignal.timeout`) are implemented as
  specified and confined to one commented block. Never logs the API key,
  full recipient, or body.
- `lib/api/webhook-verify.ts` — `verifyPingramWebhook` keeps the exact
  `(rawBody, headers) => Promise<boolean>` signature. Missing/empty secret
  **throws** (not a false return); missing signature/timestamp header,
  non-integer timestamp, and out-of-±300s-window timestamp all return
  `false`. The length check precedes `timingSafeEqual`, so a
  different-length signature returns `false` instead of throwing. The
  optional `sha256=` prefix is stripped correctly. The other three webhook
  verifiers (Clerk/Resend/Modal) are untouched stubs, as scoped.
- `app/api/webhooks/pingram/route.ts` — reads raw text before any parsing;
  `verifyPingramWebhook` is wrapped in try/catch (throw → 500 `INTERNAL`);
  a falsy result → 401 `UNAUTHENTICATED` strictly before any `JSON.parse`
  call (confirmed by reading the source — the `verified` check is the only
  gate before parsing); malformed JSON → 400; schema failure → 400; an
  unrecognized status still maps to `"unknown"` and the route still 200s.
  Exports only `POST`.
- `schemas/pingram.ts` — matches the §7 payload shape; Zod v3's default
  unknown-key stripping is preserved; `toDeliveryStatus` maps only the five
  named statuses through, everything else (including an empty string or a
  differently-cased string) to `"unknown"`.
- `lib/notifications/sms-templates.ts` — all seven builders' copy matches
  the spec's PRD §30 table verbatim, including the literal `"1
  invitation(s)"` non-pluralized copy at `count: 1`. Truncation limits
  (`memberName`/`roleNote`/`eventName`/`location` at 40, `reason` at 60)
  and the final `SMS_MAX_LENGTH` (160) clamp are both present. Confirmed
  (via grep) that no file outside its own test imports from this module —
  consistent with spec decision 4 (rewiring is issue #69's job, not dead
  code to flag).
- `app/api/cron/invitation-reminders/route.ts` — only the `sendSms` call
  site changed, matching the exact options-object shape in spec §6;
  counts `result.status === "sent"` as `smsSent` and any other resolved
  status as `smsSkipped`; the existing try/catch → `smsFailed` and the
  pre-loop phone/opt-in guard are both unchanged, as required.
- `.env.example` / `documentation/staging-environment.md` — the new
  `PINGRAM_API_BASE_URL` / `PINGRAM_SENDER` vars were added consistently
  in both places, matching §8/§9.

No scope creep found — no files outside the spec's file list were touched
(aside from `.pipeline/spec.md` itself, which changes.md notes was already
in the working tree from the Planning stage's handoff).

## Tests added this stage (independent verification, not just re-running the Coder's suite)

- **`tests/unit/schemas/pingram.test.ts`** (new — `schemas/pingram.ts`
  previously had no dedicated unit test; it was only covered indirectly
  through the webhook route test's mocked verifier). Covers: happy path
  (minimal and full payloads), unknown-key stripping, nullable
  `error_code`, four failure cases (missing `message_id`, missing
  `status`, empty-string `message_id`, empty-string `status`, and
  non-object payloads — `null`/string/array), and `toDeliveryStatus`'s
  edge cases (all five known statuses pass through unchanged; an
  unrecognized, empty, or differently-cased status string all map to
  `"unknown"`).
- **`tests/unit/app/api/cron-invitation-reminders-route-issue67-supplement.test.ts`**
  (new — closes a real gap in the Coder's cron route test). The Coder's
  suite only exercises `sendSms` resolving `{status:"sent"}` or rejecting;
  it never exercises `sendSms` *resolving* with `{status:"skipped", reason:
  ...}` from inside the try block (e.g. an unparseable phone number that
  slipped past the route's own coarse `!phone || !opted_in` pre-check —
  a plausible real case, since that guard only checks presence/opt-in, not
  phone format). This file asserts that resolution is counted as
  `smsSkipped`, not `smsSent`/`smsFailed`; also independently asserts the
  options-object call shape (`{to, body, smsOptedIn}`), and asserts
  sent/skipped/failed tally correctly and independently across a 3-row
  mixed batch (one sent, one skipped, one failed).

Both new files pass. Running the full suite together with the Coder's four
new test files and one updated test confirms no regressions or
cross-file interaction issues.

## Findings against the "What the Tester should focus on" list in `changes.md`

1. **Provisional vendor contract confinement** — confirmed: the only two
   commented constant blocks (top of `lib/pingram/client.ts`, above
   `verifyPingramWebhook` in `lib/api/webhook-verify.ts`) are the sole
   places the guessed wire contract appears; tests assert the *coded*
   contract, not some other invented shape.
2. **Signature-gate ordering** — confirmed via the Coder's
   malformed-JSON-with-rejected-signature-still-401 test, and independently
   re-read the route source: `JSON.parse` is unreachable before the
   `verified` check runs.
3. **`timingSafeEqual` length handling** — confirmed: the length check
   precedes the call in source, and the Coder's different-length-signature
   test resolves `false` rather than throwing.
4. **`sendSms` opt-in precedence** — confirmed: `smsOptedIn !== true` is
   the very first branch, before `to` is even read; the Coder's
   "not_opted_in wins even when phone is also missing" test proves this,
   and no test scenario reaches `fetch` except the fully-valid path.
5. **Cron route counters** — the Coder's own suite only exercised `sendSms`
   resolving `"sent"` or rejecting; this stage's new supplement test closes
   that gap by exercising a resolved `"skipped"` status directly and
   confirms the route counts it as `smsSkipped`, matching the route's
   actual source.
6. **`sms-templates.ts` intentionally unwired** — confirmed via grep that
   no file outside its own test imports from `lib/notifications/sms-templates`;
   not flagged as dead code, consistent with spec decision 4 / issue #69
   scope.

## Failure-case coverage confirmed present

At least one genuine failure case is covered in every area touched by this
issue, beyond what's summarized above:
- `sendSms` throwing `SmsDispatchError`/`SmsValidationError`/
  `SmsNotConfiguredError` on provider 4xx/5xx, network error, empty/161-char
  body, and missing/empty API key.
- `verifyPingramWebhook` throwing on a missing/empty
  `PINGRAM_WEBHOOK_SECRET`.
- The webhook route's 500/401/400 paths.
- `pingramWebhookSchema.safeParse` failing on missing/empty required
  fields and non-object input (this stage's addition).

## Overall

No failures found; nothing needed to be patched around. The implementation
matches `.pipeline/spec.md`, `changes.md`'s claims are accurate and were
independently reproduced, and the tests added by this stage close two real
coverage gaps without requiring any code fix. Ready for Review.

## Files added by this stage (Testing)

- `/Users/jamesliu/Documents/Graceful/.claude/worktrees/issue-67/tests/unit/schemas/pingram.test.ts`
- `/Users/jamesliu/Documents/Graceful/.claude/worktrees/issue-67/tests/unit/app/api/cron-invitation-reminders-route-issue67-supplement.test.ts`

No implementation files were modified by this stage.
