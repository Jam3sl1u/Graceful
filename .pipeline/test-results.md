# Test Results — Issue #31: Instrument list management (default + custom)

## Verdict: PASS

## What was independently verified

### 1. Static checks (re-run from scratch, not trusted from changes.md)
- `bun install` — clean, no changes.
- `bun run lint` (`eslint .`) — **passes**, 0 errors/warnings.
- `bun run typecheck` (`tsc --noEmit`) — **passes**, 0 errors.
- `bun run test` (`jest`) — **passes**: 9 suites, 94 tests (89 original + 5 tests I
  added below), 0 failures.
- `bun x prettier --check` on the touched files (`schemas/instruments.ts`,
  `app/api/instruments/handler.ts`, all 4 route files, the test file) — all clean.
  Confirmed the repo-wide `bun run format:check` failure is pre-existing drift in
  unrelated files (`app/api/_examples/admin-only/handler.ts`,
  `app/api/church-group/members/handler.ts`, `README.md`, `tsconfig.json`,
  `tests/integration/rls/**`, `tests/unit/app/api/church-group-members-route.test.ts`)
  — none of these were touched by this change, matching the coder's claim.

### 2. Code review against spec (`.pipeline/spec.md`)
Read `schemas/instruments.ts`, `app/api/instruments/handler.ts`, and all 4 route
files line-by-line against the spec's prescribed code. They match essentially
verbatim:
- `createInstrumentSchema`: `z.string().trim().min(1).max(100)` — correct.
- `listInstruments`: `requireAuth` only, no role gate, correct `.select().eq().order().order()` shape, 500 on error, `ok({ instruments: (data ?? []).map(...) })` — empty array when none.
- `addInstrument` / `submitCustomInstrument`: correct duplicate guard (case-insensitive, group-scoped, re-reads all names), correct `is_default` value per path (`true` for admin add, `false` for custom), `created_by: ctx.userId`, 201 on success.
- `promoteInstrument` / `deleteInstrument`: `id` scoped by `.eq("id", id).eq("church_group_id", ctx.churchGroupId)`, empty result array → 404 NOT_FOUND, admin-gated via `requireRole(ctx, ["admin"])`.
- All 4 route files are thin delegators; both dynamic routes correctly `await params` (Next 15 async dynamic API).
- `lib/api/response.ts` / `lib/api/auth.ts` cross-checked: `ok`/`fail` envelope shape (`{data}` / `{error, code}`), `requireAuth` throws `ApiException(UNAUTHENTICATED, 401)`, `requireRole` throws `ApiException(FORBIDDEN, 403)` — both caught by each handler's shared catch block, exactly as claimed.
- Confirmed via `git show --stat HEAD` that the committed diff touches only the files changes.md claims (schema, handler, 4 routes, test file) — no stray edits.

### 3. Test-suite review + gaps I filled in independently
The coder's `tests/unit/app/api/instruments-route.test.ts` (23 tests) is thorough
and uses a per-table/per-operation fixture harness that correctly isolates
`select`/`insert`/`update`/`delete` results. I ran it as-is first (passed), then
identified two edge cases from the spec's explicit "Edge cases" list that weren't
covered, and added 5 tests to close them (all passing, no code changes needed —
these confirm existing behavior, they didn't uncover bugs):

1. **"name longer than 100 chars → 400"** (spec line 181) — not previously tested.
   Added: 101-char name → 400 VALIDATION_FAILED, and a boundary check that exactly
   100 chars is accepted (201).
2. **`submitCustomInstrument` failure paths** — the admin `addInstrument` path had
   401/500-on-insert tests but the sibling `submitCustomInstrument` path didn't.
   Added: 401 UNAUTHENTICATED (no JWT), 500 INTERNAL (insert error), and 500
   INTERNAL (duplicate-guard read error) for the custom-submit path.

All 5 new tests pass against the existing implementation — no code changes were
needed; they close coverage gaps, not correctness bugs.

## Manual reasoning checks
- Confirmed the "id from another church group is indistinguishable from a missing
  id → 404" claim is consistent with the RLS/handler design: the `.eq("id",
  id).eq("church_group_id", ctx.churchGroupId)` filter is the only way tenant
  scoping is enforced for promote/delete, since RLS itself is tenant-scoped only
  (not role-gated), matching spec's "Current state" section.
- Confirmed `pending = !isDefault` mapping in `toInstrumentResponse` matches spec's
  OPEN QUESTIONS decision #2 exactly.
- Confirmed no changes to `lib/supabase/types.ts` and no new migrations (out of
  scope per spec) — verified via `git show --stat`.

## Final numbers
- `bun run lint`: pass
- `bun run typecheck`: pass
- `bun run test`: 9 suites / 94 tests pass (89 pre-existing + 5 added by tester)
- Prettier on touched files: pass

## Files touched during testing
- `tests/unit/app/api/instruments-route.test.ts` — added 5 tests (see above).
  No production code was modified.

No failures found. Recommend proceeding to Reviewer.
