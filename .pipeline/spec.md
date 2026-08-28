# Spec — Harden Resend webhook and email dispatch

## OPEN QUESTIONS

None. The requested behavior is decision-complete.

## Scope

Harden the existing #68 Resend implementation without changing public
`sendEmail` types, adding dependencies, migrations, database writes, or other
webhook providers.

## Required behavior

- Preserve `req.text()` -> signature verification -> `JSON.parse` ordering.
- After parsing and validating a non-empty event `type`, immediately
  acknowledge non-`email.*` Resend events with 200
  `{ received: true, status: "ignored" }`. Do not require `data.email_id`, map
  a delivery status, or log these events.
- Retain 400 validation for malformed `email.*` payloads, including a missing
  or empty `data.email_id`. Known email delivery events retain their mapped
  status; unknown email events remain 200/`ignored`.
- Continue structured info logs for non-engagement email statuses only. Never
  log raw payloads or recipient data; do not log `opened` or `clicked` events.
- Keep the lazy Resend singleton, but retain the validated `RESEND_FROM_EMAIL`
  alongside it and use that retained value on every send.
- Render links only when omitted as `undefined` (the optional practice
  reminder link) or when they are non-empty absolute HTTPS URLs. Reject
  relative, malformed, whitespace-padded, empty, HTTP, and other-scheme links
  with `Email template link must be an absolute HTTPS URL`. Keep existing HTML
  escaping and template text otherwise unchanged.
- Mark `tests/unit/lib/resend/client.test.ts` as a TypeScript module with
  `export {};`.

## Files and verification

- Modify `app/api/webhooks/resend/handler.ts`, `lib/resend/client.ts`, and
  `lib/resend/templates.ts`.
- Extend their existing unit and supplement tests for every hardened behavior.
- Run focused Resend tests, then `bun run lint`, `bun run typecheck`, and the
  full `bun run test` suite. Record outcomes in `.pipeline/test-results.md` and
  independently review the final diff in `.pipeline/review.md`.
