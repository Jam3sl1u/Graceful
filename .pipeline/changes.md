# Changes — Harden Resend webhook and email dispatch

## Summary

Hardened the #68 Resend integration against irrelevant webhook retries,
high-volume engagement logging, mutable sender configuration, and unsafe email
link schemes. No dependencies, migrations, or database behavior changed.

## Implementation

- **Webhook handler**: validates `type` after signature verification and JSON
  parsing, then acknowledges non-email events as 200/`ignored` without
  `email_id`, delivery-status mapping, or logging. `email.*` events still
  require `data.email_id`; delivery logs exclude `opened` and `clicked`.
- **Resend client**: stores the validated client and sender address together in
  the lazy singleton; sends no longer reread `RESEND_FROM_EMAIL` or use a
  non-null assertion.
- **Email templates**: validate supplied links as non-empty, unpadded,
  absolute HTTPS URLs before inserting them in HTML or text. The optional
  practice-reminder link remains omittable only as `undefined`.
- **Tests**: added explicit TypeScript module scoping to `client.test.ts` and
  coverage for captured sender values, invalid/valid links, non-email event
  acknowledgement, and suppressed engagement logs.

## Verification

- Focused Resend coverage: 5 suites / 55 tests passed.
- `bun run lint`: exit 0 with one existing generated-coverage warning.
- `bun run typecheck`: passed after clearing stale generated `.next` types.
- Full `bun run test`: 88 suites / 1,106 tests passed.
