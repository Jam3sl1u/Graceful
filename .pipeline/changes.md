# Changes — Make the Resend branch merge-ready

## Summary

Merged current `main` into issue #68 and resolved the shared-verifier conflict
without regressing the completed Pingram integration. Addressed all four
review findings.

## Implementation

- `lib/api/webhook-verify.ts` now retains both `crypto` HMAC imports for
  Pingram and Svix's `Webhook` import for Resend, with real verifier bodies
  for both providers and unchanged Clerk/Modal stubs.
- Environment documentation retains Pingram's optional base-URL/sender
  settings and adds Resend's sender setting; `.env.example` contains all
  provider variables.
- `EmailDeliveryStatus` and its mapper now represent `email.failed` as
  `failed`, so the existing handler logs and acknowledges it distinctly.
- Added a no-mock Svix signature suite covering valid, tampered, wrong-secret,
  and stale-timestamp payloads; added a malformed-body/bad-signature route
  case proving verification occurs before parsing.

## Verification

- Focused Resend and Pingram coverage: 9 suites / 61 tests passed.
- `bun run lint`: exit 0 with one existing generated-coverage warning.
- `bun run typecheck`: passed.
- Full `bun run test`: 135 suites / 3,018 tests passed.
