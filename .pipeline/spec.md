# Spec — Make the Resend branch merge-ready

## OPEN QUESTIONS

None. The review findings REV-001 through REV-004 have explicit resolution
criteria.

## Scope

- Merge current `main` into the issue #68 branch with a merge commit.
- Preserve both providers in `lib/api/webhook-verify.ts`: Pingram's HMAC and
  replay checks, plus Resend's Svix verification. Clerk and Modal remain stubs.
- Retain all Pingram and Resend variables in `.env.example` and staging docs.
- Map Resend `email.failed` to the meaningful `failed` delivery status.
- Add real-Svix verification coverage and prove bad signatures short-circuit
  before malformed JSON is parsed.

## Verification

- Confirm the merged verifier exports all four provider functions and contains
  both required provider imports/implementations.
- Run Bun install, focused Resend and Pingram webhook tests, lint, typecheck,
  and the complete Jest suite against main's dependency baseline.
