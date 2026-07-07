# Changes — Issue #25: Join church group via invite code (`POST /api/church-group/join`)

## Human-resolved OPEN QUESTIONS (override spec.md's stated assumptions)

1. **Expired codes.** Spec's original assumption ("no expiry column, treat
   only unknown codes as invalid") was overridden by a human decision:
   **expiry support is added now.** `church_groups` gets a new nullable
   `invite_code_expires_at timestamptz` column (migration
   `20260706000002_church_group_join_rpc.sql`, added via `ALTER TABLE`, not by
   touching the create migration). `NULL` means "never expires" — every
   invite code created today (via the untouched `create_church_group` RPC)
   still works exactly as before. `join_church_group()` now checks this
   column and raises the same `INVALID_INVITE_CODE` exception when
   `invite_code_expires_at IS NOT NULL AND invite_code_expires_at <= now()`.
   Because the route already maps `INVALID_INVITE_CODE` → 400 "Invalid or
   expired invite code", no route-level changes were needed to surface
   expired/revoked codes with the correct copy — the same column doubles as
   a manual revocation mechanism (an admin can set it to `now()`/the past to
   revoke a code immediately). No admin UI/route to *set* this column was
   built — out of scope for #25, tracked separately if/when needed.
2. **Post-join redirect.** Spec's original assumption (client-side
   `router.push("/profile")` on success) was overridden by a human decision:
   **return membership in the response body; no client-side redirect.** The
   201 response returns the full `users` row (`church_group_id`,
   `role: "member"`, etc.) as `{ data: ... }`. `app/(public)/join/[code]/`
   shows an in-place "you're in" success state after a successful POST — it
   does **not** navigate anywhere. Redirecting to a profile-completion flow
   is deferred to issue #16 (not #30 — the human resolution ties this
   specifically to #16).

## Files changed

### `supabase/migrations/20260706000002_church_group_join_rpc.sql` (new)
- `ALTER TABLE public.church_groups ADD COLUMN invite_code_expires_at
  timestamptz;` (nullable, no default change to existing rows — see above).
- `public.join_church_group(p_invite_code, p_member_name, p_member_email)` —
  `SECURITY DEFINER` plpgsql function, `GRANT EXECUTE ... TO authenticated`.
  Mirrors `create_church_group`'s conventions exactly (`SET search_path =
  ''`, `RAISE EXCEPTION ... USING ERRCODE = 'P0001'`):
  1. Resolves `auth.jwt() ->> 'sub'`; raises `UNAUTHENTICATED` if null.
  2. Raises `USER_ALREADY_IN_GROUP` if a `users` row already exists for that
     Clerk id.
  3. Resolves the group id + `invite_code_expires_at` from `p_invite_code`;
     raises `INVALID_INVITE_CODE` if no row matches.
  4. Raises `INVALID_INVITE_CODE` again if the code is expired/revoked (see
     above).
  5. Inserts the joiner as a `'member'` `users` row, returns it.
  - Commented-out DOWN section drops the function and the new column.
  - Does not seed instruments or create a `member_profiles` row (both out of
    scope per spec).

### `schemas/church-group.ts` (appended, `createChurchGroupSchema` untouched)
- Added `joinChurchGroupSchema`: `inviteCode` (`z.string().trim()
  .toUpperCase().min(1).max(20)`), so lowercase/whitespace-padded user input
  normalizes to match the uppercase-only codes `generate_invite_code()`
  emits. Exported `JoinChurchGroupInput` type.

### `app/api/church-group/join/route.ts` (replaced stub)
- `POST` implemented per spec, copying the `PUT /api/church-group` pattern:
  1. `auth()` → 401 `UNAUTHENTICATED` if no Clerk `userId`.
  2. `getToken({ template: "supabase" })` → 401 if no JWT.
  3. Parses/validates body with `joinChurchGroupSchema.safeParse` → 400
     `VALIDATION_FAILED` on failure (covers missing/blank code and
     non-JSON/empty body); `getSupabaseClient` is not called on this path.
  4. `currentUser()` → derives `memberName` via `deriveMemberName` (identical
     to `deriveCreatorName` except the fallback literal is `"Member"`, not
     `"Admin"`) and `memberEmail` (primary email or `null`).
  5. Calls `supabase.rpc("join_church_group", {...})` via
     `getSupabaseClient(jwt)`.
  6. Error mapping: `INVALID_INVITE_CODE` → 400 `VALIDATION_FAILED`
     ("Invalid or expired invite code"); `USER_ALREADY_IN_GROUP` → 409
     `CONFLICT`; `UNAUTHENTICATED` → 401; any other RPC error → 500
     `INTERNAL`.
  7. Success → `ok(data, 201)` (the new `users` row, i.e. the membership).
  - Whole handler wrapped in try/catch → 500 `INTERNAL` as a last resort.
  - Does not call `requireAuth` (joiner has no `users` row yet).

### `lib/supabase/types.ts` (extended)
- Added a `join_church_group` entry to `Database.public.Functions` (`Args`
  matching the RPC's `p_*` params, `Returns: UsersRow`) so
  `supabase.rpc("join_church_group", ...)` typechecks. `create_church_group`
  entry and `ChurchGroupsRow`/`UsersRow` shapes untouched.

### `app/(public)/join/[code]/page.tsx` (replaced stub)
- Thin async server component: unwraps `params` (`Promise<{ code: string
  }>`), passes `code` to the new client component.

### `app/(public)/join/[code]/join-form.tsx` (new, client component)
- `"use client"` component with local `status` state
  (`idle`/`submitting`/`success`/`error`).
- On "Join group" click: `POST /api/church-group/join` with `{ inviteCode:
  code }`.
- On 2xx: shows an in-place "you're in" success message. **Does not
  redirect** — per the human-resolved override, any redirect to a
  profile-completion page is deferred to issue #16.
- On non-2xx: renders the `error` string from the `{ error, code }` envelope
  (covers AC #2 — invalid/expired code shows a clear message).

### `tests/unit/app/api/church-group-join-route.test.ts` (new)
Mocks `@clerk/nextjs/server` and `@/lib/supabase/client`, following
`tests/unit/app/api/church-group-route.test.ts`'s style exactly (`makeReq` /
`makeSupabaseRpc` helpers). Covers all cases required by the spec:
- 201 happy path (asserts exact `rpc` call args and `{ data: <users row> }`
  body).
- inviteCode uppercased/trimmed (`" abcd2345 "` → `"ABCD2345"`).
- 400 `INVALID_INVITE_CODE` → `VALIDATION_FAILED`.
- 400 on missing/empty `inviteCode` (schema failure), `getSupabaseClient` not
  called.
- 400 on non-JSON/empty body, `getSupabaseClient` not called.
- 409 `USER_ALREADY_IN_GROUP` → `CONFLICT`.
- 401 no Clerk `userId`, `getSupabaseClient` not called.
- 401 `getToken` resolves null, `getSupabaseClient` not called.
- 500 on generic RPC error.
- 500 when `currentUser()` rejects, `getSupabaseClient` not called.
- Falls back to `"Member"` / `p_member_email: null` when `currentUser()`
  resolves `null`.

## Verification run
- `bun run typecheck` — passes.
- `bun run lint` — passes.
- `bun run test` — all 6 suites / 40 tests pass (including the 10 new
  church-group join route tests).
- `bun run check:service-role` — passes (no service-role key references in
  `app/`/`lib/`).
- `bun run format:check` — pre-existing warnings only in files this change
  did not touch (`README.md`, `supabase/README.md`,
  `tests/integration/rls/**`); none of the files changed in this pass are
  flagged.
- The migration is plain SQL, not executed by the test suite (no local
  Supabase CLI/DB available in this environment) — reviewed against
  `20260706000001_church_group_create_rpc.sql`'s conventions but not run
  against a live database.

## Not touched / explicitly out of scope
- `createChurchGroupSchema`, `create_church_group` RPC, and
  `app/api/church-group/route.ts` (`PUT`) — untouched, per spec.
- Direct email invites, `member_profiles` creation, and the
  instruments/vocal-capability onboarding form (issue #30) — not built.
- Any admin-facing UI/route to set or clear `invite_code_expires_at` — the
  column exists and is enforced by `join_church_group`, but nothing in this
  change writes a non-null value to it yet (every code created via
  `create_church_group` remains a never-expiring code until a future issue
  adds that control).
- `.pipeline/spec.md` shows as modified in the working tree from before this
  pass started — not touched by this change, left as-is.

## What the Tester should focus on
- The expiry-check branch in `join_church_group()` (RPC treats
  `invite_code_expires_at <= now()` as `INVALID_INVITE_CODE`, same as an
  unknown code) is new code with no direct unit-test coverage in this pass —
  it's SQL, not reachable from the mocked-RPC unit tests. If integration/RLS
  tests exist or are added for this migration, that branch is the key thing
  to exercise (e.g. seed a group with a past `invite_code_expires_at` and
  confirm join fails with the same message/status as an unknown code).
- The `join-form.tsx` success state is intentionally a dead end (no
  redirect) per the human override — confirm this reads as intentional
  scope, not a missed requirement, when reviewing against the original AC
  #4 wording.
- `error.message.includes(...)` string matching against real
  PostgREST/postgres error payloads is only verified against mocked
  `error.message` values in the unit tests, not a live Supabase error shape
  (same caveat as issue #24's join-adjacent RPC).
