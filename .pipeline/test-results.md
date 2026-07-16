# Test Results — Issue #63: iCal (.ics) export fallback

This overwrites the stale `test-results.md` for issue #62 that was still
sitting at this path (per AGENTS.md, `.pipeline/` files reflect only the most
recent run).

## Verdict: ALL PASS

`bun run lint`, `bun run typecheck`, and `bun run test` were re-run
independently (not trusted from `.pipeline/changes.md`):

- `bun run lint` (eslint .) — 0 errors.
- `bun run typecheck` (tsc --noEmit) — 0 errors.
- `bun run test` (Jest, full suite including new tests below) — **77 suites /
  968 tests passed**, 0 failures. Coder's baseline was 75 suites / 960 tests;
  this stage added 2 suites / 8 tests, all passing, no other file touched.

## What I independently verified (beyond re-running the coder's own suite)

I read `lib/ical/generate.ts`, `app/api/events/[id]/ics/handler.ts`,
`app/api/events/[id]/ics/route.ts`, `app/api/events/ics/handler.ts`,
`app/api/events/ics/route.ts`, and both of the coder's own test files
(`tests/unit/lib/ical/generate.test.ts`,
`tests/unit/app/api/events-ics-route.test.ts`) against `.pipeline/spec.md`.
The coder's own suite is thorough and all of it passes unmodified. I then
added two new `*-tester-supplement.test.ts` files (matching this repo's
existing convention for tester-added coverage, e.g.
`events-id-attendees-route-tester-supplement.test.ts`) targeting the exact
"What the Tester should focus on" list in `.pipeline/changes.md`, plus one
case the coder's suite structurally could not reach.

### `tests/unit/lib/ical/generate-tester-supplement.test.ts` (3 new tests)
- **Multi-byte UTF-8 fold safety.** The coder's own `foldLine` tests only use
  repeated ASCII (`"x"`/`"A"`), which can never exercise the "back off while
  the next byte is a UTF-8 continuation byte" branch. I forced folds
  mid-character using 4-byte emoji and 3-byte CJK text, and confirmed every
  physical line is valid, round-trippable UTF-8 (no `U+FFFD` replacement
  characters introduced) and that de-folding reconstructs the exact original
  string. **Pass** — the byte-boundary backoff logic is correct.
- **Escape-then-fold ordering.** Built a long description containing `,` `;`
  `\` and embedded newlines, ran it through the real `generateIcs`, and
  confirmed the folded+rejoined DESCRIPTION value equals `escapeIcsText`
  applied once to the whole raw string — i.e. escaping happens on the full
  value before folding, not per-chunk after folding (which would risk
  double-escaping or corrupting an escape sequence at a chunk boundary).
  **Pass.**

### `tests/unit/app/api/events-ics-route-tester-supplement.test.ts` (5 new tests)
- **Attendee-scoping distinction** (changes.md focus item #1). For both
  endpoints, built a Supabase mock where `event_attendees` returns "not
  assigned"/"zero rows" while an `invitations` table (if ever queried) would
  wrongly grant access. Asserted `supabase.from(...)` is **never** called
  with `"invitations"` and that both endpoints still return 404. This
  confirms — in the actual code, not just the coder's documentation claim —
  that both handlers are genuinely scoped to the #60 attendee model and
  cannot be satisfied by an invitation alone. **Pass.**
- **End-to-end escaping** (focus item #3). Fed a DB row with `,` `;` `\` and
  embedded `\n`/`\r\n` in `name`/`location`/`notes` through the real
  `exportEventIcs` handler (not just the pure generator) and asserted the
  escaped forms appear correctly in the response body. **Pass.**
- **End-to-end long-notes folding** (focus item #4). Fed a >75-octet `notes`
  value through the real handler, confirmed the DESCRIPTION line folds with
  a continuation line, and that every physical line in the entire response
  body respects the 75-octet limit. **Pass.**
- **Genuine failure case beyond "Supabase returned an error object".** Fed a
  malformed `start_time` (`"not-a-real-date"`) through the real handler.
  `new Date(...).toISOString()` throws a `RangeError` inside `generateIcs`,
  which is not a Supabase-error-shaped failure and is not exercised anywhere
  in the coder's own suite (which only tests `{ error: {...} }` responses
  from Supabase). Confirmed the handler's outer `try/catch` still turns this
  into a well-formed `500 INTERNAL` response rather than an unhandled
  exception or a corrupted 200 body. **Pass.**

All 8 new tests pass against the existing implementation as-is — no code
changes were needed or made.

## Spec cross-check (no discrepancies found)

- CRLF everywhere + trailing CRLF: confirmed by the coder's own tests and
  re-verified independently in the end-to-end folding supplement test
  (byte-length check over every non-empty line of a real handler response).
- 404 (never a 200-with-empty-calendar) on zero assigned events, and on
  `serviceWeekId` matching none of the caller's events: present in the
  coder's suite; re-read the handler logic directly and it matches spec
  Decision 2 exactly (both the zero-attendee-rows short-circuit and the
  post-filter empty-result check return the same 404).
- No role gate on either endpoint: confirmed — neither handler calls
  `requireRole`, matching the spec's "any authenticated member" scope.
- No new dependency added: `bun.lock` is unmodified; `git status` shows only
  the files listed in `changes.md` plus the two new test files added by this
  stage.
- No UI added or wired: confirmed no changes under `app/(app)/member-week/`
  or any other app route.

## Files added by this stage (Testing)

- `/Users/jamesliu/Documents/Graceful/.claude/worktrees/issue-63/tests/unit/lib/ical/generate-tester-supplement.test.ts`
- `/Users/jamesliu/Documents/Graceful/.claude/worktrees/issue-63/tests/unit/app/api/events-ics-route-tester-supplement.test.ts`

No implementation files were modified. Ready for Review.
