# Review — Harden Resend webhook and email dispatch

## Verdict: SHIP

Reviewed `.pipeline/spec.md`, `.pipeline/changes.md`, and the final source and
test diff. The implementation satisfies every requested hardening behavior.

## Findings

- The webhook still reads raw text before verification and parses JSON only
  after signature verification succeeds.
- A validated non-email event returns 200/`ignored` before `email_id` access,
  delivery-status mapping, or logging. Malformed `email.*` events retain 400
  validation; unknown email types retain the prior 200/`ignored` behavior.
- `opened` and `clicked` are the only mapped statuses excluded from
  `console.info`; retained logs contain only type, email ID, and status.
- The Resend singleton now retains the exact sender value it validated. No
  public API changes or per-send non-null environment assertions remain.
- The local template validator rejects missing-required, malformed, relative,
  HTTP, non-HTTPS, and whitespace-padded links before either HTML or text is
  rendered. Existing escaping remains in place after validation.
- Tests directly cover the new branches and a post-construction sender
  environment mutation. `client.test.ts` is now module-scoped.
- No dependency, lockfile, migration, database, or unrelated-provider changes
  are present. `git diff --check` passes.

## Verification

- Focused Resend coverage: 5 suites / 55 tests passed.
- `bun run lint`: exit 0, with only an existing generated-coverage warning.
- `bun run typecheck`: passed after clearing stale generated `.next` types.
- Full `bun run test`: 88 suites / 1,106 tests passed.
