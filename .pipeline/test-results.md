# Test Results — Issue #46: Conflict detection on availability change

## Verdict: PASS

All checks re-run independently in the pinned worktree
(`/Users/jamesliu/Documents/Graceful/.claude/worktrees/issue-46`) and
cross-checked against `.pipeline/spec.md` line by line (`app/api/availability/handler.ts`,
the new migration SQL, `lib/scheduling/conflict-detection.ts`, and both test
files). This file overwrites a stale leftover from a prior issue (#44) that
was still sitting at this path.

## Commands re-run

- `bun run lint` — clean, no errors/warnings.
- `bun run typecheck` (`tsc --noEmit`) — clean, no errors.
- `bun run test` (Jest, full suite) — **32 suites / 388 tests passed** (the
  coder's 31 suites / 385 tests, plus this stage's new supplemental file with
  3 additional tests; no failures, no skips).
- `bun run check:workflows` — OK (sanity check per repo convention; no
  workflow scripts touched by this change).

## Independent verification performed

Read the actual diff (not just `changes.md`'s description) for every file listed:

- `app/api/availability/handler.ts` — `setAvailability`'s wiring matches the
  spec exactly: iterates `byDate`, fires `recordAvailabilityConflict(supabase,
  date, "marked_unavailable")` only for `isAvailable === false` entries, after
  the upsert's error check and before building the response body, tracks
  `conflictTriggered`, and returns `ok({ availability, conflictTriggered })`.
  GET, DELETE, validation, expansion, and dedupe logic are byte-for-byte
  unchanged. `deleteAvailability` (#35 DELETE trigger point) is unmodified and
  still wired to the same shared RPC.
- `supabase/migrations/20260713000001_conflict_notification.sql` —
  `CREATE OR REPLACE`s `record_availability_conflict` with the identical
  signature/language/security/guard as the original migration (left
  untouched, confirmed by diff). Verified against the live schema
  (`20260702000005_cluster_5_partial.sql`): `scheduling_conflict` already
  exists in the `notification_type` enum (no new enum value added, per spec),
  `notifications.title` is `varchar(200)` (the literal `'Scheduling conflict'`
  fits comfortably), `link_entity_type` is a free-text `varchar(50)`
  (`'conflict'` is valid). Recipient query correctly filters to
  `admin`/`set_leader` and excludes the triggering user (`id <> v_user_id`).
  `v_reason` is read from the member's own `availability.note` row
  post-upsert (correct for `marked_unavailable`) and is NULL on the
  `availability_deleted` path since the row is already deleted by the time
  the RPC runs — the `CASE WHEN v_reason IS NOT NULL` guard correctly omits
  the reason clause without erroring on NULL. `RETURNING id INTO
  v_conflict_id` and the `-- TODO(#58/#59)` comment are both present. Header
  comment explaining the SECURITY DEFINER rationale and a commented DOWN
  section are present, matching sibling migrations. No live-DB test harness
  exists in this repo for RPC migrations (consistent with `accept_invitation`
  and the original `record_availability_conflict`) — expected per spec, not a
  gap.
- `lib/scheduling/conflict-detection.ts` — unchanged, as spec requires (the
  `ConflictTriggerReason` union already included `"marked_unavailable"`).
- `lib/supabase/types.ts` — confirmed untouched (RPC signature/return type
  unchanged, per spec's explicit instruction not to widen it).
- Response-shape check: grepped the repo for other consumers of `PUT
  /api/availability`'s response body — none found (`app/api/availability/team/handler.ts`
  queries the `availability` table directly for a different GET endpoint,
  unrelated to this response shape). No frontend caller currently depends on
  the response body in this repo's current phase, so the added
  `conflictTriggered` field carries no breakage risk.

## New test file written independently by this stage (Tester)

`tests/unit/app/api/availability-route-tester-supplement.test.ts` (3 tests,
all passing), following the repo's existing "tester-supplement" convention
(see `invitations-withdraw-route-tester-supplement.test.ts`,
`service-weeks-cancel-reactivate-tester-supplement.test.ts`). Closes gaps the
coder's own `availability-route.test.ts` left open:

1. **Failure-case / short-circuit check**: asserts the conflict-detection RPC
   is *never* called when the upsert itself errors (spec: fire conflict
   detection "after the upsert succeeds"). A regression that fired the RPC
   unconditionally, or before checking the upsert error, would still have
   passed the coder's existing test (which only asserts the 500 status, not
   that `rpc` was never called).
2. **Edge case — full multi-day range, all unavailable**: a 3-day range PUT
   with every expanded date set unavailable fires the RPC exactly 3 times,
   once per date, each with `p_trigger_reason: "marked_unavailable"`. The
   coder's own multi-date test only mixed one available + one unavailable
   date, which would not have caught a regression that fires the RPC only for
   the first or last date in the `byDate` iteration.
3. **Ordering contract**: asserts `upsert` is invoked before `rpc` (via
   `mock.invocationCallOrder`), directly verifying the spec's explicit
   ordering requirement — "the upsert writes the is_available:false row (and
   its note) BEFORE the RPC runs, so the RPC can read that note for the
   notification."

All three pass against the current implementation.

## Spec edge cases re-verified as covered

1. Marking available/default-true never triggers RPC — covered (coder's test
   `"marking a date available... does not call the conflict-detection RPC"` +
   this stage's failure-case test). Confirmed.
2. Multi-date PUT, one RPC call per unavailable date — covered (coder's mixed
   available/unavailable test + this stage's all-unavailable 3-day range
   test). Confirmed.
3. No accepted invitation on the date → RPC returns `false`, PUT still
   succeeds with `conflictTriggered: false` — covered (coder's DELETE
   no-invitation test and the PUT default-`rpc` mock behavior). Confirmed.
4. Reason present (marked_unavailable) vs. absent (availability_deleted, NULL
   note) — covered by SQL review of the migration's `CASE WHEN v_reason IS
   NOT NULL` guard; no live-DB harness exists for either trigger path in this
   repo, consistent with sibling RPCs and explicitly out of scope per spec.
5. Multiple accepted invitations on one date — RPC loop is unchanged from
   the original migration (only the notification insert was added inside the
   existing loop); reviewed, no behavior-flow change from this issue.
6. RPC/DB error → 500 `INTERNAL`, never a silent no-op — covered on both PUT
   (coder's `"returns 500 INTERNAL when the conflict-detection RPC returns an
   error"`) and DELETE (pre-existing test, unmodified). Confirmed.
7. Triggering user is themselves leader/admin → excluded via
   `id <> v_user_id` — verified by SQL review; no live-DB harness exists to
   exercise this at the application-test level, consistent with the spec's
   own scoping of RPC verification to review + mocked route tests.
8. Both trigger paths converge on the same RPC (AC3) — verified:
   `deleteAvailability` (unmodified) and `setAvailability` (newly wired) both
   call `recordAvailabilityConflict`, and the migration is the single shared
   RPC implementation backing both `trigger_reason` values.

## Out-of-scope items confirmed untouched

- No `sendSms`/`sendEmail` calls added; `lib/pingram/client.ts` and
  `lib/resend/client.ts` unmodified (confirmed via `git status`/diff).
- `app/api/conflicts/*` (GET/resolve) and `app/(app)/conflicts/page.tsx` not
  present in this diff.
- `lib/supabase/types.ts` unmodified.
- GET `/api/availability`, team availability, and any admin-sets-another-
  member availability path are unmodified.
- No new `notification_type` enum value added (`scheduling_conflict` already
  existed).

## Not independently verifiable in this environment

- The RPC SQL body itself (`record_availability_conflict`) has no live-DB
  test harness in this repo, consistent with `accept_invitation`'s and the
  original migration's precedent, and explicitly out of scope per spec ("do
  not add a live-DB test"). Correctness was checked by direct comparison
  against the spec's required additions, the live table/enum schema
  (`notifications`, `notification_type`), and the established
  `accept_invitation` notify pattern — not by execution against a real
  database.

## Failure cases

None. No test failures encountered in this run — the coder's original 385
tests, and the 3 new independent supplemental tests added by this stage, all
pass. Lint, typecheck, and `check:workflows` are all clean.
