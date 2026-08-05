# Test Results — Issue #74: Admin Global Dashboard screen

## Verdict: PASS

All checks pass. The coder's claims in `.pipeline/changes.md` were independently
verified rather than trusted: every changed/new file was read against
`.pipeline/spec.md`, the full verification suite was re-run from scratch, and
11 new independent tests were added covering spec-named edge cases and failure
paths not exercised by the coder's own test files.

## Commands re-run independently

- `bun run lint` — clean (no errors/warnings).
- `bun run typecheck` (`tsc --noEmit`) — clean.
- `bun run test` (full Jest suite) — **86 suites / 1083 tests, all passing**
  (84 suites / 1072 tests from the coder's changes, plus 2 new tester-supplement
  files / 11 tests added in this stage — see below).

## Code review against spec.md

Read and compared against the spec line-by-line:
- `schemas/service-weeks.ts` — append-only addition of
  `serviceWeekStatusFilters`/`ServiceWeekStatusFilter` and
  `serviceWeeksOverviewQuerySchema` with the exact `.superRefine` validation
  rules specified (invalid calendar date via `isValidDateString`,
  `startDate > endDate`); `createServiceWeekSchema`/`updateServiceWeekSchema`
  untouched. Matches spec exactly.
- `app/api/service-weeks/overview/handler.ts` — matches the spec's order of
  operations (auth → role gate → query parse → JWT → weeks query → zero-weeks
  short-circuit → setlists → invitations (explicit columns, no `select("*")`)
  → conflicts → aggregate). Aggregation rules (latest-invitation-wins,
  `withdrawn` excluded from both numerator/denominator, orphaned-conflict
  ignored) match the spec's "exact — the tests assert these" section.
- `app/api/service-weeks/overview/route.ts` — thin GET wrapper, matches
  `app/api/availability/team/route.ts` shape.
- `app/(app)/dashboard/admin-dashboard.tsx` — state machine, fetch/cancelled
  guard, URL building (`status` always set, dates only when non-empty),
  403/400/error/success handling, and render branches (badges, fill-rate
  text, empty-list message, filter controls with labelled inputs) all match
  the spec verbatim, including copy text or the four view-state branches.
- `app/(app)/dashboard/admin-dashboard.module.css` — `.container` widened to
  860px as specified; reuses existing CSS custom properties only.
- `app/(app)/dashboard/page.tsx` — placeholder replaced with the server
  wrapper, mirrors `conflicts/page.tsx`.
- No changes to `app/(app)/week/**`, existing endpoints, handlers, or
  migrations — scope guard respected (confirmed only the files listed in
  `changes.md` were touched).

## Independent verification: coder's own new tests

- `tests/unit/app/api/service-weeks-overview-route.test.ts` (13 tests) — ran
  in isolation, all pass. Covers 401 (no user)/403 (member, guest)/401 (no
  JWT)/400 (bad date, start>end, bad status)/zero-weeks short-circuit (asserts
  `setlists`/`invitations`/`conflicts` never queried)/happy-path aggregation
  (fill rate, latest-invitation-wins, withdrawn exclusion, null setlist,
  orphaned conflict ignored, no `response_token`/`denial_reason` leak)/
  status=active/status=cancelled filter wiring/inclusive date bounds/500 on
  `service_weeks` and `conflicts` errors. All assertions independently
  re-checked against the spec's aggregation rules by hand — correct.
- `tests/unit/app/admin-dashboard.test.tsx` (7 tests) — ran in isolation, all
  pass. Covers loading, happy path (fill rate, all three publish badges,
  cancelled badge, singular/plural conflict badges, untitled-service
  fallback, card href), empty list, Status-select re-fetch, 403 forbidden,
  network-error, and 400-with-inline-alert-and-usable-filters. Confirmed the
  noted `Badge` `class="undefined undefined"` jsdom quirk is pre-existing and
  unrelated to this change (text-content assertions unaffected).

## New tests added this stage (independent verification, not just re-running the coder's suite)

Per AGENTS.md, this stage must independently verify claims rather than trust
them. Two new test files were added to close gaps the coder's own tests left
open, all of which pass against the as-shipped code:

### `tests/unit/app/api/service-weeks-overview-route-tester-supplement.test.ts` (8 tests)
- Tie-break rule: when two invitation rows for the same member/week share the
  exact same `created_at`, the **first-encountered** row wins (not the last)
  — verified against the spec's "replace only when strictly greater" wording,
  which the coder's suite didn't test directly (its tie scenario used
  differing timestamps).
- Single-bound date filtering: `startDate` alone calls `.gte` and never
  `.lte`; `endDate` alone calls `.lte` and never `.gte` (spec edge case 7 —
  the coder's suite only tested both bounds supplied together).
- `status=all` (default) never adds an `is_cancelled` filter at all (as
  opposed to just checking `active`/`cancelled` add the right filter).
- Invitations query selects the exact explicit column list
  (`"id, service_week_id, user_id, status, created_at"`) and never a `"*"` —
  a direct check on the `select()` call argument, stronger than the coder's
  "no response_token in the JSON response" check (that alone wouldn't catch
  a `select("*")` that got mapped away in code but still traveled over the
  wire in a real DB round trip).
- **Failure cases** the coder's suite didn't cover: 500 INTERNAL when the
  `setlists` query errors, 500 INTERNAL when the `invitations` query errors
  (spec edge case 11 says "any of the four queries" — coder only tested
  `service_weeks` and `conflicts`), and a rejected `getToken()` promise is
  still caught by the outer `try/catch` and returns a clean 500 without
  leaking the raw error message.

### `tests/unit/app/admin-dashboard-tester-supplement.test.tsx` (3 tests)
- `startDate`/`endDate` are appended to the fetch URL incrementally and
  independently as each field is set (not just "both present" as the coder's
  suite implicitly exercised via the Status filter only).
- A failure on a **re-fetch** (after a prior successful load already
  rendered data) correctly replaces the screen with the error state rather
  than leaving stale data visible — the coder's error-branch test only
  covered failure on the very first load.
- Unmounting the component while a fetch is in flight does not trigger a
  React "setState on an unmounted component" warning/error — exercises the
  `cancelled` guard's cleanup path, which the coder's suite never triggered
  (`console.error` asserted not called).

Note: an initial draft of a fourth supplement test attempted to reproduce the
"stale in-flight response overwritten by a newer one" race by firing two
rapid `Status` changes through the rendered `<select>`. That scenario turned
out to be unreachable through normal UI interaction with the shipped
component, because the view synchronously blanks to the `"loading"` screen
(removing the filter controls) on every filter change, before a second
change could be fired — so a real user cannot trigger two overlapping
requests through this UI. This is not a bug the reviewer needs to act on; it
was replaced with the unmount-during-fetch test above, which does exercise
the same `cancelled` guard via a path that actually is reachable.

## Result

All 86 suites / 1083 tests pass, including the 11 new independently-written
tests. No failures to report. Proceeding to review.
