# Changes — Merge: Issue #32 + Issue #28 (main)

This branch merges `main` (Issue #28 — member removal) into the Issue #32
auth-matrix/coverage work. Conflict resolution kept both feature sets; the #32
T4 stub test for `DELETE /api/church-group/members/:id` was superseded by #28's
full implementation and its 13-test per-route suite.

---

# Issue #32: API auth-matrix tests for Sprint 0–1 routes

## Open questions — resolution applied

1. `DELETE /api/church-group/members/:id` (#28) was a 501 stub when #32 was
   written; #28 has since landed on `main` and was merged here. The original T4
   stub-pin test is replaced by #28's full auth-matrix per-route tests (see
   Issue #28 section below).
2. No real JWT signing was introduced. The harness mocks `@clerk/nextjs/server`'s
   `auth()` and injects a `UserLookup`, matching the existing per-route test
   pattern.

## Files changed (#32)

### `jest.config.ts` (modified) — T1
Added `collectCoverageFrom` (scoped to `app/api/church-group/**`,
`app/api/profile/**`, `app/api/instruments/**`, `lib/api/**`),
`coveragePathIgnorePatterns`, `coverageDirectory`, and `coverageReporters:
["text-summary", "lcov"]`. No `coverageThreshold` was added (report-only, per
spec, so this doesn't fail unrelated PRs). Nothing pre-existing in the config
was changed.

### `package.json` (modified) — T1
Added `"test:coverage": "jest --coverage"` next to the existing `"test": "jest"`
script.

### `.github/workflows/ci.yml` (modified) — T1
In the `checks` job, changed `- run: bun run test` to `- run: bun run
test:coverage` so CI emits the coverage text-summary in the logs. The
`check-secrets` and `rls-integration` jobs, and every other step in `checks`,
are untouched.

### `.gitignore` — not modified
`/coverage` was already present under the "testing" section; no duplicate entry
added.

### `tests/support/api-auth.ts` (new) — T2
Reusable auth-matrix harness exporting exactly `makeLookup(role, overrides?)`,
`mockClerkAuthed(jwt?)`, `mockClerkAnonymous()`, and `makeJsonReq(body?)`, with
the same resolved shapes as the copy-pasted per-route helpers. No existing test
file was rewritten or migrated — this module is purely additive.

### `tests/unit/app/api/auth-matrix.test.ts` (new) — T3
Consolidated auth-matrix pass consuming the harness, covering the admin-gated
handler-style routes: `patchMemberRole` (#27), `getAuditLog` (#29),
`addInstrument` / `promoteInstrument` / `deleteInstrument` (#31), and
`getChurchGroupMembers` (#26, admin-vs-guest gating).

---

# Issue #28: Remove/archive member with PII anonymization

All changes below were merged from `main`.

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
     concurrent admin removals.
  4. 404 if the target is missing / wrong group / already anonymized.
  5. 422 (`LAST_ADMIN`) if the target is the group's last non-anonymized admin.
  6. Anonymizes `name`/`email`/`phone`/`sms_opted_in`/`clerk_id`/`role`/
     `anonymized_at` in place.
  7. Deletes `member_profiles` (cascades `member_instruments`), `availability`,
     `notification_preferences`, `notifications`, `google_calendar_tokens` for
     the user. Leaves `invitations`, `event_attendees`,
     `setlists`/`events`/`service_weeks.created_by`, `conflicts.*` untouched.

## `lib/supabase/types.ts`

- Added `sms_opted_in: boolean` and `anonymized_at: string | null` to `UsersRow`.
- Added a `remove_church_group_member` entry to `Functions`.

## `app/api/church-group/members/[id]/route.ts`

- Replaced the `notImplemented` DELETE stub with a thin wrapper (awaits
  `params`, delegates to `deleteMember`), matching the `role/route.ts` pattern.

## `app/api/church-group/members/[id]/handler.ts` (new)

- `deleteMember(req, targetUserId, lookup?)`: `requireAuth` → `requireRole(ctx,
  ["admin"])` → validate `:id` as a UUID →
  `supabase.rpc("remove_church_group_member", ...)` → maps RPC error substrings
  to HTTP codes → `writeAuditLog({ action: "member.removed", ... })` →
  `ok({ id: targetUserId })`.

## `app/api/church-group/members/handler.ts`

- Added `.is("anonymized_at", null)` to the roster query so removed members no
  longer appear in the member directory.

## `tests/unit/app/api/church-group-members-id-route.test.ts` (new — 13 tests)

- Full auth-matrix coverage for `deleteMember` (replaces the #32 T4 stub-pin test).
  Covers 401, 403 per-role, 400, 404/422/403/401 from RPC errors, 500 paths,
  200 success, and audit-log failure.

## `tests/unit/app/api/church-group-members-route.test.ts`

- Extended the mock query-builder chain to support `.eq().is()`. Added one
  test asserting the roster query calls `.is("anonymized_at", null)`.

## `tests/integration/rls/tables/member-removal.test.ts` (new)

- RPC integration tests including BR-12 concurrent-removal locking.

## Verification (post-merge)

- `bun run typecheck` — must pass.
- `bun run lint` — must pass.
- `bun run test` and `bun run test:coverage` — must pass (combined suite).
- `bun run test:rls` — integration file loads; skipped without live Supabase.

## What the Reviewer should focus on

- #32: harness shapes, handler call arity in `auth-matrix.test.ts`, CI coverage
  config has no `coverageThreshold`.
- #28: RPC locking strategy, integration test gap (run `test:rls` against live DB
  before merge if possible).
