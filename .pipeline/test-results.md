# Test Results — Issue #50: Build Conflict Resolution screen (PRD §13 Screen 7)

## Verdict: PASS

This overwrites the stale `test-results.md` for issue #51 that was still
sitting at this path (per AGENTS.md, `.pipeline/` files reflect only the most
recent run).

## What I did

Read `.pipeline/changes.md` and `.pipeline/spec.md`, then independently read
the actual changed/created files (`app/api/conflicts/handler.ts`,
`app/(app)/conflicts/[id]/page.tsx`, `app/(app)/conflicts/[id]/conflict-resolution.tsx`,
`app/(app)/conflicts/[id]/conflict-resolution.module.css`,
`tests/unit/app/api/conflicts-route.test.ts`,
`tests/unit/app/conflict-resolution.test.tsx`) rather than trusting the
coder's summary, and re-ran the full verification suite with Bun.

Two independently-authored supplemental test files were already present
(untracked) in the worktree:
- `tests/unit/app/conflict-resolution-tester-supplement.test.tsx`
- `tests/unit/app/api/conflicts-route-tester-supplement.test.ts`

I reviewed both for behavioral (not implementation-detail) focus before
relying on them. They close real gaps the coder's own tests left:
- "Find a Replacement" click issues **no** additional fetch and leaves the
  conflict open/ready (the coder's tests only checked the `href`, never the
  click behavior — this is the spec's core distinguishing behavior for that
  button: "No API call. Conflict stays open.").
- A non-OK (500) response on the **initial** `GET /api/conflicts` lookup
  (the `!res.ok` branch of the load effect) — previously only a thrown
  network error and a well-formed-but-not-found list were covered.
- `roleNote: null` encodes as an empty-string query param (`&roleNote=`),
  not the literal string `"null"`.
- The role gate on the newly-touched handler rejects `guest`, not just
  `member` (guards against an accidental `requireRole` loosening while
  touching this handler).
- `roleNote: null` when the invitation row **exists** but its `role_note`
  column is null — distinct code path from "invitation row missing
  entirely" (proves the `??` fallback, not just optional chaining, is doing
  real work).

These are genuine behavioral tests (assert on rendered DOM / fetch calls /
response bodies, not internals), so I kept them as part of this stage's
output rather than treating them as noise.

## Verification run

- `bun run typecheck` — clean, no errors.
- `bun run lint` — clean, no errors/warnings.
- `bun run test` — **43 suites passed / 495 tests passed**, 0 failed.
  - Includes the coder's `tests/unit/app/conflict-resolution.test.tsx` (11
    tests: loading, happy path, href encoding, Mark as Resolved POST, Dismiss
    POST, null roleNote/triggerReason omission, null serviceWeekTitle
    fallback, double-submit guard, not-found → unavailable, network error →
    unavailable, 409 → unavailable, non-OK → inline alert).
  - Includes the coder's updated `tests/unit/app/api/conflicts-route.test.ts`
    (7 tests: 403 member, 401 no JWT, happy path with `roleNote`, empty list,
    missing-invitation-row fallback, 500 on conflicts query, 500 on
    invitations join).
  - Includes the 5 tester-supplement tests listed above.

## Coverage check against the spec

- **Happy path**: member name, formatted service date, `serviceWeekTitle`
  heading, role note, reason, all three actions rendered — covered and
  passing.
- **Named edge cases** (all covered, all pass):
  - Conflict id not in the open list → `unavailable`, no crash.
  - `serviceWeekTitle` null → falls back to "Service".
  - `roleNote` null → role line omitted cleanly (plus the href-encoding edge
    case: empty string, not `"null"`).
  - `triggerReason` null → reason line omitted cleanly.
  - In-flight request → both buttons disabled, second click produces no
    second POST.
  - 409 on resolve → `unavailable`.
  - Non-OK/network error on resolve → inline `role="alert"` message, buttons
    stay enabled, no raw error/code/status string leaked.
  - Non-OK (500) on the *initial* lookup → `unavailable`, no crash.
- **Failure cases**: network error on initial lookup (thrown fetch), 500 on
  initial lookup, non-OK on resolve, 409 on resolve — all covered.
- **"Find a Replacement" behaves as pure navigation**: verified both via
  `href` assertion (encoded `roleNote` + `serviceWeekId`) and, in the
  supplement, via a click producing zero additional fetch calls with the
  screen staying on the ready view — matches the spec's
  "No API call. Conflict stays open." requirement exactly.
- **`roleNote` plumbing end-to-end** (`handler.ts` → API response →
  component): the route test's happy path and missing-invitation-row cases,
  plus the supplement's "invitation exists but role_note column is null"
  case, together prove `roleNote: invitation?.role_note ?? null` behaves
  correctly for all three states (present / row missing / column null).
- **Role gate**: `member` and (via supplement) `guest` both get 403
  FORBIDDEN without ever reaching Supabase.
- **Out-of-scope guardrails held**: `app/(app)/conflicts/page.tsx` (the list
  stub) is untouched; `resolveConflict` (the resolve handler/schema) is
  untouched — confirmed by reading `handler.ts` in full; no migration files
  were touched (confirmed via file list in `changes.md` and `git status`).

## Manual spot checks

- Confirmed by reading source that no raw `error`/`code`/`status` string is
  ever interpolated into rendered text on any failure path (`actionError` is
  always a fixed string; the `unavailable` view has no error-derived text).
- Confirmed the two "back to conflicts" links use `next/link`'s `Link`
  (required by `@next/next/no-html-link-for-pages` since `/conflicts` is a
  real stub route), while "Find a Replacement" is intentionally a plain
  `<a>` to the not-yet-built `/invitations/new` route, matching the spec's
  OPEN QUESTION 1 chosen default (non-blocking, forward-compatible URL).

## Conclusion

No failing tests. The implementation matches the spec's button-mapping
table, view-state machine, edge cases, and out-of-scope boundaries. The full
suite (including two independently-authored supplemental test files closing
real coverage gaps) is green: 43 suites / 495 tests passed, typecheck clean,
lint clean. Ready for Review.
