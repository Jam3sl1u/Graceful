# Test Results — Issue #39: Service week cancel/reactivate (BR-17)

## Verdict: PASS — ready for review.

All coder claims independently reproduced. No implementation failures found.
One coverage gap identified in the coder's own tests was closed with an
additional supplementary test file (all new tests pass, no code changes
made).

## Commands re-run independently

| Command | Result |
|---|---|
| `bun install` | OK — no changes, 727 installs across 774 packages |
| `bun run typecheck` (`tsc --noEmit`) | PASS — no errors |
| `bun run lint` (`eslint .`) | PASS — no errors |
| `bun run test` (`jest`) | PASS — **290 tests, 22 suites** (286/21 from the coder's baseline + 4/1 from my supplementary file) |
| `bun run check:service-role` | PASS — "OK: no service-role key references found outside comments in app/ or lib/." |
| `bunx prettier --check` (new supplement file) | PASS after `--write` (matched repo formatting) |

Baseline before this issue was 206 tests / 16 suites per the coder's
changes.md; the coder's own new suites (`service-weeks-cancel-route.test.ts`,
`service-weeks-reactivate-route.test.ts`) brought it to 286/21, all green,
matching their claim exactly. My supplementary file adds 4 more tests / 1
more suite → 290/22, still all green.

## Code review against spec (`.pipeline/spec.md`)

Verified by reading the diff directly, not just trusting changes.md:

- `types/domain.ts` — `NotificationType` union added verbatim matching the
  spec's exact literal list (including the two new values
  `service_week_cancelled`, `service_week_reactivated`).
- `lib/supabase/types.ts` — `NotificationsRow` and the `notifications` table
  registration match the spec's row shape and Insert-optionality
  (`id`, `created_at`, `is_read` optional) exactly.
- `app/api/service-weeks/[id]/handler.ts` — shared private
  `setServiceWeekCancelled` helper correctly implements: admin-only role
  guard, JWT check, `service_weeks.update({is_cancelled}).eq("id",id)
  .eq("church_group_id",...)` scoping, 404 on null data, 500 on each of the
  three failure points (update, invitations select, notifications insert),
  recipient de-dup via `Set`, skip-insert-when-zero-recipients, and the two
  inline TODO no-op comments (chat archive / GCal removal) per the resolved
  open questions. `cancelServiceWeek`/`reactivateServiceWeek` are thin
  wrappers passing the correct `isCancelled`, `notificationType`, and
  `notificationTitle` per direction. No 409 short-circuit for the
  already-in-state case, matching the spec's idempotency note.
- `app/api/service-weeks/[id]/cancel/route.ts` and
  `.../reactivate/route.ts` — 501 stubs replaced with thin POST delegators,
  matching the wiring style of the existing `route.ts`. `notImplemented`
  import removed from both, confirmed by reading the files directly.
- `supabase/migrations/20260711000001_service_week_notification_types.sql`
  — two `ALTER TYPE ... ADD VALUE IF NOT EXISTS` statements, matches spec
  verbatim, with a commented DOWN section as required. Not exercised
  against a live Postgres instance — no DB available in this sandbox, same
  limitation the coder flagged. `bun run test:rls`/live-DB verification is
  out of scope for this unit-test pass.

## Independent test coverage added

Wrote `tests/unit/app/api/service-weeks-cancel-reactivate-tester-supplement.test.ts`
(4 new tests, all passing) to close a real gap in the coder's own test
harness: `service-weeks-cancel-route.test.ts` and
`service-weeks-reactivate-route.test.ts` use a mock chain where `.in(...)`
is a no-op passthrough that never records or asserts on its arguments. That
means a hypothetical handler bug (e.g. accidentally including `"denied"` in
the status filter, or filtering on the wrong column entirely) would NOT have
been caught by the existing suite — those tests only ever feed in
already-filtered fixture data and never check what filter the handler
actually asked the DB for.

New tests added and their results (all PASS):
1. **"filters the invitations recipient query on status IN ['pending',
   'accepted'] (not all statuses)"** — asserts the exact `.in()` call
   arguments captured via a recording mock chain. Confirms the handler
   literally calls `.in("status", ["pending", "accepted"])`.
2. **"does not notify recipients whose only invitations are
   denied/withdrawn/expired"** — simulates the DB honoring that filter (an
   all-denied/withdrawn/expired week resolves to zero recipients) and
   confirms no `notifications.insert` is attempted.
3. **"reactivate uses the same status filter as cancel"** — same argument
   assertion for the reactivate path.
4. **"cancel and reactivate are independent: cancelling never sets
   is_cancelled false and vice versa"** — captures the literal `update()`
   patches sent for each direction across two separate calls sharing the
   `setServiceWeekCancelled` helper and asserts
   `[{is_cancelled:true}, {is_cancelled:false}]` in order — directly
   verifies the changes.md-flagged risk that the shared helper might
   cross-contaminate state between the two thin wrappers.

## Coverage already adequate in the coder's own tests (spot-checked, not
duplicated)

- 401 (no Clerk userId, no JWT) for both routes.
- 403 for `member`/`set_leader`/`guest` via `it.each`, admin-only — and
  confirmed `getSupabaseClient` is never called in these cases (role guard
  fires before any DB access).
- 404 on missing/other-tenant row.
- 500 on each of update / invitations-select / notifications-insert errors.
- 200 happy path with correct `isCancelled` in the response body and
  correctly-shaped notification insert payload (`type`, `title`,
  `link_entity_type`, `link_entity_id`).
- Zero-recipient path skips the insert entirely.
- De-dup of repeated `user_id`s into a single notification row.
- Tenant-scoped `eq` call ordering (`["id", WEEK_ID]` then
  `["church_group_id", CHURCH_GROUP_ID]`).

## Failure cases exercised

401/403/404/500 paths in the coder's own suite plus the "zero recipients"
negative case in my supplement satisfy the "at least one failure case"
requirement. No test failures were found in either the coder's suite or my
supplement; no code changes were made to the implementation — only a new
test file was added.

## Notes for the Reviewer

- The migration's enum values were not applied against a live Postgres
  instance (no DB available in sandbox) — matches the coder's own documented
  limitation. Recommend a live/staging verification pass before merge if
  `bun run test:rls` or an actual Supabase instance is reachable in CI.
- No implementation defects found. The one gap found was in test coverage
  (untested `.in()` filter arguments), not in the implementation itself, and
  has now been closed by the supplementary test file.
