# Changes — Issue #74: Admin Global Dashboard screen

## Summary

Implemented the read-only Admin Global Dashboard (PRD wireframe screen 8,
`/dashboard`): one new aggregate read endpoint
(`GET /api/service-weeks/overview`) plus the client screen that consumes it.
No changes to existing endpoints, handlers, RLS/migrations, or
`app/(app)/week/**`, per the spec's scope guard.

## New files

- **`schemas/service-weeks.ts`** (modified, append-only) — added
  `serviceWeekStatusFilters` / `ServiceWeekStatusFilter` and
  `serviceWeeksOverviewQuerySchema` (optional `startDate`/`endDate`, `status`
  defaulting to `"all"`), with a `.superRefine` rejecting invalid calendar
  dates and `startDate > endDate`. `createServiceWeekSchema` /
  `updateServiceWeekSchema` untouched.

- **`app/api/service-weeks/overview/handler.ts`** (new) — `getServiceWeeksOverview`.
  Gate: `requireAuth` + `requireRole(["admin", "set_leader"])`. Query flow:
  1. `service_weeks` filtered by group + optional date bounds + status, ordered
     by `service_date` desc (same ordering as `listServiceWeeks`).
  2. Short-circuits with `{ serviceWeeks: [] }` when there are zero weeks
     (skips the three follow-up queries).
  3. `setlists` → map of week id → status.
  4. `invitations` (explicit columns only — `id, service_week_id, user_id,
     status, created_at`; never `select("*")`, so `response_token` /
     `denial_reason` never leak) → reduced to the latest row per
     `(service_week_id, user_id)` by `created_at` (mirrors
     `getCurrentInvitation` in `week-view.tsx`). `rosterSize` counts members
     whose latest status is not `withdrawn`; `confirmedCount` counts those
     whose latest status is `accepted`.
  5. `conflicts` (`resolved_at IS NULL`) mapped to a week via the invitation
     rows from step 4; a conflict whose invitation isn't in that map (i.e.
     belongs to a filtered-out week) is silently ignored — no crash.
  6. Aggregates and returns `serviceWeeks` in the step-1 order.
  All reads go through the caller's RLS-scoped client — no service-role
  client, no RPC, no migration.

- **`app/api/service-weeks/overview/route.ts`** (new) — thin `GET` wrapper,
  same shape as `app/api/availability/team/route.ts`.

- **`app/(app)/dashboard/admin-dashboard.tsx`** (new, client component) —
  `AdminDashboard`. State machine (`loading` / `ready` / `forbidden` /
  `error`) copied from `conflicts-list.tsx`, plus `startDate`/`endDate`/
  `status`/`filterError` state. `useEffect` keyed on the three filters, with
  the `cancelled` guard so a stale response can't overwrite a newer one.
  Fetches `/api/service-weeks/overview` with `status` always set and
  `startDate`/`endDate` appended only when non-empty. `403` → forbidden;
  `400` → stays `ready` with `weeks: []` and an inline `role="alert"` message
  (filters remain usable); other failures → `error`. Renders `From`/`To`/
  `Status` filter controls, and per-week cards linking to `/week/{id}` with
  the publish badge (`Published` / `Draft` / `No setlist`), a `Cancelled`
  badge when applicable, the roster fill line (`No one invited yet` when
  `rosterSize === 0`, else `"N of M confirmed"`), and an open-conflict badge
  (singular/plural) when `openConflictCount > 0`.

- **`app/(app)/dashboard/admin-dashboard.module.css`** (new) — based on
  `conflicts-list.module.css` (`.container` widened to `860px`), plus
  `.filters` / `.filterField` / `.cardMeta`.

- **`app/(app)/dashboard/page.tsx`** (modified) — replaced the 4-line
  placeholder with the server component wrapper rendering `AdminDashboard`,
  mirroring `app/(app)/conflicts/page.tsx`.

- **`tests/unit/app/api/service-weeks-overview-route.test.ts`** (new) — 401
  (no Clerk user, lookup never consulted), 403 for `member`/`guest`, 401
  (missing JWT), 400 (invalid date, `startDate > endDate`, unknown `status`),
  zero-weeks short-circuit (asserts the three follow-up tables are never
  queried), happy-path aggregation (asserts fill rate, latest-invitation-wins
  for a re-invited member, a `withdrawn` invitation excluded from both
  numerator and denominator, `setlistStatus: null` for a week with no setlist
  row, and an orphaned conflict ignored without crashing), `status=active` /
  `status=cancelled` filter wiring, inclusive `gte`/`lte` date-bound wiring,
  and 500 on both a `service_weeks` and a `conflicts` query error. Uses the
  chainable `makeChain` mock pattern from
  `service-weeks-member-view-route.test.ts`.

- **`tests/unit/app/admin-dashboard.test.tsx`** (new, jsdom) — loading state,
  happy path (fill rate `"5 of 7 confirmed"`, `Published`/`Draft`/`No setlist`
  badges, `Cancelled` badge, singular/plural open-conflict badges,
  `"No one invited yet"`, `"Untitled service"` title fallback, card `href`),
  empty-list message, Status-select change re-fetching with
  `status=cancelled` in the URL, the 403 forbidden branch, the network-error
  branch, and the 400 branch (inline alert text, filter controls still
  rendered, list falls back to the empty-list message).

## Notes for the Tester

- A pre-existing, unrelated environment quirk: `components/ui/Badge.tsx`
  renders `class="undefined undefined"` under the current Jest CSS-module
  mock in this jsdom test environment (verified via a standalone repro
  render of `<Badge>` outside this screen's code) — text content and
  `toBeInTheDocument()` assertions are unaffected and were used throughout;
  this is not something introduced by this change and is out of scope for
  issue #74.
- The Status `<select>`'s `"Cancelled"` option text collides with the
  `Cancelled` badge's text in `getByText` queries — the test disambiguates
  with `within(card)`.
- Verification run: `bun run lint`, `bun run typecheck`, and `bun run test`
  (84 suites / 1072 tests) all pass, including the 21 new tests across the
  two new test files.
