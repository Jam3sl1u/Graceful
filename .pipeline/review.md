# Review — Issue #66: Sprint 3 E2E tests for setlist & calendar flows

VERDICT: BLOCK (original run — see post-review fix pass below)

## Post-review fix pass (2026-08-04)

Applied targeted fixes for MUST FIX items #1 and #2 below, plus NON-BLOCKING
items #4 and #5 (item #3 was already resolved on the branch before this
pass). This was a direct fix pass in response to this review's own findings,
not a fresh independent run of the Review stage — a human or the Review
stage should still re-verify before merge.

- **#1/#2** (`getByText` strict-mode collisions): added `{ exact: true }` to
  `tests/e2e/setlist-publish.spec.ts:94`, `:189` (`"Published"`), and `:133`
  (`"Confirmed"`) — the same option already used for every `getByRole(...,
  { name, exact: true })` call in these specs.
- **#4** (`try`/`finally` scope): hoisted `adminContext`/`memberContext`
  (`setlist-publish.spec.ts`, both tests) and `leaderContext`
  (`setlist-duplicate-song.spec.ts`) to `let` declarations above `try`, and
  moved their `.close()` calls into the existing `finally` blocks, matching
  `calendar-sync.spec.ts`'s established pattern. In
  `setlist-duplicate-song.spec.ts`, `.close()` was placed *after* the
  `setMemberRole(svc, "member")` restore, preserving the file's documented
  "restore role as the first `finally` statement" invariant (safe only
  because the suite is serialized, per the top-of-file comment).
- **#5** (doc mislabel): reworded `documentation/staging-environment.md` §7's
  `E2E_GOOGLE_CALENDAR_ID` row and the §7.1 intro paragraph — it is not part
  of `GOOGLE_SYNC_VARS`/the skip gate, it only sets the default calendar id.

Re-verified after the fixes: `bun run lint`, `bun run typecheck`, `bun run
test` (82 suites / 1051 tests, unchanged), and `bun run test:e2e` (1 passed /
10 skipped, same shape as the original run, no new failures). See
`.pipeline/test-results.md`'s "Post-review fix pass" section for details.

## Why (original BLOCK verdict)

The deliverable of this issue *is* the tests. Two of the four new specs
(`tests/e2e/setlist-publish.spec.ts`, both tests) contain assertions that are
**guaranteed to fail** the moment a human provisions the staging secrets — they
are Playwright strict-mode violations, not flakiness. Everything green so far
(lint / typecheck / 1051 Jest tests / "10 skipped, 1 passed" E2E run) only
proves the specs *skip* cleanly; nothing in the pipeline exercised a single
assertion inside them. This is exactly the "green tests are not correct
behavior" case.

I independently re-ran, in this worktree (`node_modules` was missing, so I ran
`bun install --frozen-lockfile` first):

| Check | Result |
|---|---|
| `bun run typecheck` | PASS |
| `bun run lint` | PASS |
| `bun run test` | PASS — 82 suites / 1051 tests |
| `bun run test:e2e` (no secrets) | 1 passed, 10 skipped — new specs skip cleanly, no collect-time errors |

and I empirically reproduced both failures below with a real Chromium +
Playwright `expect` against the exact DOM the components render.

## MUST FIX (blocking)

### 1. `getByText("Published")` resolves to 2 elements — both tests fail
`tests/e2e/setlist-publish.spec.ts:94` and `tests/e2e/setlist-publish.spec.ts:189`

`getByText(string)` defaults to `exact: false`, which is **case-insensitive
substring** matching (`playwright-core` builds `internal:text="Published"i`).
In the published state `app/(app)/setlists/[id]/setlist-builder.tsx` renders
both:

- the badge `<Badge>Published</Badge>` (line 398), and
- the locked banner `<p>This setlist is published and locked for editing.</p>`
  (line 404) — which contains "published".

Reproduced verbatim:

```
Error: strict mode violation: getByText('Published') resolved to 2 elements:
    1) <span>Published</span> aka getByText('Published', { exact: true })
    2) <p>This setlist is published and locked for editing.</p>
```

Fix: `getByText("Published", { exact: true })` (or scope to the header/badge).
Note test A asserts the locked-banner sentence on line 92, so both elements are
provably on the page at that point; test B renders the same banner after
publishing.

### 2. `getByText("Confirmed")` resolves to 2 elements — test A fails
`tests/e2e/setlist-publish.spec.ts:133`

`app/(app)/member-week/[id]/member-week-view.tsx` renders the `Confirmed`
badge (line 100 via `confirmationBadge`) **and**, when the team list is empty,
`<p>No confirmed team yet</p>` (line 262). The team list is derived from
`event_attendees` (`app/api/service-weeks/[id]/member-view/handler.ts:224`),
and this test creates no events — so the team is *always* empty here and the
"No confirmed team yet" paragraph is *always* present. Case-insensitive
substring matching makes `getByText("Confirmed")` match both.

Fix: `getByText("Confirmed", { exact: true })` (whole-string, case-sensitive —
"No confirmed team yet" then no longer matches).

While fixing 1 and 2, sweep the rest of the new specs for the same class of
bug. I checked the others: `"Draft"`, `"1 song"`, `"0 songs"`, the two modal
sentences, `"No songs added yet"`, `"Setlist not yet released"` and the
`getByRole(... exact: true)` locators are all unambiguous on the pages as
rendered today, but adding `exact: true` to the short, badge-like strings is
the cheap way to keep them that way.

### 3. The Testing stage's own new test file is not committed
`tests/unit/e2e-support/google.test.ts` is **untracked** (`git status` shows
`?? tests/unit/e2e-support/google.test.ts`), and `.pipeline/test-results.md` is
modified but uncommitted. That file is a real deliverable (the spec explicitly
assigned it to the Testing stage, and it is the only thing preventing silent
drift between `tests/e2e/support/google.ts` and `lib/google-calendar/`). It
must be committed before the PR, or the drift guard ships as nothing.

## SHOULD FIX (non-blocking)

4. **Browser contexts are closed inside `try`, not `finally`** —
   `tests/e2e/setlist-publish.spec.ts` (lines 96, 134, 191, 222) and
   `tests/e2e/setlist-duplicate-song.spec.ts:74`. Spec edge case 5 explicitly
   requires the `context.close()` calls to be in `finally`; as written, any
   failing assertion (including the two above) leaks the context for the rest
   of the worker. `calendar-sync.spec.ts` does this correctly — copy that
   shape.

5. **`documentation/staging-environment.md` §7 table mislabels
   `E2E_GOOGLE_CALENDAR_ID`** as "optional — `calendar-sync.spec.ts` skips when
   absent". It is *not* in `GOOGLE_SYNC_VARS`; the spec does not skip when it is
   absent, it defaults to `primary` (the same row then says so, contradicting
   itself). Drop the "skips when absent" clause on that one row.

## What is good (verified, not taken on trust)

- Scope is respected: the feature commit touches only `tests/`,
  `.github/workflows/ci.yml`, `documentation/staging-environment.md` and
  `.pipeline/`. No `app/`, `lib/`, `schemas/`, `components/`, or
  `supabase/migrations/` changes — confirmed against `git show --stat 9cb333b`.
  (The larger `main...HEAD` diff is the already-merged #64/#65 work, not this
  issue.)
- Gating is correct: `REQUIRED_VARS` untouched; `googleSyncEnabled` via
  `checkEnv(GOOGLE_SYNC_VARS)`; both `test.skip(...)` calls are the first
  statement in their `describe`; verified all four new tests skip with no
  import-time errors.
- Fixture helpers match the DB: `songs` (`created_by` FK, `default_key
  varchar(5)`), `users` (`clerk_id varchar(50)` — the 46-char synthetic id
  fits; `anonymized_at` exists via `20260710000001_member_removal_rpc.sql`),
  `google_calendar_tokens` (`is_valid` added by
  `20260716000001_google_calendar_sync.sql`). Teardown order is FK-safe and the
  `userIds` branch is correctly fenced with a comment.
- `tests/e2e/support/google.ts` duplicates match their sources byte-for-byte
  (`encryptToken` format `iv:authTag:ciphertext`, 12-byte IV, 32-byte key;
  `toGoogleEventId`), imports nothing from `lib/`/`app/`, and never logs a
  token or secret. The tester's `google.test.ts` machine-verifies both against
  the real `lib/` implementations — genuinely meaningful coverage, not
  superficial.
- API contract assertions are right: `POST /api/service-weeks/:id/setlist`
  asserted via `res.ok()` (200-or-201 get-or-create), `POST
  /api/setlists/:id/songs` 201 then 409 `{ error, code: "CONFLICT" }` matching
  `app/api/setlists/[id]/handler.ts:344/362` and `lib/api/response.ts`,
  `POST /api/events` 201 / `POST /api/events/:id/attendees` 201, `PUT
  /api/events/:id` accepts the partial body (`updateEventSchema` is all-optional).
- `calendar-sync.spec.ts` is well constructed: attendee-POST as the real
  create-propagation trigger, BR-10-safe timestamps, `expect.poll` (never
  `waitForTimeout`) for both create and update, `summary`/`location`/
  `start.dateTime` assertions that match `upsertCalendarEvent`'s payload
  (`lib/google-calendar/sync.ts:81`), and a fully failure-tolerant `finally`
  with both app-side DELETE and a direct Google delete.
- The OPEN QUESTION 1 resolution (assert notification recipients, not read
  visibility) is correctly reasoned and correctly documented in the spec header
  comment; it does not paper over the AC/behavior mismatch.

## Re-review scope

Fix items 1–3 (and ideally 4–5), re-run `bun run lint`, `bun run typecheck`,
`bun run test`, `bun run test:e2e`, and re-submit. Note that items 1 and 2
still cannot be proven green without staging secrets — the reviewer's
reproduction above is the evidence, so the fix should be locator-level and
obviously correct by inspection.
