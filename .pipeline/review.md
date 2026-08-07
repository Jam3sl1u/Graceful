# Review — Issue #74: Admin Global Dashboard screen

## VERDICT: SHIP

(with three non-blocking follow-ups listed at the bottom — none of them are
defects against this issue's spec or acceptance criteria.)

## What I verified firsthand

- `git diff main...HEAD` read in full (10 files, +1380/-624; 624 of the
  deletions are the previous run's `.pipeline/spec.md` / `changes.md` being
  overwritten, which is the expected per-run behaviour).
- Re-ran the verification suite myself in this worktree:
  - `bun run lint` — clean.
  - `bun run typecheck` — clean.
  - `bun run test` — **86 suites / 1083 tests, all passing** (matches
    `test-results.md`; the count includes the tester's 2 supplement files).
- Scanned every added line for network/env/eval/child_process content: the
  only `fetch(` added is the screen's own call to
  `/api/service-weeks/overview`. Nothing unexpected in the diff.

## Correctness — checked against the DB, not just the mocks

The unit tests mock Supabase, so I checked the queries against the actual
migrations rather than trusting the mocks:

- `service_weeks(id, service_date, title, is_cancelled, church_group_id)`,
  `setlists(service_week_id, status, church_group_id)`,
  `invitations(id, service_week_id, user_id, status, created_at,
  church_group_id)`, `conflicts(id, invitation_id, resolved_at,
  church_group_id)` — every column and table the handler selects/filters on
  exists (`20260702000003_cluster_3_scheduling_core.sql`). No mock-only column.
- RLS (`20260704000001_rls_policies.sql`): `invitations_select_leader_admin`,
  `conflicts_select_leader_admin`, `setlists_select_published_members` (leader/
  admin branch) and `service_weeks_select_tenant` all grant the group-wide read
  this screen needs for the `admin` / `set_leader` gate it uses. So the
  "group-wide regardless of the caller's own roster status" AC actually holds
  under RLS — it is not silently self-scoped. Members/guests are stopped twice
  (403 in the handler, and RLS would scope them to their own rows anyway).
- Aggregation semantics match the spec exactly: latest invitation per
  `(week, user)` with strict `>` (so a `created_at` tie keeps the
  first-encountered row — the tester's supplement asserts this directly),
  `withdrawn` excluded from both numerator and denominator, `denied`/`pending`
  in the denominator only, `setlistStatus: null` when no setlist row, open
  conflicts counted per row and mapped through the invitation map with an
  explicit `if (!invitation) continue;` orphan guard.
- Open-conflict counting is consistent with `GET /api/conflicts`
  (`resolved_at IS NULL`, all rows, no dedupe by member) — the dashboard's
  per-week counts will sum to what the Conflicts screen shows.

## Security

- `requireAuth` + `requireRole(["admin", "set_leader"])` before any DB access;
  a test asserts `getSupabaseClient` is never even constructed on the 403 path.
- Caller-JWT RLS client only — no service-role client, no RPC, no migration.
- `invitations` is selected with an explicit column list
  (`"id, service_week_id, user_id, status, created_at"`), never `select("*")`,
  so `response_token` / `denial_reason` never leave the DB. The tester's
  supplement asserts the literal `select()` argument, which is the right
  assertion (the coder's "not in the JSON response" check alone would not have
  caught a `select("*")` that got mapped away in code but still travelled over
  the wire).
- All four query-error paths return a generic `500 INTERNAL`; supplement tests
  assert the raw DB message (`"boom"`) never appears in the body, and that a
  rejected `getToken()` is caught by the outer handler rather than leaking.

## Scope

Scope guard respected: no changes to existing endpoints/handlers, no
migrations, nothing under `app/(app)/week/**`, and the hardcoded
`TODO(Sprint 3 #64)` badge in `week-view.tsx` was correctly left alone.
`schemas/service-weeks.ts` is append-only; `createServiceWeekSchema` /
`updateServiceWeekSchema` are byte-identical.

## Are the tests meaningful?

Yes, not superficial. They assert behaviour, not implementation echo:
- The aggregation test uses a fixture with a genuinely tricky shape (a stale
  `denied` row superseded by a newer `accepted` one, a `withdrawn` member, a
  `pending` member, an orphaned conflict) and asserts the whole response object
  with `toEqual`, so a wrong count fails loudly.
- Failure coverage is real: 401 (no session), 401 (no JWT), 403 (member and
  guest), 400 (non-calendar date, start>end, unknown status), and 500 on each
  of the four queries.
- The zero-weeks test asserts the three follow-up tables are *never* queried,
  which is the actual behavioural claim (no `.in()` with an empty list).
- The UI tests cover all four view states, both fill-rate branches, all three
  publish badges, singular/plural conflict copy, the `href` into `/week/{id}`,
  and the 400 branch keeping the filter controls usable.
- The tester's note that the "two rapid filter changes" race is unreachable
  through the UI is accurate — the component synchronously blanks to
  `"loading"` (unmounting the controls) on every filter change, so a second
  change can't be fired from the rendered controls. Replacing that with the
  unmount-during-flight test was the right call; the `cancelled` guard is still
  exercised.

## Non-blocking follow-ups (do not hold this PR)

1. **Uncommitted artifacts.** `tests/unit/app/api/service-weeks-overview-route-tester-supplement.test.ts`,
   `tests/unit/app/admin-dashboard-tester-supplement.test.tsx` and the modified
   `.pipeline/test-results.md` are still untracked/unstaged. They must be in the
   commit before the PR goes up, otherwise 11 of the 1083 green tests don't
   exist for CI or for the human reviewer.
2. **Unbounded reads / PostgREST row cap.** With `status=all` and no date
   bounds (the default first load), the endpoint reads every service week ever,
   then every invitation for all of them. Supabase's default "Max rows" cap
   (1000) would silently truncate the `invitations` result and produce *wrong*
   fill rates — quietly, with no error — once a group accumulates enough
   history (~2 years at ~10 invites/week). Also, `.in("service_week_id",
   weekIds)` grows the request URL linearly with week count. Not a defect
   against the spec (the planner explicitly chose no range cap and this matches
   existing repo patterns), and not reachable at current scale, but worth a
   follow-up issue: a default date window (e.g. last/next 90 days) plus an
   explicit `.limit()`, or moving the aggregation into a single SQL view/RPC.
   Also, `conflicts` is fetched group-wide rather than narrowed by the
   invitation ids already in hand — a cheap `.in("invitation_id", ...)` would
   avoid pulling conflicts for filtered-out weeks.
3. **`/dashboard` is a member-facing landing link.** `app/(public)/invite/[token]/invite-response.tsx`
   sends every invitee (usually role `member`) to `/dashboard` via its "Go to
   the app" link. That route used to be a "coming soon" placeholder; it now
   renders "You don't have access to this page." Neither destination was
   useful, so this isn't a regression created here, and fixing it would breach
   this issue's scope guard — but it should be retargeted (likely at
   `/member-week`) in a separate issue.
   Related: `components/layout/AppShell.tsx` still has no nav, so there is no
   in-app way for an admin to *reach* `/dashboard` yet (pre-existing
   `TODO(Sprint 1+)`).

Minor UX note (spec-sanctioned, no action needed): resetting `view` to
`"loading"` on every filter change unmounts the filter controls, so changing a
date loses focus on that input. The spec explicitly allowed this and the tests
assume it; a future pass could keep the controls mounted and show an inline
spinner instead.
