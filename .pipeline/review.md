# Review — Issue #77: [Sprint 4] Audit input validation (Zod) across all Phase 1 routes

VERDICT: SHIP

Reviewed: `.pipeline/spec.md`, `.pipeline/changes.md`, `.pipeline/test-results.md`,
`git diff main...HEAD`, the six untracked new test files, and the surrounding
source I needed to check the claims independently.

## Independently re-run verification

```
bun run lint       # clean
bun run typecheck  # clean
bun run test       # 88 suites / 1099 tests, all passing
```

1099 − 1051 = 48 new cases, which matches the per-file count I did by hand
(8 + 8 + 12 + 7 + 7 + 6). The Testing stage's numbers are honest.

## Does the code match the spec?

Yes, exactly, and nothing beyond it. `git diff main...HEAD --stat` touches only
the nine files the spec's "Files touched" list names, plus the two `.pipeline/`
artifacts. I checked each of the four changes against the spec text:

- **Change 1 (PostgREST injection)** — `lib/api/postgrest.ts` is pure, has no
  `server-only` import, and escapes `\` *before* `"`, which is the ordering that
  actually matters (quote-first would turn a trailing `\"` into `\\"`, leaking an
  unescaped quote). `listSongs` wraps both `ilike` terms in double quotes and
  passes the escaped value. I grepped `app/**` and `lib/**` for `.or(`,
  `.filter(`, `.ilike(`, `.like(`, `textSearch`, and backtick-templates passed to
  `select/eq/in/match/order` — the fixed line in `app/api/songs/handler.ts:74` is
  the only interpolation site in either tree. AC 3 holds.
- **Change 2 (unbounded strings)** — the three caps are in place with the
  rationale comments; no pre-existing limit was altered. I re-ran the audit
  myself: `grep 'z\.string()' schemas/*.ts` minus `.max()`/`uuid`/`datetime`/
  `regex`/`email`/`url` leaves only `schemas/availability.ts` `date`/`startDate`/
  `endDate`, and those are constrained to 10 chars in practice by
  `isValidDateString`'s `^\d{4}-\d{2}-\d{2}$` in the `superRefine`. So the
  "everything else is bounded" claim holds for string fields.
- **Change 3 (OAuth callback query schema)** — `safeParse` +
  `Object.fromEntries(searchParams)`, failure returns `redirectError()`, never
  `fail(...)`. I traced the whole function: the `null` → `undefined` change for
  absent params is harmless (`if (error)` and `if (!code || !state)` behave
  identically), and `?code=` empty-string still lands on the same redirect (now
  via `min(1)` instead of the falsy guard). The `state` cap of 512 is safe —
  `connect/handler.ts` mints `randomBytes(32).toString("base64url")`, i.e. 43
  chars. Nothing anywhere still imports the deleted `googleCalendarSchema` /
  `GoogleCalendarInput` (grepped repo-wide).
- **Change 4 (invitation `:id`)** — `denyInvitation` validates first inside the
  `try`, which does cover both the token and in-app branches;
  `withdrawInvitation` validates after `requireAuth`/`requireRole`, so 401/403
  still precede 400.
- **Change 5 (audit record)** — I machine-diffed the inventory table against
  `find app/api -name route.ts`: **57 files listed, 57 files on disk, exact
  match, no omissions**. The `notImplemented` claim checks out (10 stub files:
  5 notifications, 4 webhooks, `GET /api/church-group`). The RPC list matches
  `grep -o 'rpc("[a-z_]*"'` exactly — same 12, no more, no fewer. The coder also
  corrected the spec's own "58 files" estimate to the real 57 and said so.

## Are the tests meaningful?

Mostly yes, and several are genuinely adversarial rather than decorative:

- `tests/unit/lib/api/postgrest.test.ts` includes the backslash-before-quote
  ordering case, which is the one case a naive implementation gets wrong. That
  test would fail if someone "simplified" the two `.replace()` calls into the
  wrong order.
- `songs-search-injection-tester-supplement.test.ts` doesn't just assert a
  string equality — it regex-parses the emitted filter, asserts exactly two
  `ilike` clauses, and asserts that reversing the escaping recovers `q` byte for
  byte. That is a real breakout test.
- `service-weeks`/`events` schema tests cover both sides of the boundary (200/201,
  2000/2001) plus a 2MB payload, and confirm `min(1)`/`nullish()`/`optional()`
  were not disturbed.
- `google-calendar-callback-validation-*` proves `exchangeCode` is never reached
  and that the response is a redirect with no JSON content-type.
- `invitations-id-param-validation-*` asserts the 401 → 403 → 400 ordering on
  withdraw and that no Supabase client / RPC is constructed on the 400 path.

One weak test, not worth blocking on: "redirects to error when error exceeds 200
chars" passes identically before and after the change (any truthy `error` already
short-circuited to `redirectError()`), so it does not discriminate the fix. The
oversized-`state` test *does* discriminate, because the cookie is set to the same
513-char value, so pre-fix it would have proceeded to `exchangeCode`.

## Findings

### Must do before merge (process, not code)

1. **The six new test files are untracked.** `git status` shows
   `tests/unit/lib/api/postgrest.test.ts`,
   `tests/unit/schemas/service-weeks.test.ts`,
   `tests/unit/schemas/events-notes-max-tester-supplement.test.ts`,
   `tests/unit/app/api/songs-search-injection-tester-supplement.test.ts`,
   `tests/unit/app/api/google-calendar-callback-validation-tester-supplement.test.ts`,
   `tests/unit/app/api/invitations-id-param-validation-tester-supplement.test.ts`
   as `??`, and `.pipeline/test-results.md` as modified. The only commit on this
   branch (`7f22d48`) contains **none** of the Testing stage's tests. Commit them
   before opening/updating the PR or the entire test deliverable is lost.

### Non-blocking, worth a human's eyes

2. **The PostgREST quoting fix is verified only against mocks.** Every test
   asserts on the *string handed to a jest mock* `.or()`; nothing in this repo
   exercises `title.ilike."%…%"` against a live PostgREST. The syntax is correct
   per PostgREST's reserved-character rules (double-quoted values, `\"` and `\\`
   escapes inside them, `%`/`*` wildcard handling unaffected by quoting), and
   `tests/integration/rls/` has no song-search coverage to extend cheaply. Still:
   if this form were rejected, `GET /api/songs?q=…` would 500 in production and
   the green unit suite would not notice. Suggest one manual `curl` against a dev
   Supabase before merge, or a follow-up integration test.
3. **`denyInvitation` now returns 400 before 401/403 on the in-app branch.** The
   spec mandated this ordering (it is the only way to cover the tokenless branch
   with one check), but it inverts the "auth before validate" convention the same
   spec lists in its own patterns table and that `withdrawInvitation` follows. No
   information is disclosed — the id is entirely caller-supplied — so this is a
   consistency nit, not a security issue. Flagging it so it is a conscious choice.
4. **`Object.fromEntries(searchParams)` takes the last duplicate; `.get()` took
   the first.** A `?code=a&code=b` now resolves to `b` instead of `a`. Both are
   schema-bounded and Google does not send duplicates, so impact is nil, but it is
   a real (undocumented) behavior delta introduced by this diff.
5. **Audit gap the record does not mention: unbounded array cardinality.**
   `reorderSetlistSchema.songs` is `z.array(...)` with no `.max()`, unlike
   `setAvailabilitySchema.entries` (`.min(1).max(400)`), which sets the repo
   precedent. Practical impact is limited — `PUT /api/setlists/:id` rejects any
   body whose song set does not exactly match the stored setlist, so an oversized
   array 400s before the per-row update loop — but a validation *audit* should say
   so rather than be silent. Suggest adding a line to the audit record or filing a
   follow-up alongside the already-documented blanket-`:id` gap.
6. **`.max(200)` on `sermonTopic`/`sermonScripture` is a tightening on live data.**
   Nothing in `app/`/`components/` renders these fields yet (grepped), so there is
   no client/server `maxLength` mismatch, but any pre-existing row over 200 chars
   would now fail a PUT. Low risk for a Sprint-4 app; noted for completeness.

## Bottom line

The diff is small, correct, matches the spec line for line, and the audit record
is the rare kind that survives being machine-checked against the repo. Items 3–6
are observations for a human, not defects. Item 1 is the only thing that has to
happen before this ships.
