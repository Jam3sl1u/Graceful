# Changes — Issue #31: Instrument list management (default + custom)

## Files changed

### `schemas/instruments.ts` (rewritten)
- Replaced the `z.object({})` placeholder with `createInstrumentSchema`:
  `name` — trimmed, `min(1)`, `max(100)` (matches the `varchar(100)` column). Used by
  both `POST /api/instruments` and `POST /api/instruments/custom`.
- Exports `CreateInstrumentInput` inferred type.

### `app/api/instruments/handler.ts` (new)
Single shared handler module, mirroring `app/api/profile/handler.ts` (JWT/`requireAuth`
flow, try/catch → `ApiException` mapping, `as unknown as ...Insert`/`...Update` casts)
and `app/api/_examples/admin-only/handler.ts` (`requireRole(ctx, ["admin"])`).

- `toInstrumentResponse` (private): maps a DB row to `InstrumentResponse`
  (`{ id, name, isDefault, pending, createdBy }`), with `pending = !isDefault`.
- `listInstruments(req, lookup?)` — any authenticated member (`requireAuth` only).
  Queries `instruments` scoped to `ctx.churchGroupId`, ordered `is_default desc, name
  asc`. Empty array when none. 500 on query error.
- `addInstrument(req, lookup?)` — admin only (`requireRole(ctx, ["admin"])`). Parses
  body with `createInstrumentSchema` (400 `VALIDATION_FAILED`), runs the
  case-insensitive duplicate guard (409 `CONFLICT`), inserts with `is_default: true`,
  `created_by: ctx.userId`. Returns 201.
- `submitCustomInstrument(req, lookup?)` — any authenticated member. Same body parse
  + duplicate guard as `addInstrument`; inserts with `is_default: false`. Returns 201.
- `promoteInstrument(req, id, lookup?)` — admin only. Updates `is_default: true` for
  the row matching `id` + `ctx.churchGroupId`. Empty result → 404 `NOT_FOUND`
  (covers both "doesn't exist" and "belongs to another group", since the
  `church_group_id` scoping makes them indistinguishable — this is intentional per
  spec). Idempotent (re-promoting an already-default instrument still 200s).
- `deleteInstrument(req, id, lookup?)` — admin only. Deletes the row matching `id` +
  `ctx.churchGroupId`. Empty result → 404 `NOT_FOUND`. Returns `{ deleted: true }`.
  FK cascade (`member_instruments.instrument_id ON DELETE CASCADE`) handles cleanup
  with no extra handler work.
- Duplicate guard (private, inlined in both insert paths, per spec — not factored
  into a shared helper function since the spec showed it inline): re-reads all
  `name`s for the group and does a case-insensitive `.trim().toLowerCase()`
  comparison before inserting.
- `id` is passed as an explicit parameter to `promoteInstrument`/`deleteInstrument`
  (not read from the route's dynamic segment inside the handler) so unit tests can
  call the handlers directly, matching the `profile`/`members` handler test pattern.

### `app/api/instruments/route.ts`, `app/api/instruments/custom/route.ts`,
### `app/api/instruments/[id]/route.ts`, `app/api/instruments/[id]/promote/route.ts`
- All four rewritten from `notImplemented` (501) stubs to thin delegators to the new
  handler functions. The two dynamic routes (`[id]/route.ts`, `[id]/promote/route.ts`)
  `await params` per Next.js 15's async dynamic APIs before calling the handler.

### `tests/unit/app/api/instruments-route.test.ts` (new)
- Mocks `@clerk/nextjs/server` (`auth`) and `@/lib/supabase/client`
  (`getSupabaseClient`), following the harness pattern from `profile-route.test.ts` /
  `church-group-members-route.test.ts`.
- `makeSupabaseClient(overrides, hooks?)` fixture builder: fixtures are keyed per
  table **and per operation** (`select` / `insert` / `update` / `delete`) so a test
  can, e.g., override only the duplicate-check `select` result without accidentally
  changing the `insert` result the same call chain returns later (an early version of
  this harness applied one override to all four operations, which silently corrupted
  unrelated assertions — fixed before landing). `makeChain(result)` returns a
  thenable object exposing `.eq`/`.order`/`.select`/`.single`, all chainable, covering
  every call shape used by the handler: `.select().eq().order().order()` (list),
  `.select().eq()` (duplicate-guard read), `.insert().select().single()`,
  `.update().eq().eq().select()`, `.delete().eq().eq().select()`.
- 23 tests covering: `GET` 200 (ordered list, `pending` flag correct for default vs.
  custom rows) and 200 empty; `POST /api/instruments` 201 (`is_default: true`,
  captures insert payload), 403 non-admin, 400 empty/whitespace name, 400 malformed
  body, 409 case-insensitive duplicate, 401 no JWT, 500 on insert error;
  `POST /api/instruments/custom` 201 (`is_default: false`, allowed for a plain
  member), 400 empty name, 409 duplicate; `promote` 200 (idempotent-shaped, captures
  update payload), 404 missing id, 403 non-admin, 500 on update error; `delete` 200
  `{ deleted: true }`, 404 missing id, 403 non-admin, 401 no JWT, 500 on delete error.

## Verification
- `bun run lint` — passes.
- `bun run typecheck` — passes.
- `bun run test` — all 9 suites / 89 tests pass (23 new for this route).
- `bun run format:check` (on the touched files only) — passes; the rest of the repo
  had pre-existing Prettier drift unrelated to this change, left untouched.

## What the Tester should focus on
- The duplicate guard is intentionally a spec-driven addition (schema has no unique
  constraint on `(church_group_id, name)` — see spec OPEN QUESTIONS #1). Confirm the
  409 path only triggers on case-insensitive, group-scoped matches.
- `promote`/`delete` 404 semantics: an id from another church group is
  indistinguishable from a missing id (both resolve to an empty result array from the
  `.eq("church_group_id", ...)` scoping) — this is intentional, not a bug.
- `listInstruments` and `submitCustomInstrument` are open to any authenticated
  member (no `requireRole`); `addInstrument`, `promoteInstrument`, `deleteInstrument`
  are admin-only.
- Out of scope, not touched: `lib/supabase/types.ts`, member-profile instrument
  selection (`member_instruments` writes, #30's territory), transposition logic,
  seeding defaults, and no new DB migrations were added.
