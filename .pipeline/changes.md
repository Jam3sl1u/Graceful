# Changes — Issue #26: Member directory endpoint (`GET /api/church-group/members`)

## Files changed

### `app/api/church-group/members/route.ts` (replaced stub)
- Implements `GET` per spec: `requireAuth` -> `requireRole(["admin","set_leader","member"])`
  (guests get 403) -> builds a Supabase client from the Clerk JWT (401 `UNAUTHENTICATED`
  if no JWT) -> runs 4 group-scoped queries (`users`, `member_profiles`,
  `member_instruments`, `instruments`) in parallel -> 500 `INTERNAL` if any query errors
  -> assembles `DirectoryMember[]` in JS (no SQL joins).
- Exports `DirectoryMember` type exactly as specified, including the `availabilityStatus:
  null` placeholder (comment references #34) and `email`/`phone` keys that are added to
  the object only when `ctx.role === 'admin'` (omitted entirely, not set to `null`, for
  non-admins).
- Users with no `member_profiles` row get `vocalCapability: 'none'`, `instruments: []`.
- `member_instruments` rows whose `instrument_id` has no matching `instruments` row are
  skipped (no `{id, name: undefined}` entries).
- No sorting/pagination — returns all members in query order.
- Followed the OPEN QUESTION defaults from the spec as-is (availability always `null`;
  directory lists all users in the group regardless of role).

### `lib/supabase/types.ts` (extended)
- `UsersRow` gained `name`, `email`, `phone` (needed for the new query's `.select`).
- Added minimal `Row`/`Insert`/`Update`/`Relationships: []` entries for `member_profiles`,
  `instruments`, and `member_instruments`, matching the existing hand-written style.
  `member_profiles.vocal_capability` uses the `VocalCapability` type imported from
  `@/types/domain`.
- `lib/api/auth.ts`'s existing `.select("id, church_group_id, role")` on `users` is
  unaffected — untouched, still typechecks against the wider `UsersRow`.
- `church_groups` and the `create_church_group` function entry left as-is.

### `tests/unit/app/api/church-group-members-route.test.ts` (new)
- Mocks `@clerk/nextjs/server` (`auth`) and `@/lib/supabase/client`
  (`getSupabaseClient`), combining the role/lookup-seam pattern from
  `admin-only-route.test.ts` with the Supabase-client mocking pattern from
  `church-group-route.test.ts`.
- `makeSupabaseClient(overrides)` builds a `from(table).select(...)` mock whose return
  value is a `Promise` (for the no-`.eq` queries) that also carries an `.eq()` method
  returning a plain promise (for the `.eq`-filtered queries) — handles both call shapes
  used by the route.
- Fixtures: 3 users in one group (admin caller, a member with a profile + 1 instrument,
  and a member with no profile row), 1 instrument, matching `member_instruments` /
  `member_profiles` rows.
- Covers: 401 when Clerk `userId` is null (lookup never consulted); 403 for
  `role: 'guest'`; 200 for `admin` (email/phone keys present); 200 for `member` and
  `set_leader` (email/phone keys absent, via `it.each`); instrument mapping; the
  no-profile user still appears with `vocalCapability: 'none'` / `instruments: []`;
  every member has `availabilityStatus: null`; 500 `INTERNAL` when the `users` query
  errors.

## Verification
- `bun run typecheck` — passes.
- `bun run lint` — passes.
- `bun run test` — all 6 suites / 38 tests pass (including the 8 new tests for this
  route).

## What the Tester should focus on
- Confirm the `email`/`phone` key-omission behavior specifically (`"email" in member`
  must be `false` for non-admins). `NextResponse.json` drops `undefined` keys on
  serialization, so checking presence on the parsed response body is the correct
  assertion approach, which is what the new test uses.
- No new migration was added (per spec, schema/RLS already exist) — only
  `lib/supabase/types.ts` was touched for typing, no DB changes.
- Out-of-scope items intentionally untouched: `app/api/church-group/members/[id]/*`
  stubs, any UI, availability wiring (#34), role assignment (#27), member removal (#28).
- Cross-group isolation (AC-3) relies on RLS + the explicit `church_group_id` filters;
  per spec that's covered by `tests/integration/rls/`, not unit tests, and was not
  added here.
