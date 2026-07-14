# Spec — Issue #51: Invitation state machine unit tests

## OPEN QUESTIONS

None blocking. See "Design decision" below for the one judgment call made while
planning; it does not require a human to resolve before coding.

## Design decision (read this first)

There is **no isolated invitation state-machine function in the codebase today.**
The transition rules currently live scattered and inline across three places:

- `app/api/invitations/handler.ts` — `denyInvitation` (guards `status !== "pending"`),
  `withdrawInvitation` (guards `status !== "pending"`, returns 409), and the BR-08
  denial-cap check inside `createInvitation` (`deniedForWeek.length >= 3`).
- `supabase/migrations/20260712000001_accept_invitation_rpc.sql` — the accept
  transition and its `status <> 'pending'` guard (in Postgres, not testable in
  isolation without a DB).

The issue explicitly asks to "test the state machine function in isolation" with
invalid transitions that "throw, not silently fail." No such throwing function
exists, so the coder must **create a small pure module that is the canonical
declaration of the invitation state machine**, then unit-test it exhaustively.

Scope guard for the coder:
- **Create** the pure module + its unit test only.
- **Do NOT** refactor `handler.ts` or the SQL RPC to call the new module — that is
  a larger change not requested by this issue. The existing route handlers already
  have their own unit tests (`invitations-deny-route.test.ts`,
  `invitations-withdraw-route.test.ts`, `invitations-accept-route.test.ts`) and
  keep their current (intentionally idempotent/graceful) HTTP semantics unchanged.
- The new module is a standalone, DB-free, canonical spec of the transitions with
  strict throw-on-invalid semantics, exactly as the acceptance criteria require.

## Files to create

### 1. `lib/invitations/state-machine.ts` (new — pure logic module)

Follow the style of `lib/scheduling/conflict-detection.ts` (small, single-purpose,
typed) BUT **do not** import `"server-only"` — this module is pure and isomorphic.
Import the status union from the existing domain types; do not redefine it.

```ts
import type { InvitationStatus } from "@/types/domain";
// InvitationStatus = "pending" | "accepted" | "denied" | "withdrawn" | "expired"

export type InvitationAction = "accept" | "deny" | "withdraw" | "expire";

// BR-08 (PRD §8): a member who has denied this many invitations for a given
// service week cannot be re-invited for it.
export const MAX_DENIALS_PER_WEEK = 3;

export class InvalidInvitationTransitionError extends Error {
  readonly from: InvitationStatus;
  readonly action: InvitationAction;
  constructor(from: InvitationStatus, action: InvitationAction);
}

export class DenialCapReachedError extends Error {
  readonly priorDenialCount: number;
  constructor(priorDenialCount: number);
}

// True iff `action` is legal from status `from`.
export function canTransition(from: InvitationStatus, action: InvitationAction): boolean;

// Returns the resulting status for a legal transition; THROWS
// InvalidInvitationTransitionError for any illegal one. Must never silently
// return the unchanged status.
export function applyTransition(from: InvitationStatus, action: InvitationAction): InvitationStatus;

// BR-08 gate. True iff a member with `priorDenialCount` prior denials for a week
// may still be invited again for that week.
export function canInvite(priorDenialCount: number): boolean;

// BR-08 gate, throwing variant; THROWS DenialCapReachedError when the cap is hit.
export function assertCanInvite(priorDenialCount: number): void;
```

Transition table (the ONLY legal transitions — everything else is invalid):

| from      | accept   | deny   | withdraw  | expire  |
| --------- | -------- | ------ | --------- | ------- |
| pending   | accepted | denied | withdrawn | expired |
| accepted  | —        | —      | —         | —       |
| denied    | —        | —      | —         | —       |
| withdrawn | —        | —      | —         | —       |
| expired   | —        | —      | —         | —       |

`accepted`, `denied`, `withdrawn`, and `expired` are terminal: no action is legal
from them.

Behavior details the coder must implement:
- `applyTransition` on any `—` cell throws `InvalidInvitationTransitionError` with
  `from` and `action` populated; the thrown error must NOT be a plain `Error` with
  no data (tests assert on `.name`/`.from`/`.action`).
- Set a stable, distinct `.name` on each error class (e.g.
  `this.name = "InvalidInvitationTransitionError"`) so tests can assert on it.
- `canTransition` returns `false` for exactly the cells `applyTransition` throws on,
  `true` otherwise. Keep them backed by one shared transition map so they can never
  disagree.
- `canInvite(n)` = `n < MAX_DENIALS_PER_WEEK`. `assertCanInvite(n)` throws
  `DenialCapReachedError` when `n >= MAX_DENIALS_PER_WEEK`, returns `void` otherwise.
- Guard against a runtime-unknown action (defensive default in the lookup) even
  though the type system forbids it — an unknown action is an invalid transition.

## Files to create — tests

### 2. `tests/unit/lib/invitations/state-machine.test.ts` (new)

Mirror the structure/style of `tests/unit/lib/scheduling/conflict-detection.test.ts`
(plain `describe`/`it`, no Supabase mock needed here — this is pure logic). Path
must be under `tests/unit/**` so Jest's `testMatch` (`**/tests/unit/**/*.test.ts`,
see `jest.config.js`) picks it up and CI runs it (see "CI" below).

Required cases (map 1:1 to the acceptance criteria):

Valid transitions (AC 1) — assert `applyTransition` returns the target status AND
`canTransition` returns `true`:
- `pending → accepted` via `accept`
- `pending → denied` via `deny`
- `pending → withdrawn` via `withdraw`
- (also cover `pending → expired` via `expire`, since `expired` is a real
  `InvitationStatus` the machine must handle)

Invalid transitions (AC 2) — assert `applyTransition` THROWS
`InvalidInvitationTransitionError` (use `expect(() => ...).toThrow(InvalidInvitationTransitionError)`)
AND `canTransition` returns `false`. Cover at minimum the issue's named cases plus
representative terminal-source cases:
- `accepted → accepted` (accept)
- `denied → accepted` (accept)
- `withdrawn → accepted` (accept)
- `accepted → deny`, `accepted → withdraw` (terminal source, other actions)
- `denied → deny`, `withdrawn → withdraw` (re-applying the action that reached them)
- `expired → accept`
- Assert the thrown error carries the correct `.from` and `.action` for at least
  one case, proving it fails loudly with context rather than silently.
- Exhaustiveness: iterate every (status, action) pair over all 5 statuses × 4
  actions; assert that exactly the 4 `pending → *` pairs are legal and the other
  16 throw. This guarantees no invalid transition silently succeeds.

BR-08 denial cap (AC 3) — cover explicitly:
- `canInvite(0)`, `canInvite(1)`, `canInvite(2)` → `true`
- `canInvite(3)` → `false` (cap reached at exactly 3)
- `canInvite(4)` → `false`
- `assertCanInvite(2)` does not throw; `assertCanInvite(3)` and `assertCanInvite(4)`
  throw `DenialCapReachedError`; assert the thrown error exposes `priorDenialCount`.
- Assert the boundary is driven by the exported `MAX_DENIALS_PER_WEEK` constant
  (value `3`), not a hard-coded literal in the test.

## Edge cases the implementation must handle

- Terminal → same-action self-loops (e.g. `accepted → accept`) are invalid and throw.
- The denial cap boundary is `>= 3` (three denials already recorded blocks the
  next invite), matching the existing `handler.ts` `createInvitation` check
  (`(deniedForWeek ?? []).length >= 3`). Do not off-by-one this.
- `applyTransition` must never return the unchanged `from` status as a "graceful
  no-op" — that would be the exact silent-failure mode AC 2 forbids. Always throw.
- `canTransition` and `applyTransition` must stay consistent (shared source of truth).

## CI (AC 4) — no config change needed

`.github/workflows/ci.yml` already runs `bun run test:coverage` (`jest --coverage`),
and `jest.config.js` `testMatch` is `**/tests/unit/**/*.test.ts`. A test placed at
`tests/unit/lib/invitations/state-machine.test.ts` is therefore run in CI and
blocks merge on failure automatically. Do **not** edit CI config, `jest.config.js`,
or `package.json`.

## Patterns to copy

- Pure single-purpose module shape: `lib/scheduling/conflict-detection.ts`
  (but omit the `"server-only"` import — this module is pure).
- Unit-test file shape/location/naming: `tests/unit/lib/scheduling/conflict-detection.test.ts`.
- Throw-assertion style: `expect(() => ...).toThrow(ErrorClass)` as used in that
  test file's style.
- Domain enum source of truth: `types/domain.ts` (`InvitationStatus`). Do not
  redeclare the status strings.

## Verification before finishing (coder)

- `bun run typecheck`
- `bun run lint`
- `bun run test` (Jest; not the bare `bun test` runner)
