# Spec — Issue #68: [Sprint 4] Integrate Resend email dispatch + webhook verification

## OPEN QUESTIONS

None. Nothing here requires a human decision — proceed.

Two scope decisions were made from the current repo state (documented, not blocking):

1. **No delivery-event persistence.** There is no email/SMS delivery-log table in the
   schema (`supabase/migrations/20260702000005_cluster_5_partial.sql` Cluster 5 has only
   `availability`, `notification_preferences`, `notifications`). Adding a migration is out
   of scope for this issue. "Processes Resend callbacks" is therefore implemented as
   verify → parse → normalize to a delivery status → structured log → 200 ack. **Do not
   add a migration or write to any table.**
2. **`RESEND_FROM_EMAIL` is a new env var.** Resend's API requires a `from` value and no
   existing var supplies one. Added as a placeholder to `.env.example` +
   `documentation/staging-environment.md` only; no real value is committed.

## Current state (verified, do not re-derive)

- `lib/resend/client.ts` — stub, `sendEmail(_to, _template, _data): Promise<void>` throws.
- `lib/api/webhook-verify.ts` — 4 stubs; only `verifyResendWebhook` is in scope.
- `app/api/webhooks/resend/route.ts` — returns `notImplemented("POST /api/webhooks/resend")`.
- `middleware.ts` already treats `/api/webhooks(.*)` as a public route — **no middleware change needed.**
- `package.json` already depends on `resend@^4.8.0` and `svix@^1.99.1` (Resend signs webhooks
  with Svix). **Do not add, remove, or upgrade any dependency; do not touch `bun.lock`.**
- `.env.example` already has `RESEND_API_KEY` and `RESEND_WEBHOOK_SECRET`.
- `node_modules/` is not present in this worktree — run `bun install` first.
- No caller of `sendEmail` exists yet (#69 will be the caller), so its signature is free to change.
- SMS (#67, `lib/pingram/client.ts`) is still a stub. **Do not touch it**, do not touch
  `verifyClerkWebhook` / `verifyPingramWebhook` / `verifyModalWebhook`, and do not touch
  `app/api/webhooks/{clerk,pingram,modal}/route.ts`.

## Files to create / modify

| Path | Action |
| --- | --- |
| `lib/resend/templates.ts` | CREATE |
| `lib/resend/client.ts` | MODIFY (replace stub) |
| `lib/api/webhook-verify.ts` | MODIFY (`verifyResendWebhook` only) |
| `app/api/webhooks/resend/handler.ts` | CREATE |
| `app/api/webhooks/resend/route.ts` | MODIFY (delegate to handler) |
| `.env.example` | MODIFY (add `RESEND_FROM_EMAIL=`) |
| `documentation/staging-environment.md` | MODIFY (add `RESEND_FROM_EMAIL` to the Resend env row) |
| `tests/unit/lib/resend/templates.test.ts` | CREATE |
| `tests/unit/lib/resend/client.test.ts` | CREATE |
| `tests/unit/lib/api/webhook-verify-resend.test.ts` | CREATE |
| `tests/unit/app/api/webhooks-resend-route.test.ts` | CREATE |

---

## 1. `lib/resend/templates.ts` (CREATE)

Pure module — **no `import "server-only"`**, same rationale as `lib/scheduling/reminder.ts`
(pure so it is unit-testable). Copy that file's header-comment style.

```ts
export type EmailTemplateKey =
  | "set_invitation"
  | "invitation_reminder_member"
  | "invitation_reminder_admin"
  | "invitation_denied"
  | "scheduling_conflict"
  | "setlist_released"
  | "practice_reminder";

export const EMAIL_TEMPLATE_KEYS: readonly EmailTemplateKey[];

export type EmailTemplateDataMap = {
  set_invitation: { date: string; adminName: string; link: string };
  invitation_reminder_member: { date: string; link: string };
  invitation_reminder_admin: { count: number; date: string; memberNames: string[]; link: string };
  invitation_denied: { memberName: string; date: string; reason: string | null; link: string };
  scheduling_conflict: { memberName: string; date: string; link: string };
  setlist_released: { date: string; songCount: number; link: string };
  practice_reminder: {
    eventName: string;
    hoursUntil: number;
    dayDate: string;
    time: string;
    location: string;
    link?: string;
  };
};

export type RenderedEmail = { subject: string; preview: string; html: string; text: string };

export function renderEmailTemplate<K extends EmailTemplateKey>(
  key: K,
  data: EmailTemplateDataMap[K],
): RenderedEmail;
```

### Copy (verbatim from PRD §30 "Notification Content Templates")

These 7 keys are exactly the §30 rows that specify an email subject. The §30 rows without a
`Subject:` (invitation accepted, new document, transcription complete) are in-app-only and
are **not** in scope.

Bracketed tokens below are substitution points, not literal text. Subjects are written in
§30 as `Subject: <text>. Preview: <text>` — the period before `Preview:` is a table
separator, so **subjects carry no trailing period**. Preview strings keep their punctuation
exactly, including the em dash (U+2014) in `practice_reminder`.

| key | subject | preview |
| --- | --- | --- |
| `set_invitation` | `You're invited to lead worship on {date}` | `{adminName} has selected you for {date}. Tap to accept or decline.` |
| `invitation_reminder_member` | `Your invitation for {date} needs a response` | `You haven't responded yet. Please accept or decline.` |
| `invitation_reminder_admin` | `{count} unanswered invitations for {date}` | `The following members haven't responded: {memberNames joined by ", "}` |
| `invitation_denied` | `{memberName} declined for {date}` | `Reason: {reason}. Open Graceful to find a replacement.` |
| `scheduling_conflict` | `Scheduling conflict for {date}` | `{memberName} changed their availability after confirming. Action may be needed.` |
| `setlist_released` | `Setlist for {date} is ready` | `{songCount} songs planned. Open Graceful to see the full setlist and your chord charts.` |
| `practice_reminder` | `Reminder: {eventName} in {hoursUntil} hours` | `{dayDate} at {time} — {location}. See you there.` |

### Rendering rules

- All `date` / `dayDate` / `time` fields are **already-formatted display strings** supplied
  by the caller. This module must never parse or format a date — #69 owns that (see
  `formatWeekLabel` in `lib/scheduling/reminder.ts`). Do not import from that file.
- `html` is exactly (single line, no extra whitespace between tags):
  `<!doctype html><html><body>` +
  `<div style="display:none;max-height:0;overflow:hidden;">{preview}</div>` +
  `<h1>{subject}</h1>` +
  `<p>{preview}</p>` +
  `<p><a href="{link}">Open Graceful</a></p>` (omit this element entirely when `link` is absent) +
  `</body></html>`
- `text` is `` `${subject}\n\n${preview}` ``, plus `` `\n\n${link}` `` when `link` is present.
- **HTML escaping**: every interpolated value in `html` (subject, preview, and the `link`
  in `href`) must be escaped for `&`, `<`, `>`, `"`, `'` via a module-local `escapeHtml`
  helper. Member names, denial reasons and locations are user-supplied (PRD §25). `text`
  is *not* escaped. `subject` and `preview` on the returned object are the **unescaped**
  strings.
- Do not add styling, images, or layout beyond the above — visual polish is explicitly out
  of scope for this issue.

### Edge cases

- `renderEmailTemplate` called with a key not in `EMAIL_TEMPLATE_KEYS` (possible from an
  untyped JS caller): throw `` new Error(`Unknown email template: ${key}`) ``.
- `invitation_denied` with `reason === null` or a whitespace-only reason: drop the whole
  `Reason: …. ` clause, so preview is exactly `Open Graceful to find a replacement.`
- `invitation_reminder_admin` with an empty `memberNames` array: throw
  `new Error("invitation_reminder_admin requires at least one member name")`.
- `invitation_reminder_admin`: `count` is rendered as given by the caller; do not derive it
  from `memberNames.length`.
- `practice_reminder` with `link` absent/undefined: no `<a>` element in `html`, no trailing
  URL line in `text`.

---

## 2. `lib/resend/client.ts` (MODIFY — replace the stub entirely)

Keep `import "server-only";`. Follow the lazy-singleton + env-guard pattern of
`lib/r2/client.ts` exactly (module-scope `let client`, private `getClient()` that validates
env before constructing).

```ts
export type SendEmailResult = { id: string };

export async function sendEmail<K extends EmailTemplateKey>(
  to: string,
  template: K,
  data: EmailTemplateDataMap[K],
): Promise<SendEmailResult>;

export type EmailDeliveryStatus =
  | "sent" | "delivered" | "delayed" | "bounced" | "complained" | "opened" | "clicked";

// Pure mapper — exported for the webhook handler and for tests.
export function mapResendEventToStatus(eventType: string): EmailDeliveryStatus | null;
```

Behavior:

- `getClient()` reads `RESEND_API_KEY` and `RESEND_FROM_EMAIL`. If either is missing or an
  empty string, throw
  `new Error("Resend is not configured — missing required environment variable(s)")`
  (mirrors `lib/r2/client.ts`'s message shape). The `Resend` client is constructed once and
  reused.
- `sendEmail` throws `new Error("sendEmail requires a recipient address")` when `to` is
  empty or whitespace-only, before touching env or the SDK.
- Render with `renderEmailTemplate(template, data)`, then call
  `resend.emails.send({ from: process.env.RESEND_FROM_EMAIL, to, subject, html, text })`.
  `RESEND_FROM_EMAIL` is passed through verbatim (it may be either `a@b.com` or
  `Graceful <a@b.com>`); do not parse or reformat it.
- resend v4 returns `{ data, error }`. If `error` is non-null **or** `data` is null, throw
  `` new Error(`Resend email dispatch failed: ${error?.message ?? "unknown error"}`) ``.
  Otherwise return `{ id: data.id }`.
- Never log the recipient address, subject, or body (PRD §25.6).
- `mapResendEventToStatus`: `email.sent`→`sent`, `email.delivered`→`delivered`,
  `email.delivery_delayed`→`delayed`, `email.bounced`→`bounced`,
  `email.complained`→`complained`, `email.opened`→`opened`, `email.clicked`→`clicked`;
  anything else → `null`.

---

## 3. `lib/api/webhook-verify.ts` (MODIFY — `verifyResendWebhook` only)

Keep the file's existing header comment and the other three stubs byte-identical. Replace
the `TODO(Sprint 4 #59)` comment above `verifyResendWebhook` with a real comment. Signature
stays `(rawBody: string, headers: Headers): Promise<boolean>`.

Implementation:

- Read `RESEND_WEBHOOK_SECRET`; if missing or empty, **throw**
  `new Error("Resend webhook is not configured — RESEND_WEBHOOK_SECRET must be set")`
  (the file's contract is "boolean (or throw) out"; a config error is not a bad signature).
- Read `svix-id`, `svix-timestamp`, `svix-signature` from `headers`. If any is missing/empty,
  **return `false`** (do not throw).
- `new Webhook(secret).verify(rawBody, { "svix-id": …, "svix-timestamp": …, "svix-signature": … })`
  from `svix`. Return `true` on success; return `false` when `verify` throws (bad signature,
  stale timestamp, tampered body). A throw from the `Webhook` **constructor** (malformed
  secret) is a config error and must propagate.

---

## 4. `app/api/webhooks/resend/handler.ts` (CREATE)

Follows the repo's route/handler split (see `app/api/events/[id]/ics/route.ts` +
`app/api/events/[id]/ics/handler.ts`) so the logic is unit-testable and `route.ts` exports
only `POST`.

```ts
export async function handleResendWebhook(req: NextRequest): Promise<Response>;
```

Order of operations — this order is load-bearing:

1. `const rawBody = await req.text();` — the raw bytes are what the signature covers.
   **Never call `req.json()` before verification.**
2. `verifyResendWebhook(rawBody, req.headers)` inside try/catch:
   - throws → `fail("Internal error", ErrorCode.INTERNAL, 500)`
   - `false` → `fail("Invalid webhook signature", ErrorCode.UNAUTHENTICATED, 401)`
     and no further processing
3. `JSON.parse(rawBody)`. If it throws, or the payload is not an object, or `type` is not a
   non-empty string, or `data.email_id` is not a non-empty string →
   `fail("Invalid webhook payload", ErrorCode.VALIDATION_FAILED, 400)`.
4. `const status = mapResendEventToStatus(type) ?? "ignored";`
5. `console.info("resend webhook", { type, emailId, status });` — event type, `email_id` and
   status only. Never log recipient addresses or the payload.
6. `return ok({ received: true, emailId, status });` (200)

Use `ok` / `fail` from `@/lib/api/response` and `ErrorCode` from `@/lib/api/errors`, same as
`app/api/cron/invitation-reminders/route.ts`.

### Edge cases

- Unknown/future Resend event type → **200** with `status: "ignored"`, never 4xx (a 4xx
  triggers provider retry storms).
- Missing svix headers → 401, not 500.
- Duplicate deliveries of the same event → same 200 response; the handler has no side
  effects beyond logging, so it is naturally idempotent.
- The response body must never echo the payload or a recipient address.

## 5. `app/api/webhooks/resend/route.ts` (MODIFY)

Reduce to a delegation shim; drop the `notImplemented` import.

```ts
import { NextRequest } from "next/server";
import { handleResendWebhook } from "./handler";

export async function POST(req: NextRequest): Promise<Response> {
  return handleResendWebhook(req);
}
```

Export nothing else from this file.

---

## 6. `.env.example` (MODIFY)

Under the existing `# Resend (Email)` block, after `RESEND_WEBHOOK_SECRET=`, add:

```
RESEND_FROM_EMAIL=
```

Placeholder only — no value, per the file's header comment.

## 7. `documentation/staging-environment.md` (MODIFY)

In the env-var table (the `| Resend | ...` row, ~line 61), add `RESEND_FROM_EMAIL` to the
variable list for that row. Change nothing else in that file.

---

## Tests to write

Mirror `tests/unit/lib/r2/client.test.ts` for env-var/singleton testing (`clearEnv` /
`setValidEnv` helpers + `jest.isolateModulesAsync` re-import) and
`tests/unit/app/api/cron-invitation-reminders-route.test.ts` for route mocking + the fake
`NextRequest` object. Mock `resend` and `svix` with `jest.mock` — **no network calls.**

- `tests/unit/lib/resend/templates.test.ts`: all 7 keys produce the exact PRD subject +
  preview; preheader div present; HTML escaping of a name containing `<script>` and `&`;
  `text` unescaped; `invitation_denied` with `reason: null` and with `"   "`;
  `invitation_reminder_admin` with an empty `memberNames` throws; `practice_reminder`
  without `link` omits the `<a>` and the URL line; unknown key throws.
- `tests/unit/lib/resend/client.test.ts`: happy path returns `{ id }` and passes
  `from`/`to`/`subject`/`html`/`text`; missing `RESEND_API_KEY` throws without calling the
  SDK; missing `RESEND_FROM_EMAIL` throws without calling the SDK; empty-string env var
  throws; empty `to` throws; `{ error }` response throws; client constructed once across
  two sends; `mapResendEventToStatus` for each known type and for an unknown type.
- `tests/unit/lib/api/webhook-verify-resend.test.ts`: valid signature → `true`; svix
  `verify` throwing → `false`; each missing svix header → `false`; missing/empty
  `RESEND_WEBHOOK_SECRET` → rejects.
- `tests/unit/app/api/webhooks-resend-route.test.ts`: valid signed `email.delivered` → 200
  with `{ received: true, emailId, status: "delivered" }`; bad signature → 401 +
  `UNAUTHENTICATED` and `JSON.parse` never reached; verify-throws → 500 + `INTERNAL`;
  malformed JSON body → 400 + `VALIDATION_FAILED`; missing `data.email_id` → 400; unknown
  event type → 200 with `status: "ignored"`; `req.text()` is used (not `req.json()`).

## Verification

Run from the repo root, in order: `bun install`, `bun run lint`, `bun run typecheck`,
`bun run test`. Bun only — never npm/npx/yarn/pnpm.
