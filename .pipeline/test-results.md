# Test Results — Issue #77: [Sprint 4] Audit input validation (Zod) across all Phase 1 routes

## Verdict: PASS

All verification commands pass, and all newly-added independent tests
(happy path, spec-named edge cases, and failure cases) pass.

## Verification commands (re-run independently from `.pipeline/changes.md`'s claims)

```
$ bun run lint
$ eslint .
(clean, no warnings/errors)

$ bun run typecheck
$ tsc --noEmit
(clean, no errors)

$ bun run test
Test Suites: 88 passed, 88 total
Tests:       1099 passed, 1099 total
```

Before adding new tests, I also ran the pre-existing suite in isolation to
confirm the Coder's claim of "82 suites / 1051 tests, all passing" —
confirmed exactly (82 suites, 1051 tests, all green), including the single
intentionally-changed assertion in `tests/unit/app/api/songs-route.test.ts:186`
and the unmodified `tests/unit/app/api/google-calendar-callback-route.test.ts`.

## Code review of the diff (independent read, not just trusting changes.md)

Read every changed/created file directly and confirmed it matches spec.md:
- `lib/api/postgrest.ts` — pure function, escapes `\` before `"`, no
  `server-only` import, matches the spec's exact signature/doc comment.
- `app/api/songs/handler.ts` — `listSongs` now escapes `q` and wraps both
  `ilike` terms in double quotes; rest of the function unchanged.
- `schemas/service-weeks.ts` / `schemas/events.ts` — `.max(200)` /
  `.max(2000)` added exactly where the spec said, with the required rationale
  comments, no other limits touched.
- `schemas/google-calendar.ts` — placeholder replaced with the real
  `googleCalendarCallbackQuerySchema` (code/state/error, matching
  min/max bounds from the spec).
- `app/api/google-calendar/callback/handler.ts` — validates query params via
  `safeParse`, redirects (never `fail(...)`) on failure; rest of the control
  flow (error short-circuit, code/state guard, CSRF check, upsert,
  best-effort sync) is untouched.
- `schemas/invitations.ts` / `app/api/invitations/handler.ts` —
  `invitationIdParamSchema` added; `denyInvitation` validates `id` as the
  first statement in the `try` (covers both the token and in-app branches);
  `withdrawInvitation` validates `id` after `requireAuth`+`requireRole`
  (401/403 still precede 400). Matches spec exactly.

No scope creep found: `git status --porcelain` before I added tests showed
no uncommitted changes beyond what `.pipeline/changes.md` describes, and the
"Explicitly OUT of scope" items (blanket `:id` validation, rate limiting,
`schemas/notifications.ts`, the two inline `targetIdSchema` helpers,
`lib/supabase/types.ts`/RLS/migrations) were left untouched.

## New tests added (6 files, 48 new test cases, all passing)

All added under `tests/unit/`, following this repo's existing Jest
conventions (`jest.mock`, `makeReq`/`makeLookup`/`setUpAuth` helper patterns
copied from sibling test files). No existing test file was modified.

1. **`tests/unit/lib/api/postgrest.test.ts`** (8 tests) — unit tests for
   `escapePostgrestFilterValue`: plain string unchanged, quote escaped,
   backslash escaped, the tricky "backslash immediately before a quote"
   ordering case (escaping backslash first is required or the result would
   let a quote leak through unescaped), reserved-but-not-special chars
   (`,().`) left alone, wildcards (`%`, `*`) untouched, empty string, and a
   value with multiple quotes/backslashes.

2. **`tests/unit/app/api/songs-search-injection-tester-supplement.test.ts`**
   (8 tests) — the adversarial cases the spec explicitly assigned to this
   stage: `q` containing `,`, `(`, `)`, `.`, `"`, `\`, and all combined,
   asserting `.or()` is called exactly once with a single well-formed,
   correctly-quoted filter string, that reversing the escaping recovers the
   original `q` exactly, that a crafted `q` cannot smuggle in a third
   top-level filter clause via a raw comma, and that a plain non-adversarial
   `q` still produces the exact expected unescaped-looking output (no
   false-positive escaping).

3. **`tests/unit/schemas/service-weeks.test.ts`** (11 tests, new file — none
   existed before) — `createServiceWeekSchema`/`updateServiceWeekSchema`
   `sermonTopic`/`sermonScripture` `.max(200)`: valid body, exact 200-char
   boundary (accept), 201-char (reject), a 2MB string (reject — the
   unbounded-input case this issue closes), empty string still rejected
   (`.min(1)` unchanged), and optional-omission still allowed on update.

4. **`tests/unit/schemas/events-notes-max-tester-supplement.test.ts`**
   (7 tests) — `createEventSchema`/`updateEventSchema` `notes` `.max(2000)`:
   exact 2000-char boundary (accept), 2001-char (reject), 2MB string
   (reject), omitted/explicit-null still accepted (`.nullish()` unchanged).

5. **`tests/unit/app/api/google-calendar-callback-validation-tester-supplement.test.ts`**
   (7 tests) — oversized `code` (>2048), `state` (>512), `error` (>200), and
   empty-but-present `code` all redirect to `/profile?calendar=error` (307,
   state cookie cleared, `exchangeCode` never called, no JSON content-type);
   confirms `code:"abc"` and `error:"access_denied"` still work unchanged;
   confirms the exact 2048-char boundary is still accepted.

6. **`tests/unit/app/api/invitations-id-param-validation-tester-supplement.test.ts`**
   (6 tests) — `denyInvitation` malformed `:id` returns 400
   `VALIDATION_FAILED` before any Supabase/RPC call on both the in-app and
   token branches; a well-formed uuid still passes validation (reaches the DB
   lookup, distinct from the 400 the malformed-id tests get);
   `withdrawInvitation` malformed `:id` returns 400 when authorized, and
   confirms 401 (no Clerk session) and 403 (wrong role) both still take
   precedence over the 400 for a malformed id, matching the spec's ordering
   requirement.

## Failure cases covered (explicit, per pipeline contract)

- Malformed/adversarial `q` values that would have broken out of the
  PostgREST filter grammar pre-fix.
- Over-limit `sermonTopic`/`sermonScripture`/`notes` (both boundary and
  grossly-oversized).
- Malformed Google OAuth callback query params (oversized/empty) — must
  redirect, never leak to `exchangeCode()`.
- Malformed `:id` invitation route params on both `denyInvitation` branches
  and `withdrawInvitation`, plus the 401/403-before-400 ordering.

No failures encountered. Nothing patched around — this file records only
independently-run, all-green results.
