# Review — Issue #51: Invitation state machine unit tests

## VERDICT: SHIP

## What I verified (firsthand, not from the summaries)

- `git diff main...HEAD --stat`: only 4 files touched — the new module
  (`lib/invitations/state-machine.ts`), the new test
  (`tests/unit/lib/invitations/state-machine.test.ts`), and the two pipeline
  docs (`.pipeline/spec.md`, `.pipeline/changes.md`). No stray changes.
- `git diff main...HEAD -- app/api/invitations/handler.ts supabase/` is empty:
  the scope boundary the spec set (no refactor of the route handler or the
  `accept_invitation` RPC) is genuinely honored, not just claimed.
- Read the module source: `canTransition` and `applyTransition` are both backed
  by one shared `TRANSITIONS` table, so they cannot drift apart. Only `pending`
  has outgoing edges; the other four statuses map to `{}` (terminal).
  `applyTransition` throws `InvalidInvitationTransitionError` on every illegal
  cell and never returns the unchanged `from` — the exact silent-failure mode
  AC2 forbids is closed. Both error classes set a stable `.name` and carry
  context (`.from`/`.action`, `.priorDenialCount`).
- BR-08 boundary: module uses `priorDenialCount < MAX_DENIALS_PER_WEEK` (cap 3),
  and `handler.ts:101` uses `(deniedForWeek ?? []).length >= 3`. These agree —
  no off-by-one.
- Read the test: the exhaustive 5×4 loop builds `legalPairs` from the 4
  `pending:*` combos and asserts the other 16 throw — not vacuous. Boundary
  tests are driven by the exported `MAX_DENIALS_PER_WEEK` constant, not a magic
  literal. A runtime-unknown-action cast case is covered.
- Ran the tools myself: `bun run typecheck` clean; the new suite passes 21/21.

## Judgment on correctness (green tests != correct)

The module is the canonical, throw-on-invalid state machine the issue asked for,
implemented in isolation and tested exhaustively. Signatures match the spec
verbatim. The tester's mutation check (flipping `<` to `<=`) failing 2 tests is
consistent with what I traced by hand. Domain union is imported from
`types/domain.ts`, not redeclared.

## Notes (non-blocking, for the human)

- The module is intentionally NOT wired into `handler.ts` or the SQL RPC, per
  the spec's explicit scope guard. That means the canonical machine and the two
  inline implementations can still diverge in the future; converging them is a
  deliberate follow-up, not part of this issue.

No changes required. Ship it.
