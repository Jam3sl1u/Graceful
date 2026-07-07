# Review — Issue #31: Instrument list management (default + custom)

## VERDICT: SHIP

## Scope of change (verified via `git diff main...HEAD`)
Single commit `94004ee`. Touches only expected files: `schemas/instruments.ts`,
`app/api/instruments/handler.ts` (new), the 4 route delegators, the new test file,
plus the two `.pipeline/` docs. No stray edits, no changes to `lib/supabase/types.ts`,
no new migrations. Beacon/network scan of all touched files: clean (no `fetch`,
external URLs, or telemetry — relevant given the repo's recent rogue-beacon incidents).

## Correctness vs spec
- `createInstrumentSchema`: `z.string().trim().min(1).max(100)` — matches spec and `varchar(100)`.
- `listInstruments`: requireAuth only, group-scoped, ordered `is_default desc, name asc`,
  empty array when none, `pending = !isDefault` mapping correct.
- `addInstrument`: admin-gated, 400 validation, case-insensitive group-scoped duplicate
  guard (409), `is_default: true`, `created_by: ctx.userId`, 201.
- `submitCustomInstrument`: open to any member, identical guard, `is_default: false`, 201.
- `promoteInstrument` / `deleteInstrument`: admin-gated, id + church_group_id scoping,
  empty result -> 404 (cross-tenant == missing, intentional), idempotent promote.
- All routes are thin delegators; both dynamic routes `await params` (Next 15).
- Tenant isolation enforced in-handler via `requireRole` since RLS is tenant-only — matches spec.

## Tests
Meaningful, not superficial: assert status + error `code`, capture and assert insert/update
payloads (`is_default`, `created_by`, `church_group_id`), verify `getSupabaseClient` is NOT
called on early auth/validation returns, and cover case-insensitive duplicate both directions.
Per-operation fixture harness correctly isolates select/insert/update/delete on the same chain.
94/94 tests pass.

## Independent re-run
- `bun run lint`: pass (0/0)
- `bun run typecheck`: pass
- `bun run test`: 9 suites / 94 tests pass

## Non-blocking observations
- In `addInstrument`/`submitCustomInstrument` the body-parse (400) runs before the JWT
  check (401). If a request had both a bad body and no JWT it returns 400 rather than 401.
  Immaterial to security/correctness; not worth a revision.

No correctness, security, or performance issues found. Ship it.
