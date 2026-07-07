# Review — Issue #30: Member profile CRUD (`GET`/`PUT /api/profile`)

## VERDICT: SHIP

## Summary
The implementation faithfully matches the spec. Independently re-ran `bun run lint`,
`bun run typecheck`, and `bun run test` — all green (8 suites / 66 tests, incl. 13 new).
Read every source/test file firsthand rather than trusting the summaries.

## What was verified
- **schemas/profile.ts** — matches spec verbatim: `vocalCapability` enum + trimmed,
  2000-cap, nullish `bio` normalized to `null`.
- **app/api/profile/handler.ts** — correct auth→JWT→RLS-client flow mirroring the
  members handler. `getProfile` returns synthesized defaults on missing row and does
  NOT query instruments in that branch (early return confirmed). `updateProfile` upserts
  on `user_id`, sets only `user_id`/`vocal_capability`/`bio` (no `id`/`created_at`/
  `updated_at`). `loadInstruments` group-scopes via `ctx.churchGroupId` and skips
  unmatched instruments. Single try/catch converts `ApiException`→`fail`, else 500.
- **route.ts** — thin delegators, as specified.
- **Test file** — all 13 spec-listed cases present; assertions use `toEqual` on full
  response bodies and capture the upsert payload, so they'd catch shape drift. Not
  superficial.
- **Security** — ownership enforced by RLS (`user_id = auth_user_id()`) + query scoped
  to `ctx.userId`; no `:id` param; `member_instruments` never written (deferred to #31).
- **Scope** — only `app/api/profile/*`, `schemas/profile.ts`, and the test file changed.
  No migrations, no `lib/supabase/types.ts` / `types/domain.ts` edits. Scanned the source
  diff for network/exec/beacon patterns — none found.

## Non-blocking observations (no fix required)
- PUT validates the body (400) before the JWT check (401). This is the exact order the
  spec prescribes; acceptable.
- `as unknown as ...Insert` cast is a narrow, spec-sanctioned workaround for the
  hand-written `Insert` type modeling `created_at` as required. No `created_at` is sent
  at runtime (asserted by the payload test).
- `if (error || !data)` on the upsert collapses a "success but no row returned" case into
  a generic 500; with `onConflict` + `.maybeSingle()` this shouldn't occur in practice.

Green tests here reflect genuinely correct behavior. Ship it.
