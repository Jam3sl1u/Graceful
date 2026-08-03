# Review — Issue #70: Notification preferences API (BR-14 minimum-channel guard)

VERDICT: SHIP

Reviewed: `.pipeline/spec.md`, `.pipeline/changes.md`, `.pipeline/test-results.md`,
`git diff main...HEAD` (all 7 files), the untracked tester supplement, the PRD
(§6.9.1, §7 BR-14, §22.12), issue #70's acceptance criteria, the
`notification_preferences` migration, and its RLS policies.

## Independently re-run in this worktree

- `bun run lint` — clean.
- `bun run typecheck` — clean.
- `bun run test` — 83 suites / 1069 tests, 0 failures (matches test-results.md).
- `bun run test -- notification-preferences` — 29 tests across the two dedicated suites.

## Correctness — verified against source, not summaries

- **BR-14 is enforced on the merged state, before any write** (`handler.ts:150-158`),
  which is the only placement that catches the dangerous case (body disables the
  last enabled channel while the other two are already `false` in the DB). Both
  the direct and via-merge variants are tested, and the direct test asserts *no
  upsert is issued*, so the guard is load-bearing, not decorative — deleting it
  flips those tests to 200.
- **422 + `VALIDATION_FAILED` for the business-rule violation, 400 for shape
  failures** matches the repo convention (`church-group/members/[id]/role/handler.ts`,
  `events/handler.ts`, `songs/handler.ts`).
- **Defaults match the PRD table and the migration exactly** (invitation×3 true,
  reminder_sms true / reminder_email false, hours 24, setlist×2 true, gcal false).
- **`user_id` always comes from `ctx.userId`**, never the body; Zod strips unknown
  keys, and a body carrying `userId`/`id`/`chatPreference` is proven not to reach
  the payload. Combined with the existing user-scoped RLS
  (`user_id = auth_user_id()` on select/insert/update), a caller cannot read or
  retarget another user's row.
- **`chat_preference` is never selected or written**, so an existing row's value
  survives a PUT and a new row gets the DB default `'mentions'`. Confirmed in the
  shared `COLUMNS` constant, the upsert payload, and the hand-rolled Insert type
  (`Omit<Row,"id">` with no `chat_preference` field).
- **Upsert writes the complete merged row**, which also makes concurrent PUTs safe:
  the final state is always some single client's fully-validated view, so two
  interleaved partial updates cannot combine into a BR-14-violating state.
- **GET does not create a row** (synthesized defaults only) — asserted.
- `.select(COLUMNS)` uses `", "` separators; supabase-js strips whitespace and this
  matches every other handler in the repo, so no PostgREST issue.
- No migration, RLS, UI, or unrelated-route changes. Diff is exactly the 5 files
  the spec names plus the two pipeline artifacts. No scope creep.

## Tests — meaningful, not superficial

The coder's 22 tests assert the captured upsert payload and the `onConflict`
option, not just status codes, and assert *absence* of a write on the rejection
paths. The tester's 7 supplements close real gaps rather than padding: the coder's
fixture couples the pre-write select and post-upsert result to the same
`error`/`data` fields, so the upsert's own `error || !data` branch was never
isolated; the supplement isolates both halves, adds the inclusive `[1, 168]`
boundary values, adds the "no Clerk session at all" PUT variant, and drives the
real `route.ts` `GET`/`PUT` exports through the default `requireAuth` DB lookup.
That last one is the only test that proves the route wrapper is actually wired to
the handler. Failure cases (400 malformed/out-of-range, 401 no JWT and no session,
422 BR-14 ×2, 500 on select error, upsert error, and upsert-returns-nothing) are
all covered, and no error path leaks a driver message.

## Non-blocking notes for the human (no rework required)

1. `handler.ts:141` — `as unknown as ...["Insert"]` on the upsert payload. I
   verified the object literal *is* assignable to that Insert type on its own
   (unlike `app/api/profile/handler.ts`, whose cast is genuinely required because
   its Insert marks `created_at` required). If supabase-js's `upsert()` generic
   accepts it without the cast, dropping it would restore compile-time checking of
   the ten column names on the write path; today a snake_case typo there would only
   be caught by the payload assertion in the tests. The spec said to add the cast
   only if typecheck demanded it, and the inline comment justifies it by
   `chat_preference` rather than by a compiler error. Cosmetic, mitigated by tests.
2. PRD §14.1 (line 452) lists a "30 minutes" reminder lead-time option, which an integer
   `reminder_hours_before` column cannot represent; the spec consciously scoped that
   out and set the range to `[1, 168]`. When the settings UI lands, either the
   option list narrows to whole hours or the column needs a schema change. Flagging
   so it is a deliberate product decision, not a silent gap.
3. Defaults now exist in two places (SQL column defaults and
   `NOTIFICATION_PREFERENCE_DEFAULTS`). They agree today; a future migration that
   changes one must change the other.
4. Working-tree state at review time: the tester's supplement
   (`tests/unit/app/api/notification-preferences-route-tester-supplement.test.ts`)
   is untracked and `.pipeline/test-results.md` is modified but uncommitted. Both
   must be committed before the PR, or the PR ships without the supplemental tests.
5. An empty-body `PUT {}` still issues an upsert, so it will create a defaults row
   for a user who had none. Harmless and consistent with the spec, just noting the
   write is not a true no-op.
