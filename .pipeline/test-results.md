# Test Results — Issue #47: Conflict resolution flow (3 paths, manual-only)

## Verdict: PASS

This file overwrites the stale #46 test-results.md that was still sitting at
this path, per the pipeline contract (each run overwrites `.pipeline/*`, which
reflects only the most recent run).

All checks pass. No regressions. New tests were written independently and
verify the handler's actual behavior (request/response shape, which tables
are/aren't written, status codes) rather than trusting `changes.md`'s claims.

## What was added

Two new unit test files (Jest), mirroring the existing mock style of
`tests/unit/app/api/invitations-withdraw-route.test.ts` (`makeReq`/
`makeLookup`/`setUpAuth`, chainable Supabase mock), extended per the coder's
own "Testing-stage focus" note in `changes.md` to add `.is(...)` support (for
`resolved_at IS NULL`) and a `.delete()` chain (for the `event_attendees`
cleanup) — neither of which the existing shared mock supported.

- `tests/unit/app/api/conflicts-route.test.ts` (7 tests) — `GET /api/conflicts`
  (`getOpenConflicts`):
  - 403 FORBIDDEN for `member` role; 401 UNAUTHENTICATED when no JWT.
  - Happy path: one open conflict correctly joined with invitation/user/
    service-week data into the exact `OpenConflict` shape from the spec.
  - Empty list → `{ conflicts: [] }`.
  - Missing joined invitation row → conflict is NOT dropped, safe fallbacks
    used (`memberId`/`memberName`/`serviceWeekId`/`serviceDate` → `""`,
    `invitationStatus` → `"withdrawn"`).
  - 500 INTERNAL when the `conflicts` query errors.
  - 500 INTERNAL when a joined query (`invitations`) errors.

- `tests/unit/app/api/conflicts-resolve-route.test.ts` (14 tests) —
  `POST /api/conflicts/:id/resolve` (`resolveConflict`):
  - 403 FORBIDDEN for `member`; 400 VALIDATION_FAILED for an invalid
    `resolution` value and for an unparseable/missing body; 401
    UNAUTHENTICATED when no JWT; 404 NOT_FOUND for an unknown/wrong-group
    conflict id; 409 CONFLICT (no side effects — asserted via a spy that the
    update mock is never called) for an already-resolved conflict; 500
    INTERNAL when the conflict lookup query errors.
  - `withdraw` happy path: invitation flipped to `status: "withdrawn"`,
    `event_attendees.delete()` called with `in("event_id", [...])` +
    `eq("user_id", memberId)` scoped to the week's events, `notifications`
    insert with `type: "invitation_withdrawn"` and the right shape, conflict
    row updated with `resolution_type: "withdrawn"` + `resolved_at`, and the
    `write_audit_log` RPC called with `p_action: "conflict.resolved"` and the
    right metadata.
  - `withdraw` edge case: service week has zero `events` rows → the
    `event_attendees` delete is skipped entirely (asserted the delete mock is
    never invoked), request still succeeds (200).
  - `withdraw` edge case: invitation already `denied` → no 409, proceeds and
    resolves the conflict (only the conflict's own `resolved_at` guards
    re-resolution, per spec edge case 7).
  - `withdraw` failure case: underlying invitation missing → 404.
  - `withdraw` failure case: notification insert errors → 500 INTERNAL.
  - `member_reconfirmed` and `admin_dismissed`: each resolves the conflict
    with the correct `resolution_type`, asserted to make **no** `invitations`
    update and **no** `event_attendees` delete call at all.

## Commands re-run independently in this worktree

- `bun run test -- conflicts` → **PASS** — 2 suites, 21 tests, all passing.
- `bun run typecheck` (`tsc --noEmit`) → **PASS** — no errors.
- `bun run lint` (`eslint .`) → **PASS** — no errors/warnings.
- `bun run test` (full suite) → **PASS** — 34 suites / 409 tests, all passing
  (the prior 32 suites / 388 tests reported in `changes.md`, plus these 2 new
  files / 21 new tests; no regressions elsewhere).

## Independent code review performed (not just changes.md's description)

- `app/api/conflicts/handler.ts` — read in full. Confirmed `getOpenConflicts`
  and `resolveConflict` match the spec's field-by-field contract: role gate
  (`admin`/`set_leader` only), 401-on-missing-JWT pattern, the multi-query
  in-memory join (conflicts → invitations → users/service_weeks) with the
  documented safe fallbacks, the idempotency guard ordering (`resolved_at`
  check strictly before any write), the `withdraw` branch's event-lookup →
  conditional delete → notify sequence, and that `conflicts.resolved_at`/
  `resolution_type` are written LAST so a mid-operation failure leaves the
  conflict retryable. `replacement_suggestion_user_id` is never referenced
  anywhere in the file, confirming the spec's "manual-only, no AI path"
  constraint held.
- `types/domain.ts` — `ResolutionType` now reads `"replaced" | "withdrawn" |
  "member_reconfirmed" | "admin_dismissed"`, matching the DB enum exactly as
  the spec required.
- `schemas/conflicts.ts` — `resolveConflictSchema` matches the spec's zod
  snippet verbatim (`withdraw` / `member_reconfirmed` / `admin_dismissed`).
- `lib/supabase/types.ts` — `events`/`event_attendees` table entries added
  with `Relationships: []`, consistent with the rest of this hand-rolled file
  and required for the withdraw path's queries to typecheck.
- `app/api/conflicts/route.ts` and `app/api/conflicts/[id]/resolve/route.ts` —
  both stubs replaced exactly as specified; `resolve/route.ts`'s `{ params }`
  handling mirrors `app/api/invitations/[id]/route.ts`.

## Coverage against the spec's named edge cases

All edge cases in `.pipeline/spec.md` ("Edge cases the implementation must
handle", items 1–10) are exercised:

1. Non-existent/wrong-group conflict id → 404 — covered directly on resolve;
   GET's "missing joined row" test covers the defensive-fallback variant.
2. Already-resolved conflict → 409, no side effects — covered, with an
   explicit assertion that no update call happens.
3. Invalid/missing `resolution` → 400 — covered (invalid enum value + null
   body).
4. `member` role → 403 on both GET and resolve — covered on both.
5. Missing Supabase JWT → 401 on both — covered on both.
6. Withdraw with zero `events` for the week → no-op delete, still 200 —
   covered.
7. Withdraw where invitation already `denied` → no 409, proceeds — covered.
8. `member_reconfirmed`/`admin_dismissed` must not touch `invitations`/
   `event_attendees` — covered with explicit negative assertions.
9. GET with no open conflicts → `{ conflicts: [] }` — covered.
10. Any DB `.error` → 500 INTERNAL, never partial success — covered for the
    conflicts query, a joined query (GET), the conflict lookup (resolve), and
    the notification insert (withdraw).

## Out of scope, confirmed untouched

- No new SQL migration/RPC added (grep of `supabase/migrations/` shows no new
  file for this issue; the handler does all writes as a plain RLS-scoped
  route, per spec's "Why no RPC" section).
- No Google Calendar integration — only the `TODO(#62)` comment is present,
  per spec's explicit instruction.
- No new replacement-suggestion endpoint — `app/api/conflicts/` contains only
  the two routes named in the spec.

## Not independently verifiable in this environment

- Live RLS enforcement (`conflicts_select_leader_admin`,
  `conflicts_update_leader_admin`, `event_attendees_delete_tenant`, etc.) is
  not exercised — this repo has no live-DB test harness for RLS policies,
  consistent with sibling handlers (`withdrawInvitation`, `getChurchGroupMembers`).
  Verified instead by re-reading the cited RLS migration
  (`20260704000001_rls_policies.sql`) and confirming the policy names/scopes
  the spec claims actually exist there.

## Failure cases

None. No test failures encountered in this run. All 21 new tests, plus the
full pre-existing 388-test suite, pass. Lint and typecheck are both clean.
