# Changes — Issue #24: Church group creation (`PUT /api/church-group`)

## Files changed

### `supabase/migrations/20260706000001_church_group_create_rpc.sql` (new)
- `public.generate_invite_code()` — `SECURITY DEFINER` plpgsql function that
  generates an 8-char code from the unambiguous URL-safe alphabet
  (`ABCDEFGHJKMNPQRSTUVWXYZ23456789`), looping until it finds a value not
  already present in `church_groups.invite_code`. Not granted to
  `authenticated` (only called internally).
- `public.create_church_group(p_name, p_timezone, p_denomination, p_logo_url,
  p_creator_name, p_creator_email)` — `SECURITY DEFINER` plpgsql function,
  `GRANT EXECUTE ... TO authenticated`. In one transaction:
  1. Resolves `auth.jwt() ->> 'sub'`; raises `UNAUTHENTICATED` (`ERRCODE
     'P0001'`) if null.
  2. Raises `USER_ALREADY_IN_GROUP` (`ERRCODE 'P0001'`) if a `users` row
     already exists for that Clerk id.
  3. Inserts the `church_groups` row (using the generated invite code),
     inserts the creator as an `admin` `users` row, then seeds exactly the 8
     named default instruments (`is_default = true`, `created_by = NULL`) —
     no "Other" row.
  4. Returns the new `church_groups` row.
  - Commented-out DOWN section drops both functions.
  - This exists because `church_groups`/`users` have no authenticated INSERT
    policy and the service-role key is forbidden in `app/`/`lib/` — see the
    spec's Background section for the full rationale.

### `schemas/church-group.ts` (rewritten)
- Removed the unused `churchGroupSchema` / `ChurchGroupInput` stub.
- Added `createChurchGroupSchema` (zod): `name` (required, trimmed, 1–100
  chars), `timezone` (optional but defaults to `"America/Chicago"`, validated
  via a local `isValidIanaTimezone` helper using
  `Intl.DateTimeFormat`/try-catch — no hardcoded timezone list),
  `denomination` (optional, ≤100 chars), `logoUrl` (optional, ≤2048 chars —
  documented as an R2 object key, never a public URL).
- Exported `CreateChurchGroupInput` type.

### `app/api/church-group/route.ts` (rewritten)
- `GET` unchanged (`notImplemented`).
- `PUT` implemented per spec:
  1. `auth()` → 401 `UNAUTHENTICATED` if no Clerk `userId`.
  2. `getToken({ template: "supabase" })` → 401 if no JWT.
  3. Parses/validates body with `createChurchGroupSchema.safeParse` → 400
     `VALIDATION_FAILED` on failure (covers missing/blank name, invalid
     timezone, and non-JSON/empty body).
  4. `currentUser()` → derives `creatorName` (first non-empty of `fullName`,
     `"firstName lastName"`, `username`, email local-part, else `"Admin"`,
     truncated to 100 chars) and `creatorEmail` (primary email or `null`).
  5. Calls `supabase.rpc("create_church_group", {...})` via
     `getSupabaseClient(jwt)`.
  6. Error mapping: `USER_ALREADY_IN_GROUP` → 409 `CONFLICT`;
     `UNAUTHENTICATED` → 401; any other RPC error → 500 `INTERNAL`.
  7. Success → `ok(data, 201)`.
  - Whole handler wrapped in try/catch → 500 `INTERNAL` as a last resort,
    matching the `app/api/_examples/admin-only/route.ts` pattern.
  - Does not call `requireAuth` (creator has no `users` row yet).

### `lib/supabase/types.ts` (extended)
- Added `ChurchGroupsRow` type and a `church_groups` table entry
  (`Row`/`Insert`/`Update`/`Relationships: []`) mirroring the existing
  `users` entry style.
- Replaced `Functions: Record<string, never>` with a typed
  `create_church_group` entry (`Args` matching the RPC's `p_*` params,
  `Returns: ChurchGroupsRow`) so `supabase.rpc("create_church_group", ...)`
  typechecks.

### `tests/unit/app/api/church-group-route.test.ts` (new)
Mocks `@clerk/nextjs/server` (`auth`, `currentUser`) and
`@/lib/supabase/client` (`getSupabaseClient`), following the style of
`tests/unit/lib/api/lookup-user.test.ts`. Covers:
- 201 happy path — asserts `rpc` called with the exact expected params and
  the response body is `{ data: <group row incl. invite_code> }`.
- 400 on missing `name`.
- 400 on invalid IANA timezone (`"Mars/Phobos"`).
- 401 when Clerk `userId` is null.
- 401 when `getToken` resolves to null (extra case beyond the spec's minimum
  list — covers the "no supabase JWT" edge case called out in the spec).
- 409 when the RPC returns a `USER_ALREADY_IN_GROUP` error.
- 500 on a generic RPC error.
- Fallback to `"Admin"` as `p_creator_name` when Clerk has no usable name
  (extra case beyond the spec's minimum list — covers the "creator has no
  name" edge case called out in the spec).

## Verification run
- `bun run typecheck` — passes.
- `bun run lint` — passes.
- `bun run test` — all 5 suites / 25 tests pass (including the 8 new
  church-group route tests).
- `bun run check:service-role` — passes (no service-role key references in
  `app/`/`lib/`).
- `bunx prettier --check` on all touched files — passes.

## Not committed / out of scope
- `.pipeline/spec.md` and `.claude/workflows/handle-issues.js` showed as
  modified in the working tree before this pass started; per the incident
  history documented in the prior `.pipeline/changes.md` (issue #23), those
  are pipeline-orchestrator scratch content, not part of this code change —
  left untouched/unstaged, not committed.

## What the Tester should focus on
- The DB-level behavior of the RPC (exactly 8 default instruments seeded in
  the correct order/names, creator gets `admin` role, invite-code
  uniqueness/collision retry, atomicity/rollback on failure) is **not**
  covered by the unit test added here — per spec this belongs in
  `tests/integration/rls/` and is explicitly out of scope for this pass.
  Flagging so it isn't assumed covered.
- The migration SQL has been reviewed against the existing migration style
  but not executed — there is no local Supabase CLI/DB available in this
  environment to run `supabase migration up` / `db reset`.
- `error.message.includes(...)` string matching against real
  PostgREST/postgres error payloads for `RAISE EXCEPTION ... USING ERRCODE =
  'P0001'` is only verified against mocked `error.message` values in the
  unit tests, not a live Supabase error shape.
