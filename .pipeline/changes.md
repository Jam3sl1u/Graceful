# Changes — Issue #51: Invitation state machine unit tests

## Summary

There was no isolated, throwing invitation state-machine function in the codebase
(the transition rules lived inline in `app/api/invitations/handler.ts` and in the
`accept_invitation` Postgres RPC). Per the spec's design decision, created a new
pure, DB-free module that is the canonical declaration of the invitation state
machine, then unit-tested it exhaustively. No existing code was refactored to use
it — `handler.ts` and the SQL RPC are untouched and keep their current HTTP
semantics, exactly as scoped.

## Files changed

- **`lib/invitations/state-machine.ts`** (new) — pure logic module, no
  `"server-only"` import (isomorphic, unlike `lib/scheduling/conflict-detection.ts`
  which it otherwise mirrors in style). Exports:
  - `InvitationAction` type (`"accept" | "deny" | "withdraw" | "expire"`)
  - `MAX_DENIALS_PER_WEEK = 3` (BR-08)
  - `InvalidInvitationTransitionError` (carries `.from`/`.action`, `.name` set to
    `"InvalidInvitationTransitionError"`)
  - `DenialCapReachedError` (carries `.priorDenialCount`, `.name` set to
    `"DenialCapReachedError"`)
  - `canTransition(from, action)` / `applyTransition(from, action)` — both backed
    by one shared `TRANSITIONS` lookup table so they can never disagree. Only
    `pending` has legal outgoing actions (→ `accepted`/`denied`/`withdrawn`/
    `expired`); every other status is terminal. Unknown/runtime-invalid actions
    fall through to the `undefined` branch and are treated as invalid (no crash,
    no silent success). `applyTransition` never returns the unchanged `from`
    status — every illegal transition throws `InvalidInvitationTransitionError`.
  - `canInvite(priorDenialCount)` / `assertCanInvite(priorDenialCount)` — BR-08
    gate, cap boundary at `>= 3`, matching `handler.ts`'s existing
    `(deniedForWeek ?? []).length >= 3` check.

- **`tests/unit/lib/invitations/state-machine.test.ts`** (new) — 21 tests,
  mirroring the style of `tests/unit/lib/scheduling/conflict-detection.test.ts`
  (plain `describe`/`it`, no mocks needed since this is pure logic):
  - Valid transitions: all 4 `pending → *` cases (accept/deny/withdraw/expire).
  - Invalid transitions: the issue's named cases (`accepted→accept`,
    `denied→accept`, `withdrawn→accept`, `expired→accept`) plus terminal-source
    coverage (`accepted→deny`, `accepted→withdraw`) and self-loop re-application
    (`denied→deny`, `withdrawn→withdraw`).
  - One test asserts the thrown error's `.name`/`.from`/`.action` explicitly.
  - One test covers a runtime-unknown action forced past the type system via a
    cast, asserting it's treated as an invalid transition (not a crash, not a
    silent success).
  - One exhaustive test iterates all 5 statuses × 4 actions (20 pairs) and
    asserts exactly the 4 `pending→*` pairs are legal, the other 16 throw
    `InvalidInvitationTransitionError`.
  - BR-08 cap tests: `canInvite(0/1/2)` → true, `canInvite(3/4)` → false;
    `assertCanInvite` non-throwing below cap, throwing `DenialCapReachedError`
    (asserting `.priorDenialCount`) at/above cap; asserts `MAX_DENIALS_PER_WEEK
    === 3` rather than hard-coding the literal in the boundary tests.

- **`.pipeline/spec.md`** — committed the current run's issue #51 spec (the copy
  on disk at HEAD on this branch was a stale #46 spec left over from this
  branch's prior use; the planner's #51 spec was present but uncommitted in the
  working tree at the start of this stage).

## Verification performed

- `bun run typecheck` — passes, no errors.
- `bun run lint` — passes, no errors/warnings.
- `bun run test` — full suite: 33 test suites, 409 tests, all passing (includes
  the 21 new tests). No existing tests were touched or broken.

## What the Tester should focus on

- Confirm the exhaustive 5×4 matrix test genuinely covers all pairs (no typo
  causing a false negative to be silently skipped).
- Confirm `applyTransition`/`canTransition` truly share one lookup table
  (`TRANSITIONS` in `lib/invitations/state-machine.ts`) so they can't
  independently be made to disagree.
- Confirm this issue's explicit scope boundary was honored: `handler.ts` and the
  `accept_invitation` SQL RPC are unmodified (no refactor to call the new
  module), and their existing route tests
  (`invitations-deny-route.test.ts`, `invitations-withdraw-route.test.ts`,
  `invitations-accept-route.test.ts`) still pass unchanged.
- Confirm the denial-cap boundary (`>= 3`, not `> 3`) matches
  `app/api/invitations/handler.ts`'s existing BR-08 check.
