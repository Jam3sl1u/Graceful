# Test Results — Issue #51: Invitation state machine unit tests

## Verdict: PASS

This overwrites the stale `test-results.md` for issue #46 that was still
sitting at this path (per AGENTS.md, `.pipeline/` files reflect only the most
recent run).

## Commands re-run independently in this worktree

- `bun run typecheck` — clean, no errors.
- `bun run lint` — clean, no errors/warnings.
- `bun run test` (Jest, full suite) — **33 test suites, 409 tests, all
  passing.**
- Re-ran just the new file in isolation
  (`tests/unit/lib/invitations/state-machine.test.ts`) — 21/21 passing.

## Independent verification performed

1. **Domain type source of truth**: confirmed `types/domain.ts:6` declares
   `InvitationStatus = "pending" | "accepted" | "denied" | "withdrawn" |
   "expired"`, and `lib/invitations/state-machine.ts` imports it rather than
   redeclaring the union, as the spec required.

2. **Shared source of truth for `canTransition`/`applyTransition`**: both
   functions read from the same `TRANSITIONS` lookup table in
   `lib/invitations/state-machine.ts` (a
   `Record<InvitationStatus, Partial<Record<InvitationAction,
   InvitationStatus>>>`), so they cannot be made to disagree independently.
   Only `pending` has non-empty outgoing entries; the other four statuses map
   to `{}`, correctly making them terminal.

3. **Exhaustive 5×4 matrix test is not vacuous**: read
   `tests/unit/lib/invitations/state-machine.test.ts` lines 98-115. It builds
   `legalPairs` from all 4 `pending:*` combinations, then loops all 5
   statuses x 4 actions (20 pairs total), asserting `canTransition` and
   `applyTransition` agree with set membership. Traced by hand: 4 legal +
   16 illegal = 20, matching "5 statuses x 4 actions" exactly — no pair is
   skipped or duplicated.

4. **Scope boundary honored**: `git show --stat HEAD` (commit `30a1db3`,
   "Add invitation state-machine module and exhaustive unit tests (#51)")
   touches only `.pipeline/changes.md`, `.pipeline/spec.md`,
   `lib/invitations/state-machine.ts`, and
   `tests/unit/lib/invitations/state-machine.test.ts`. Confirmed via `grep`
   that `app/api/invitations/handler.ts` is untouched and still carries its
   own inline guards (`status !== "pending"` at lines 239 and 334,
   `(deniedForWeek ?? []).length >= 3` at line 101) — the new module is
   additive only, not wired in anywhere. The three route tests named in
   `changes.md` (`invitations-deny-route.test.ts`,
   `invitations-withdraw-route.test.ts`, `invitations-accept-route.test.ts`)
   all still pass unchanged in the full suite run above. The `accept_invitation`
   SQL RPC migration is untouched (no new/modified migration file in the diff).

5. **BR-08 boundary matches `handler.ts`**: `handler.ts:101` uses
   `(deniedForWeek ?? []).length >= 3`; `state-machine.ts`'s
   `canInvite`/`assertCanInvite` use the equivalent `< MAX_DENIALS_PER_WEEK`
   / cap-at-3 semantics (cap reached exactly at 3, not 4 — confirmed by
   reading the source, not just trusting the test names).

6. **Mutation check (regression-catching sanity, not part of the shipped
   diff)**: temporarily changed `canInvite`'s comparison from
   `< MAX_DENIALS_PER_WEEK` to `<= MAX_DENIALS_PER_WEEK` (an intentional
   off-by-one bug) and re-ran the state-machine test file in isolation.
   Result: 2 of 21 tests failed exactly as expected — "blocks invites once
   the cap is reached" and the `assertCanInvite` throw-at-cap test — proving
   the boundary tests are not vacuous and would catch a real regression.
   Reverted immediately afterward; `git status`/`git diff --stat` confirmed
   the working tree was byte-identical to the committed state (clean, zero
   diff) before this report was written.

## Failure cases covered

- `expect(() => applyTransition("pending", bogusAction)).toThrow(...)` for a
  runtime-unknown action forced past the type system via a cast, proving the
  defensive `undefined` fallthrough in `TRANSITIONS` works and doesn't
  silently no-op or crash uncontrolled.
- All 16 illegal `(status, action)` pairs in the exhaustive matrix are
  themselves failure-case assertions (`toThrow(InvalidInvitationTransitionError)`),
  well beyond the "at least one failure case" requirement.
- `assertCanInvite` throwing `DenialCapReachedError` at/above the cap, with
  `.priorDenialCount` asserted on the caught error.

## Edge cases named in the spec, confirmed covered

- All 4 `pending -> *` valid transitions (accept/deny/withdraw/expire).
- Terminal-source invalid transitions (`accepted->accept`, `denied->accept`,
  `withdrawn->accept`, `expired->accept`, plus `accepted->deny`,
  `accepted->withdraw`).
- Self-loop re-application from a terminal status (`denied->deny`,
  `withdrawn->withdraw`).
- Error carries `.from`/`.action`/`.name` context (not a bare `Error`).
- BR-08 cap boundary at exactly 3 (`canInvite`/`assertCanInvite` for
  0/1/2/3/4), driven by the exported `MAX_DENIALS_PER_WEEK` constant rather
  than a hard-coded literal in the boundary-crossing assertions.

## Conclusion

All of the coder's claims in `.pipeline/changes.md` check out under
independent verification. No discrepancies found. Full suite green (33/33
suites, 409/409 tests), typecheck and lint clean, the issue's scope boundary
(no refactor of `handler.ts`/SQL RPC) was honored, and a deliberate mutation
test confirms the new suite actually catches regressions rather than being
vacuous. Ready for review.
