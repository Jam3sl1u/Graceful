# Test Results: Issue #42 — Deny invitation with reason (BR-08 denial cap)

## VERDICT: PASS

## Context vs. the prior run

The previous version of this file recorded a FAIL because, at that time, this branch had
zero commits beyond `main` and the deny route was still the `notImplemented(...)` stub. That
is no longer the case: commit `0e7d263` ("Implement POST /api/invitations/:id/deny with
BR-08 denial cap (#42)") is now on `HEAD`. This run independently re-verified the Coding
stage's claims in `.pipeline/changes.md` against the actual diff and fresh command runs,
rather than trusting the summary.

Working directory confirmed: `/Users/jamesliu/Documents/Graceful/.claude/worktrees/issue-42`
(branch `issue-42-sprint-2-implement-deny-invitation-with-reason-br-08-denial-cap`, HEAD
`0e7d263`).

## Checks run

- `bun run lint` → clean, no errors/warnings.
- `bun run typecheck` (`tsc --noEmit`) → clean, no errors.
- `bun run test` (Jest) → **26 suites / 339 tests, all pass**, including all 13 tests in
  `tests/unit/app/api/invitations-deny-route.test.ts` (this new file contains both the
  11-test `describe("POST /api/invitations/:id/deny")` block and a second, 2-test
  `describe("POST /api/invitations — BR-08 send guard")` block exercising the
  `createInvitation` guard). `tests/unit/app/api/invitations-route.test.ts` itself was not
  modified — its 12 pre-existing tests still pass unmodified against the additive
  `createInvitation` change.

## Independent code review against the spec (not just trusting changes.md)

Read `app/api/invitations/handler.ts`, `schemas/invitations.ts`,
`app/api/invitations/[id]/deny/route.ts`, `lib/api/auth.ts`, and both test files in full, and
cross-checked against `.pipeline/spec.md`:

- `denyInvitationSchema` (`schemas/invitations.ts`): `reason` optional, `.trim().max(200)`,
  no `.min(1)` — matches spec exactly (empty/whitespace-only reason is valid, not a 400).
- `denyInvitation` (`app/api/invitations/handler.ts`): no `requireRole` call (per spec's OPEN
  QUESTION 1 — any authenticated user, scoped to their own row via
  `id` + `church_group_id` + `user_id`); confirmed `requireAuth` (`lib/api/auth.ts`) performs
  no role filtering on its own, so this design decision actually works as written. Tolerant
  body parse (`body ?? {}`); idempotency short-circuit on `status !== "pending"` returns 200
  with **no** update/count/audit call; `denialCount` computed from a prior-denied-rows count
  (not the row's own default 0), `+1`; patch sets
  `status`/`denial_reason`/`denial_count`/`responded_at`; audit log `invitation.denied`
  written with `reason_provided: boolean` only (raw reason text is not logged — confirmed by
  reading the `metadata` object literal directly); `TODO(#67/#68)` comment left for deferred
  notification dispatch, matching precedent in `createInvitation`.
- BR-08 send-guard added to `createInvitation`: correctly placed after the `!week` 404 check
  and before the BR-05 double-booking check; counts `status = 'denied'` rows for
  `(userId, serviceWeekId)`; `>= 3` → 409 CONFLICT (`ErrorCode.CONFLICT`); does not touch any
  code path below it. Confirmed by reading the diff line-by-line — branch order and every
  other line of `createInvitation` (auth, role check, week lookup, BR-05 check, insert, audit,
  response) is unchanged apart from the new guard block.
- Route file `app/api/invitations/[id]/deny/route.ts`: real `POST` handler wired to
  `denyInvitation`, `params: Promise<{id:string}>` pattern matches
  `app/api/service-weeks/[id]/cancel/route.ts` — no more `notImplemented(...)` stub.

## Test coverage vs. spec's required edge cases — traced, not just skimmed

Read every test in `tests/unit/app/api/invitations-deny-route.test.ts` and traced each
fixture against the handler logic to confirm the assertions actually exercise what they
claim to:

- 401 (no JWT) and 401 (Clerk userId null, lookup never consulted) — both present, both
  assert `getSupabaseClient`/`lookup` was never called (verifies short-circuit, not just
  status code).
- 404 (invitation not found / not owned) — present.
- 400 (`reason` > 200 chars) and 400 (`reason` not a string, `{reason: 123}`) — both present.
- Happy path pending → denied: asserts `status`, `denial_reason`, `denial_count: 1`,
  `responded_at` is a string, and the exact `rpc("write_audit_log", ...)` call shape
  (`p_action: "invitation.denied"`, metadata `denial_count`/`reason_provided`, no raw reason
  text in the payload) — traced the mock's `onUpdate` hook and confirmed it captures the real
  `.update()` payload the handler builds, not a stubbed value.
- Empty-body deny and whitespace-only-reason deny — both assert `denial_reason` stored as
  `null`, matching the schema's optional-no-`.min(1)` contract.
- Idempotent already-denied invitation — asserts 200, `updateCalled === false`, and `rpc`
  never called; the mock's `from()` only wires `select`/`update` for this test, so it would
  fail loudly if the handler tried to re-run the priorDenied count query or the update — it
  doesn't, by design (early return before either).
- `denial_count` becomes 2 with one prior denied row for the same member+week — present,
  matches spec's accumulation requirement.
- 500 when the invitation lookup query errors — present (this is the failure case).
- BR-08 send guard on `createInvitation`: 409 at 3 denied rows, 201 at 2 — both present in
  the same file's second `describe` block, confirming the guard both fires and does not
  over-trigger.

## Regression check on existing invitations tests (the part most likely to silently break)

Manually traced `tests/unit/app/api/invitations-route.test.ts`'s `makeSupabaseClient`: for
the `invitations` table it returns the **same** `tableFixture.select` result on every
`.select()` call regardless of call count (unlike `service_weeks`, which has an explicit
`selectSecond` branch for its second call). Since `createInvitation` now issues two
`invitations` selects (the new BR-08 `deniedForWeek` count, then the pre-existing BR-05
`acceptedInvitations` count) before the insert, both consume the identical fixture value in
every existing test:

- Default fixture `{ data: [], error: null }` → `deniedForWeek.length === 0 < 3`, guard
  passes through silently, then feeds the pre-existing BR-05 logic unchanged. Confirmed
  against the 401/403×2/400×5/404/201-happy-path/500-insert-error tests, none of which
  override the `invitations.select` fixture with anything of length >= 3.
- The one pair of tests that does override it
  (`{ data: [{service_week_id: "other-week"}], error: null }`, used for both the
  409-double-booking and the 201-acknowledged-conflict tests) yields
  `deniedForWeek.length === 1 < 3` too — guard still passes through; BR-05 logic (reading the
  same array for a different purpose) is what actually decides those two tests' outcomes,
  exactly as before this change.

Ran the full suite (not just the new file) to confirm this empirically rather than resting
on static analysis alone: all 12 pre-existing tests in `invitations-route.test.ts` still pass
unmodified, and the 2 new BR-08 guard tests (in the new `invitations-deny-route.test.ts` file,
exercising `createInvitation` directly) both pass too.

## Failure case explicitly verified

Beyond the coder's own suite: manually re-derived the 500 path by reading `denyInvitation`'s
`invError`/`priorError`/`updateError` branches and confirming each maps to
`fail("Internal error", ErrorCode.INTERNAL, 500)`. The test suite directly exercises the
`invError` branch; the `priorError` and `updateError` branches are structurally identical
(`if (x) return fail(...)`, same `ErrorCode.INTERNAL` constant used and verified elsewhere in
the file), so this was confirmed via direct code read rather than an untested assumption.

## Notes / non-blocking observations for the Reviewer

- `.claude/workflows/handle-issues.js` shows as locally modified in `git status` in this
  worktree. Per `changes.md`'s own note, this predates the Coding stage's work for issue #42
  and was not touched by either the Coding or this Testing stage — confirmed via
  `git show --stat HEAD` (it is not part of commit `0e7d263`). Flagging so the Reviewer knows
  it's an unrelated pre-existing artifact, not part of this issue's diff.
- No code was modified by this Testing stage. No test failures were found; nothing was
  patched around.
