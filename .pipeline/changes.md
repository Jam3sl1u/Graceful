# Changes — Issue #30: Member profile CRUD (`GET`/`PUT /api/profile`)

## Files changed

### `schemas/profile.ts` (rewritten)
- Replaced the `z.object({})` placeholder with `updateProfileSchema`:
  `vocalCapability` restricted to `["lead", "harmony", "both", "none"]` (exported as
  `VOCAL_CAPABILITY_VALUES`, matching the Postgres `vocal_capability` enum and
  `VocalCapability` in `types/domain.ts`), and `bio` — trimmed, capped at 2000 chars,
  nullish, with empty/whitespace-only normalized to `null` via `.transform`.
- Exports `UpdateProfileInput` inferred type.

### `app/api/profile/handler.ts` (new)
- `getProfile(req, lookup?)`: `requireAuth` → Clerk JWT (401 `UNAUTHENTICATED` if
  missing) → `getSupabaseClient(jwt)` → `member_profiles` lookup by `user_id`
  (`.select("id, vocal_capability, bio").eq("user_id", ctx.userId).maybeSingle()`).
  - DB error → 500 `INTERNAL`.
  - No row → returns synthesized defaults (`vocalCapability: "none"`, `bio: null`,
    `instruments: []`) without querying instruments.
  - Row found → loads instruments via the shared `loadInstruments` helper and returns
    the full `ProfileResponse`.
- `updateProfile(req, lookup?)`: `requireAuth` → parse body via
  `req.json().catch(() => null)` + `updateProfileSchema.safeParse` (400
  `VALIDATION_FAILED` on failure) → Clerk JWT (401 if missing) → upserts
  `member_profiles` keyed on `user_id` (`onConflict: "user_id"`), setting only
  `vocal_capability` and `bio` (never `id`/`created_at` — there is no `updated_at`
  column) → 500 `INTERNAL` on upsert error → loads instruments for the returned row
  and returns the same `ProfileResponse` shape.
  - Note: the hand-written `Insert` type in `lib/supabase/types.ts` marks
    `created_at` as required (it doesn't model the DB's `now()` default). Per spec,
    `lib/supabase/types.ts` was left untouched, so the upsert payload is built as a
    plain object and cast (`as unknown as Database[...]["Insert"]`) locally in the
    handler — no `created_at` value is ever actually set.
- `loadInstruments(supabase, memberProfileId, churchGroupId)` (private helper): mirrors
  the instrument name-mapping in `app/api/church-group/members/handler.ts` —
  queries `member_instruments` by `member_profile_id` and `instruments` by
  `church_group_id`, builds a `Map<instrument_id, name>`, and skips any
  `member_instruments` row whose `instrument_id` has no matching instrument. Throws
  `ApiException(INTERNAL, 500)` on either query error, caught by the outer
  `try/catch` in both handlers.
- Both handlers do **not** call `requireRole` — ownership is enforced by RLS
  (`user_id = auth_user_id()`) and by scoping queries to `ctx.userId`.

### `app/api/profile/route.ts` (rewritten)
- Reduced to thin delegators: `GET` → `getProfile(req)`, `PUT` → `updateProfile(req)`.
  The old ad-hoc `GET` (`{ userId }`) and `notImplemented` `PUT` stub are gone.

### `tests/unit/app/api/profile-route.test.ts` (new)
- Mocks `@clerk/nextjs/server` (`auth`) and `@/lib/supabase/client`
  (`getSupabaseClient`), following the harness pattern from
  `church-group-members-route.test.ts`.
- `makeSupabaseClient(overrides, onUpsert?)` fixture builder: `.select(...).eq(...)`
  resolves directly (for `member_instruments`/`instruments`) or via `.maybeSingle()`
  (for `member_profiles`); `.upsert(payload, opts)` records the payload via the
  `onUpsert` callback and chains `.select(...).maybeSingle()` to the configured
  `member_profiles` fixture result.
- Covers all cases listed in the spec: `GET` 401 (no Clerk user / no JWT), 200 with
  an existing profile (instruments name-mapped), 200 with synthesized defaults when
  no profile row exists, skipping an unmatched `member_instruments` row, 500 on a
  `member_profiles` query error; `PUT` 400 on invalid/malformed `vocalCapability`,
  200 updating an existing profile (asserts the recorded upsert payload), 200
  upserting a new profile for a member who had none, bio normalization
  (whitespace → `null`, asserted on both the upsert payload and the response), 500
  on upsert error, and 401 when the JWT is missing.

## Verification
- `bun run typecheck` — passes.
- `bun run lint` — passes.
- `bun run test` — all 8 suites / 66 tests pass (including the 13 new tests for this
  route).

## What the Tester should focus on
- The `created_at` typing workaround in `updateProfile` (a narrow `as unknown as
  Database[...]["Insert"]` cast) — confirm no `created_at`/`id` value is ever sent in
  the upsert payload at runtime (it isn't; only `user_id`, `vocal_capability`, `bio`
  are set).
- Confirm `GET` never queries `member_instruments`/`instruments` when there is no
  `member_profiles` row (per spec, that branch returns early).
- Instrument selection (`member_instruments` writes) is intentionally out of scope —
  deferred to #31; `PUT` never touches that table.
- No new migration was added (schema + RLS already exist); `lib/supabase/types.ts`
  and `types/domain.ts` were left untouched per spec.
- Only `app/api/profile/*` and `schemas/profile.ts` were touched — no other routes
  were modified.
