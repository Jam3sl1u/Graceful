# Changes — Issue #28: Remove/archive member with PII anonymization

This corrects the prior pipeline run, whose `.pipeline/` artifacts described the
already-merged Issue #37 and shipped no product code for #28. All changes below are
new in this branch.

## `supabase/migrations/20260710000001_member_removal_rpc.sql` (new)

- `ALTER TABLE public.users ADD COLUMN anonymized_at timestamptz;` + a partial index
  (`WHERE anonymized_at IS NULL`) for the active-roster query.
- `remove_church_group_member(p_target_user_id uuid) RETURNS public.users` —
  `SECURITY DEFINER` (bypasses RLS to bypass the owner-only policies on
  `notification_preferences`/`notifications`/`google_calendar_tokens`; the
  function's own caller-role check is therefore the real "Admin only"
  enforcement, not RLS). Does, in one transaction:
  1. Resolves the caller from the JWT; 401 if no session/row.
  2. 403 if the caller's role isn't `admin`.
  3. Locks `{target row} ∪ {every current admin row in the group}` in one
     `ORDER BY id FOR UPDATE` query — a single combined lock acquisition,
     not two sequential ones, specifically to avoid a deadlock between two
     concurrent admin removals (T1 locks X then wants Y; T2 locks Y then
     wants X, if done as separate queries).
  4. 404 if the target is missing / wrong group / already anonymized.
  5. 422 (`LAST_ADMIN`) if the target is the group's last non-anonymized admin.
  6. Anonymizes `name`/`email`/`phone`/`sms_opted_in`/`clerk_id`/`role`/
     `anonymized_at` in place.
  7. Deletes `member_profiles` (cascades `member_instruments`), `availability`,
     `notification_preferences`, `notifications`, `google_calendar_tokens` for
     the user. Leaves `invitations`, `event_attendees`,
     `setlists`/`events`/`service_weeks.created_by`, `conflicts.*` untouched.

## `lib/supabase/types.ts`

- Added `sms_opted_in: boolean` and `anonymized_at: string | null` to `UsersRow`
  (both written by the RPC's `RETURNING *`, both previously absent from this
  hand-written type).
- Added a `remove_church_group_member` entry to `Functions`.

## `app/api/church-group/members/[id]/route.ts`

- Replaced the `notImplemented` DELETE stub with a thin wrapper (awaits
  `params`, delegates to `deleteMember`), matching the `role/route.ts` pattern.

## `app/api/church-group/members/[id]/handler.ts` (new)

- `deleteMember(req, targetUserId, lookup?)`: `requireAuth` → `requireRole(ctx,
  ["admin"])` (fast client-side fail; the RPC's own check is load-bearing) →
  validate `:id` as a UUID → `supabase.rpc("remove_church_group_member", ...)`
  → maps `error.message` substrings to HTTP codes (`NOT_FOUND`→404,
  `LAST_ADMIN`→422, `FORBIDDEN`→403, `UNAUTHENTICATED`→401, else→500) →
  `writeAuditLog({ action: "member.removed", entityType: "user", entityId,
  metadata: {} })` → `ok({ id: targetUserId })`.

## `app/api/church-group/members/handler.ts`

- Added `.is("anonymized_at", null)` to the roster query so removed members no
  longer appear in the member directory.

## `tests/unit/app/api/church-group-members-id-route.test.ts` (new — 13 tests)

- Mirrors `church-group-join-route.test.ts`'s RPC-mocking style (mock
  `.rpc()` return values / `error.message` substrings) rather than the
  role-route's multi-`.from()` queue style, since the business logic now
  lives in the RPC. Covers 401 (no session / no JWT), 403 per-role
  (`it.each`), 400 (malformed id), 404/422/403/401 mapped from RPC error
  messages, 500 on unrecognized error and on empty `{data: null, error:
  null}`, the 200 success path (asserts the exact `rpc` call args, response
  body, and `writeAuditLog` call), and 500 when `writeAuditLog` throws after
  a successful RPC call.

## `tests/unit/app/api/church-group-members-route.test.ts`

- Extended the mock query-builder chain to support `.eq().is()`. Added one
  test asserting the roster query calls `.is("anonymized_at", null)`.

## `tests/integration/rls/tables/member-removal.test.ts` (new)

- First RPC integration test in this repo (no existing RPC —
  `join_church_group`, `create_church_group`, `write_audit_log` — has one
  yet), added because BR-12 and the PII wipe are safety-critical and the
  BR-12 TOCTOU race specifically needs a real transaction/locking engine to
  exercise meaningfully; a mocked unit test can't catch it.
  - Admin removes a non-admin member (`memberA2` from the shared RLS
    fixture): asserts the anonymized field values, that `member_profiles`/
    `member_instruments`/`availability` rows are gone, that the seeded
    `invitations` row for that user is still present and still points at
    the same `user_id`, and that re-removing the same target now 404s.
  - BR-12: removing the sole remaining admin (`adminA`) returns `LAST_ADMIN`
    and leaves the row untouched.
  - Non-admin caller (`memberA`) gets `FORBIDDEN`; target untouched.
  - Concurrent removal: an isolated temp church group with exactly two admins,
    each concurrently removing the other via `Promise.all`; asserts exactly
    one succeeds and the other gets `LAST_ADMIN`, and that the group never
    drops to zero admins. Cleans up the temp church group (cascades its
    users) in `afterAll`.

## Verification

- `bun run typecheck` — clean.
- `bun run lint` — clean.
- `bun run test` — 186/186 unit tests pass (15 suites), including the 2
  files above.
- `bun run test:rls` — the new integration file loads and is correctly
  skipped (no local Supabase instance available in this environment: no
  `supabase` CLI, and `SUPABASE_TEST_URL` etc. are unset). **Not run against
  a live database** — this is the one verification gap; see
  `test-results.md` for what a human should do to close it before merge.

## What the Reviewer should focus on

- The RPC's combined `ORDER BY id FOR UPDATE` lock (point 3 above) is the
  load-bearing fix for a deadlock I found while designing the concurrent-
  removal integration test — worth double-checking the reasoning in the
  migration's inline comment.
- The integration test in `tests/integration/rls/tables/member-removal.test.ts`
  has not actually been executed against a live Postgres/Supabase instance in
  this environment. It should be run for real (`supabase start && bun run
  test:rls`) before this ships, particularly the concurrent-removal case.
