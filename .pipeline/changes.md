# Changes — Issue #68: Integrate Resend email dispatch + webhook verification

## Summary

Implemented outbound email dispatch via Resend and inbound Resend webhook
verification/handling, replacing the three stubs the spec named. No delivery
events are persisted to the database (no schema for it yet — logged instead,
per the spec's documented scope decision). No new dependencies were added;
`resend` and `svix` were already in `package.json`.

## Files changed

- **`lib/resend/templates.ts`** (new) — Pure, unit-testable module rendering
  the 7 PRD §30 email templates (`set_invitation`,
  `invitation_reminder_member`, `invitation_reminder_admin`,
  `invitation_denied`, `scheduling_conflict`, `setlist_released`,
  `practice_reminder`) to `{ subject, preview, html, text }`. HTML-escapes all
  interpolated values via a local `escapeHtml` helper (subject/preview/link);
  `text` is left unescaped. Edge cases implemented: unknown key throws,
  `invitation_reminder_admin` throws on empty `memberNames`, `count` is never
  derived from `memberNames.length`, `invitation_denied` drops the "Reason:"
  clause when `reason` is `null` or whitespace-only, `practice_reminder`
  omits the `<a>` element/trailing URL line when `link` is absent. No
  `import "server-only"` (mirrors `lib/scheduling/reminder.ts` so it's
  unit-testable) and never imports `formatWeekLabel` or otherwise
  parses/formats dates itself.

- **`lib/resend/client.ts`** (rewritten from stub) — Lazy-singleton Resend
  client following `lib/r2/client.ts`'s `getClient()` pattern:
  `RESEND_API_KEY` + `RESEND_FROM_EMAIL` are validated on first use (throws
  `"Resend is not configured — missing required environment variable(s)"` if
  either is missing/empty), and the `Resend` instance is built once and
  reused. `sendEmail<K>(to, template, data)` throws on an empty/whitespace
  `to` before touching env or the SDK, renders via `renderEmailTemplate`,
  calls `resend.emails.send({ from, to, subject, html, text })` (passing
  `RESEND_FROM_EMAIL` through verbatim, unparsed), and throws
  `` `Resend email dispatch failed: ${message}` `` when the SDK returns an
  `error` or a null `data`; otherwise returns `{ id }`. Never logs recipient,
  subject, or body. Also exports the pure `mapResendEventToStatus(eventType)`
  mapper (`email.sent`→`sent`, `email.delivered`→`delivered`,
  `email.delivery_delayed`→`delayed`, `email.bounced`→`bounced`,
  `email.complained`→`complained`, `email.opened`→`opened`,
  `email.clicked`→`clicked`, anything else → `null`), used by the webhook
  handler and covered directly by tests.

- **`lib/api/webhook-verify.ts`** (modified — `verifyResendWebhook` only) —
  Implemented using `svix`'s `Webhook` class + `RESEND_WEBHOOK_SECRET`. Throws
  a config error if the secret is missing/empty (config errors propagate per
  the file's existing contract); returns `false` (does not throw) if any of
  `svix-id` / `svix-timestamp` / `svix-signature` headers are missing/empty;
  returns `true`/`false` based on whether `webhook.verify(...)` succeeds or
  throws. The other three stubs (`verifyClerkWebhook`, `verifyPingramWebhook`,
  `verifyModalWebhook`) and the file's header comment are untouched, byte-
  identical apart from replacing the `TODO(Sprint 4 #59)` comment above
  `verifyResendWebhook` with a real one.

- **`app/api/webhooks/resend/handler.ts`** (new) — `handleResendWebhook(req)`
  implements the load-bearing order from the spec: `req.text()` first (never
  `req.json()` before verification) → `verifyResendWebhook` in a try/catch
  (throw → 500 `INTERNAL`, `false` → 401 `UNAUTHENTICATED`) → `JSON.parse` the
  raw body and validate it's an object with a non-empty string `type` and a
  non-empty string `data.email_id` (any failure → 400 `VALIDATION_FAILED`) →
  `mapResendEventToStatus(type) ?? "ignored"` → `console.info("resend
  webhook", { type, emailId, status })` (never logs the payload or a
  recipient) → `ok({ received: true, emailId, status })` (200, even for
  unknown/future event types, so Resend doesn't retry-storm on 4xx).

- **`app/api/webhooks/resend/route.ts`** (modified) — Reduced to a pure
  delegation shim exporting only `POST`, which calls
  `handleResendWebhook(req)`. Dropped the `notImplemented` import/stub.

- **`.env.example`** (modified) — Added `RESEND_FROM_EMAIL=` (placeholder,
  no value) under the existing `# Resend (Email)` block, after
  `RESEND_WEBHOOK_SECRET=`.

- **`documentation/staging-environment.md`** (modified) — Added
  `RESEND_FROM_EMAIL` to the Resend row's variable list in the env-var table.
  Nothing else in the file changed.

- **`tests/unit/lib/resend/templates.test.ts`** (new) — All 7 template keys'
  exact subject/preview copy; full HTML structure assertions for
  `set_invitation` (with link) and `practice_reminder` (without link); HTML
  escaping of a name containing `<script>` and `&` (asserts `text`/`subject`
  stay unescaped); `invitation_denied` with `reason: null` and `"   "`;
  `invitation_reminder_admin` empty-`memberNames` throw and "count from
  caller, not derived" case; unknown-key throw; `EMAIL_TEMPLATE_KEYS`
  contents.

- **`tests/unit/lib/resend/client.test.ts`** (new) — Mirrors
  `tests/unit/lib/r2/client.test.ts`'s `clearEnv`/`setValidEnv` +
  `jest.isolateModulesAsync` re-import pattern, mocking the `resend` package.
  Covers: happy path (`{id}` + exact `from`/`to`/`subject`/`html`/`text`
  passthrough), missing/empty `RESEND_API_KEY` and `RESEND_FROM_EMAIL` throw
  without invoking the SDK, empty/whitespace `to` throws first, `{error}`
  response throws with the SDK's message, null `data`/`error` throws a
  generic message, singleton construction (`Resend` ctor called once across
  two `sendEmail` calls), and `mapResendEventToStatus` for every known type
  plus an unknown one.

- **`tests/unit/lib/api/webhook-verify-resend.test.ts`** (new) — Mocks
  `svix`'s `Webhook`. Covers: valid signature → `true`; `verify()` throwing →
  `false`; each of the three svix headers missing → `false` without calling
  `verify()`; missing/empty `RESEND_WEBHOOK_SECRET` → rejects without
  constructing `Webhook`.

- **`tests/unit/app/api/webhooks-resend-route.test.ts`** (new) — Mocks
  `@/lib/api/webhook-verify` and `@/lib/resend/client`, exercises `POST` from
  `route.ts` end to end (through the handler). Covers: valid signed
  `email.delivered` → 200 with `{received, emailId, status}`; bad signature →
  401 `UNAUTHENTICATED` and `req.json` never called; `verifyResendWebhook`
  throwing → 500 `INTERNAL`; malformed JSON → 400 `VALIDATION_FAILED`;
  missing `data.email_id` → 400; missing `type` → 400; unknown event type →
  200 with `status: "ignored"`; asserts `req.text()` is used, not
  `req.json()`.

## Not touched (out of scope, per spec)

- No migration added; no writes to any table — delivery events are only
  logged.
- `lib/pingram/client.ts` (SMS, #67) untouched.
- `verifyClerkWebhook`, `verifyPingramWebhook`, `verifyModalWebhook`
  untouched (still stubs).
- `app/api/webhooks/{clerk,pingram,modal}/route.ts` untouched.
- `middleware.ts` untouched (already treats `/api/webhooks(.*)` as public).
- No dependency changes; `bun.lock` untouched.

## Verification run

From the repo root, in order: `bun install`, `bun run lint`, `bun run
typecheck`, `bun run test`. All green:
- `eslint .` — no errors.
- `tsc --noEmit` — no errors.
- `jest` — 85 suites / 1086 tests passed (including the 4 new suites: 46
  tests across templates, client, webhook-verify-resend, and the route).

## What the Tester should focus on

- The load-bearing order in `handleResendWebhook` (`req.text()` before any
  verification/parsing; verification before `JSON.parse`).
- HTML-escaping correctness in `templates.ts`, especially that `subject`/
  `preview`/`text` on the returned object stay **unescaped** while the `html`
  string is escaped (this is easy to get backwards).
- That an unknown/future Resend event type always yields 200 (never 4xx).
- That `sendEmail`/`getClient` never log recipient, subject, or body
  anywhere (including on error paths).
- The `.env.example` / `documentation/staging-environment.md` edits are
  additive-only — no other lines in either file should have changed.
