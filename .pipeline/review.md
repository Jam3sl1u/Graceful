# Review — Issue #73: Notification Inbox screen (+ in-app invitation response)

## VERDICT: SHIP

The option-C scope expansion is now explicitly approved and recorded in
`.pipeline/spec.md`: the human operator confirmed it in this conversation on
2026-09-15. The spec marks the question resolved and confines the API exception
to the member-scoped invitation response flow.

## Review findings

- Authenticated `POST /api/invitations/:id/deny` now uses the same compact,
  credential-free response contract as the token path:
  `{ invitationId, status, alreadyResponded }`. A fresh denial returns
  `alreadyResponded: false`; terminal/idempotent responses return `true`.
  Neither path serializes `responseToken` to the in-app browser.
- The in-app invitation response validates its action payload, accepts only
  the requested terminal outcome as success, maps 404 to not-found and 410 to
  expired, and presents a retryable error for malformed or otherwise
  unexpected successful responses. A member declining an already accepted or
  withdrawn invitation no longer receives the false "Response recorded" UI.
- The notification card now uses valid button content: body text is a styled
  block-level `span`, not a paragraph nested inside a button.
- Tests pin the authenticated deny and accept response bodies and feed those
  exact shapes to the client component. The pre-existing six test files are
  tracked in commit `8f1d552`; no untracked-test issue remains.

## Verification

- `bun run lint` — pass
- `bun run typecheck` — pass
- `bun run test` — 153 suites / 3233 tests passed
