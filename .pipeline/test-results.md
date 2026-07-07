# Test Results — Issue #30: Member profile CRUD (`GET`/`PUT /api/profile`)

## Verdict: PASS

## Checks re-run independently (Bun)

- `bun install` — no changes, deps already in sync.
- `bun run lint` (`eslint .`) — **PASS**, no warnings/errors.
- `bun run typecheck` (`tsc --noEmit`) — **PASS**, no errors.
- `bun run test` (`jest`) — **PASS**, 8 suites / 66 tests, 0 failures. Matches
  the Coder's claim in `changes.md`. Suite list includes the new
  `tests/unit/app/api/profile-route.test.ts` (13 tests) alongside all
  pre-existing suites (church-group-route, admin-only, church-group-join,
  church-group-members, lib/api/response, lib/api/auth, lib/api/lookup-user) —
  no regressions elsewhere.

## Independent verification of spec/AC compliance

1. **Scope of changed files** — confirmed via `git diff --stat main...HEAD`:
   only `app/api/profile/handler.ts` (new), `app/api/profile/route.ts`,
   `schemas/profile.ts`, and the new test file were touched (plus pipeline
   docs). No other routes, no `lib/supabase/types.ts`, no `types/domain.ts`,
   no new migrations — matches spec's "explicitly out of scope" list and
   changes.md's claims.

2. **DB schema/RLS assumptions** — checked directly against the migrations:
   - `supabase/migrations/20260702000001_cluster_1_organization.sql`:
     `member_profiles` has `id, user_id (unique), vocal_capability
     (enum 'none'|'lead'|'harmony'|'both', not null default 'none'), bio text,
     created_at` — **no `updated_at` column**, confirming the handler is
     correct not to set one.
   - `supabase/migrations/20260704000001_rls_policies.sql`: confirmed
     `member_profiles_select_tenant`, `member_profiles_insert_own`,
     `member_profiles_update_own`, `member_instruments_select_tenant`,
     `instruments_select_tenant` all exist as described, supporting the
     handler's choice to skip `requireRole` and rely on RLS + `ctx.userId`
     scoping.
   - `types/domain.ts` exports `VocalCapability = "lead" | "harmony" | "both" |
     "none"`, matching `VOCAL_CAPABILITY_VALUES` in `schemas/profile.ts`.

3. **Zod schema behavior** — independently exercised `updateProfileSchema`
   with a standalone script (11 cases) outside the existing test file:
   - Missing `bio` → defaults to `null`. Pass.
   - `bio` with leading/trailing whitespace → trimmed. Pass.
   - Whitespace-only / empty string `bio` → normalized to `null`. Pass.
   - `bio` exactly 2000 chars → accepted; 2001 chars → rejected
     ("String must contain at most 2000 character(s)"). Pass (boundary
     verified in both directions).
   - Invalid enum casing (`"LEAD"`) and missing `vocalCapability` → rejected
     with clear Zod messages. Pass.
   - Non-string `bio` (number) → rejected. Pass.

4. **Handler logic read-through** (`app/api/profile/handler.ts`):
   - `getProfile` returns early with synthesized defaults
     (`vocalCapability: "none"`, `bio: null`, `instruments: []`) when
     `member_profiles` has no row, and does **not** call `loadInstruments` in
     that branch — confirmed by code inspection (early `return` before the
     `loadInstruments` call) and by the existing "no member_profiles row"
     test case.
   - `updateProfile` builds the upsert payload as a plain object with exactly
     `user_id`, `vocal_capability`, `bio` before the `as unknown as
     Database[...]["Insert"]` cast — confirmed by inspection and by the
     existing test's `toEqual({ user_id, vocal_capability, bio })` assertion
     on the captured payload (no `id`/`created_at` present at runtime).
   - `loadInstruments` mirrors the `church-group/members/handler.ts` pattern:
     builds a `Map<instrument_id, name>` from group-scoped `instruments`,
     skips any `member_instruments` row without a match, and throws
     `ApiException(INTERNAL, 500)` on either query error, caught by the
     shared `try/catch` in both handlers.
   - `route.ts` is a thin delegator (`GET` → `getProfile`, `PUT` →
     `updateProfile`), matching the spec's example verbatim.

5. **Test file coverage** (`tests/unit/app/api/profile-route.test.ts`) — all
   13 spec-listed cases are present and pass: GET 401 (no Clerk user), GET 401
   (no JWT), GET 200 existing profile w/ name-mapped instruments, GET 200
   synthesized defaults, GET skips unmatched instrument row, GET 500 on DB
   error, PUT 400 invalid enum value, PUT 400 malformed/missing body, PUT 200
   update existing, PUT 200 upsert-create for new profile, PUT bio
   whitespace-to-null normalization (asserted on both the upsert payload and
   response), PUT 500 on upsert error, PUT 401 on missing JWT. Assertions use
   `toEqual` on the full response body rather than superficial checks, so
   they'd catch shape drift.

## Notes / non-blocking observations (no fix required)

- `updateProfile`'s `data` null-check (`if (error || !data)`) means a
  successful upsert that somehow returns no row would also produce a generic
  500 `INTERNAL` rather than a more specific error — acceptable per spec
  (upsert+`.maybeSingle()` with `onConflict: "user_id"` should always return a
  row on success) and already implicitly covered by the "500 on upsert error"
  test using `data: null`.
- The `as unknown as Database[...]["Insert"]` cast is a narrowly-scoped
  workaround for a known typing gap in the hand-written `Insert` type (not
  modeling the `created_at` DB default); spec explicitly permits this and
  forbids touching `lib/supabase/types.ts`, so this is intentional, not a
  defect.

## Files touched during testing

None. All existing coder-authored tests pass as-is; no additional tests were
needed to reach full coverage of the spec's named cases, so no files were
modified by the Tester.

## Conclusion

No failures found. The implementation matches the spec precisely, including
all named edge cases and both deliberate scoping decisions (missing-profile
tolerance on GET via synthesized defaults + upsert on PUT; instruments
read-only on PUT).

**Result: PASS. No blocking issues found. Ready for Reviewer.**
