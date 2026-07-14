# Review — Issue #48: Build Week View screen (Admin / Set Leader)

## VERDICT: SHIP

Reviewed the `.pipeline/` artifacts plus the actual diff for the #48 commit
(`4dd31d6...27be00c` — the only commit unique to this issue; the wider
`main...HEAD` range additionally carries PR #138's already-merged #51 work
because the local `main` ref lags the branch's base, see Note 1). Re-ran
`bun run typecheck`, `bun run lint`, and `bun run test` independently in this
worktree: all clean, 44 suites / 503 tests green.

## What I verified firsthand (not just trusting the summaries)

- **Backend roster-safety (the spec's single most important point):** read
  `app/api/invitations/handler.ts`. `listInvitations` uses an explicit
  column select (`"id, service_week_id, user_id, role_note, status,
  response_deadline, created_at"`), never `select("*")`. `WeekInvitation` /
  `toWeekInvitation` are a separate shape from `InvitationResponse` and never
  touch `response_token`/`denial_reason`. The happy-path test asserts the
  `responseToken` key is absent, the serialized object matches neither
  `responseToken` nor `response_token`, and the executed select string is not
  `"*"` and does not mention `response_token`. Correct and well-guarded.
- **Role gating + validation + tenant isolation:** `requireAuth` +
  `requireRole(["admin","set_leader"])` before any DB access, 400 on
  missing/non-uuid `serviceWeekId`, 401 with no JWT, `.eq("church_group_id",
  ctx.churchGroupId)` on the query. Tests cover 403/400/401/500/empty; the
  tester's supplement adds a recording chain that asserts both
  `service_week_id` and `church_group_id` filters are actually applied and no
  foreign group id is used — a genuine gap in the coder's own suite, now closed.
- **Conflict precedence (frontend):** `getRosterStatus` checks
  `conflictInvitationIds.has(current.id)` before any status comparison. The
  test fixture gives a member a stale row plus a current `accepted` row that
  is flagged in conflicts and asserts the slot reads "Conflict", not
  "Confirmed". Meaningful, not superficial.
- **Max-createdAt selection, 403→forbidden / 404→not-found routing, non-
  critical degradation of the week-list nav and availability sidebar, UTC
  date-window math, `{ data }` envelope unwrapping:** all read in
  `week-view.tsx` and match the spec. `Badge`/`Button` prop usage matches the
  actual component APIs (tones neutral/success/warning/danger; variant
  secondary + className). Events/Setlist/publish-badge placeholders carry the
  specified TODO markers; the "+ Invite" button is a non-functional
  placeholder per the scope guard.

Scope is exactly the 8 files the spec names — no scope creep, no unrelated
refactors, no backend mutation logic, no touching the events/setlist stubs.

## Non-blocking notes for the human (not code defects)

1. **PR base hygiene:** `git diff main...HEAD` shows #51's state-machine/cron/
   vercel.json changes because the local `main` ref is behind the branch's
   base (merge-base `d526909` predates PR #138). Ensure the PR targets an
   up-to-date `main` so the PR diff shows only the #48 files; otherwise the PR
   will appear to re-introduce already-merged #51 work.
2. **Uncommitted tester supplements:** the tester's two supplement files
   (`tests/unit/app/api/invitations-list-route-tester-supplement.test.ts`,
   `tests/unit/app/week-view-tester-supplement.test.tsx`) are currently
   untracked in the worktree. They pass and add real coverage — commit them
   as part of shipping so they aren't lost.

Neither note affects correctness of the shipped code. The implementation
matches the spec, the tests are meaningful, and independent re-runs are green.
