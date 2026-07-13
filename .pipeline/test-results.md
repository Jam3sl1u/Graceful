# Test Results — Issue #45: 24-hour dual-party invitation reminder scheduler

Working directory verified before every command below:
`/Users/jamesliu/Documents/Graceful/.claude/worktrees/issue-45`.

## Verdict: PASS

All coder-claimed checks were independently re-run in this worktree and
pass. One supplemental test file was added by this stage to close two real
coverage gaps found during review of the coder's tests (see below); all
tests, including the new ones, pass. No application code was modified.

## Checks re-run

| Command | Result |
| --- | --- |
| `bun run lint` | Clean (`eslint .`, no output/errors) |
| `bun run typecheck` | Clean (`tsc --noEmit`, no output/errors) |
| `bun run test` | **34 suites / 401 tests passed**, 0 failed (coder's 33/398 + this stage's 1 new suite / 3 new tests) |
| `bun run check:service-role` | `OK: no service-role key references found outside comments in app/ or lib/.` |
| `bun run check:workflows` | `OK: 1 workflow script(s) checked — syntax valid, all agent() calls pinned.` (no orchestration scripts touched by this change; check still passes) |

New/changed suites specifically confirmed passing:
- `tests/unit/lib/scheduling/reminder.test.ts` (coder's) — PASS
- `tests/unit/app/api/cron-invitation-reminders-route.test.ts` (coder's) — PASS
  (one expected `console.error` line from the sendSms-failure-isolation test —
  not a failure; the test asserts the job still returns 200 despite it)
- `tests/unit/app/api/cron-invitation-reminders-route-tester-supplement.test.ts`
  (this stage, new) — PASS, 3 tests

## Supplemental test written by this stage (Tester)

`tests/unit/app/api/cron-invitation-reminders-route-tester-supplement.test.ts`
— closes two gaps not exercised by the coder's own test file:

1. **SMS-skip condition tested as OR, not just the conjunction.** The
   coder's happy-path test's only "skipped" fixture combines `phone: null`
   AND `sms_opted_in: false` in the same row. The handler's actual skip
   condition is `!phone || sms_opted_in !== true` (OR). A regression that
   swapped this to `!phone && sms_opted_in !== true` (AND) would produce an
   *identical* result for that one combined row (still skips) and would
   still pass the coder's suite, while incorrectly dispatching SMS in
   production for phone-present-but-opted-out or phone-absent-but-opted-in
   members. Added two tests exercising each condition alone
   (phone-present/opted-out, and phone-absent/opted-in), both confirming
   `smsSkipped: 1` / `sendSms` not called.
2. **`{ data: null, error: null }` RPC shape.** The route does `data ?? []`
   defensively, but only the `{ data: [], error: null }` empty-array shape
   was tested by the coder. Added a test for the RPC actually resolving
   `data: null` (distinct, plausible Supabase client shape) and confirmed
   it still returns `processed: 0` with no SMS dispatch.

Both gaps are real coverage gaps, not implementation bugs — the current
`route.ts` code (`!reminder.phone || reminder.sms_opted_in !== true` and
`const reminders = data ?? []`) is already correct and all three new tests
pass against the unmodified implementation.

## Independent verification beyond re-running commands

1. **`isReminderDue` boundary logic** (`lib/scheduling/reminder.ts`) — read
   directly; matches the spec's pseudocode exactly (`status === "pending" &&
   anchorMs <= now - 24h`, using `lastRemindedAt ?? createdAt`). The 6 cases
   in `reminder.test.ts` (exact-24h, 23h59m-under, 25h-over,
   recent-repeat-not-due, repeat-due, non-pending×3) match spec edge cases
   1–4 verbatim and all pass.

2. **Cron route auth ordering** (`app/api/cron/invitation-reminders/route.ts`)
   — read directly; confirms `CRON_SECRET`-unset (500/INTERNAL) is checked
   *before* the `Authorization` header comparison (401/UNAUTHENTICATED), and
   both are checked before `getAnonSupabaseClient()`/RPC call, matching
   spec step 1. Confirmed via test assertions that
   `mockGetAnonSupabaseClient` is `not.toHaveBeenCalled()` in both the
   missing-header and unset-secret cases.

3. **`sendSms` failure isolation** — confirmed the `try/catch` wraps only
   the `sendSms` call (not the RPC), and a rejection increments `smsFailed`
   without affecting HTTP status (still 200) or throwing. The coder's test
   exercises this with a real `mockRejectedValue`, not just a synchronous
   throw — passes.

4. **Migration SQL schema references** — cross-checked every table/column
   the new RPC
   (`supabase/migrations/20260713000001_invitation_reminder_scheduler.sql`)
   reads or writes against the existing schema migrations, since this repo
   has no live-DB test harness for RPC bodies (same caveat the coder
   flagged):
   - `public.users.phone`, `.sms_opted_in`, `.role` (enum `user_role` incl.
     `admin`/`set_leader`) — confirmed in
     `20260702000001_cluster_1_organization.sql`.
   - `public.service_weeks.is_cancelled`, `.title`, `.service_date`,
     `.church_group_id` — confirmed in
     `20260702000003_cluster_3_scheduling_core.sql`.
   - `public.notifications` columns (`church_group_id`, `user_id`, `type`,
     `title`, `body`, `link_entity_type`, `link_entity_id`) — confirmed in
     `20260702000005_cluster_5_partial.sql`; the `invitation_reminder`
     notification_type enum value already exists there (correctly not
     re-added by this migration, per spec instruction).
   - `link_entity_type = 'service_week'` string convention — confirmed it
     matches existing usage in `app/api/service-weeks/[id]/handler.ts:258`
     (`link_entity_type: "service_week"`), not an invented value.
   - D2 aggregation correctness: the per-week admin-notification loop
     re-queries `WHERE i.service_week_id = v_week.id AND i.status =
     'pending'` (not restricted to the `due_invitations` temp table), which
     correctly includes pending-but-not-yet-due invitations in the listing
     — matches spec edge case 7.
   - `last_reminded_at` is stamped only on rows in the `due_invitations`
     temp table, not all pending rows in the affected weeks — matches spec
     step 4.

5. **`lib/supabase/types.ts` and `app/api/invitations/handler.ts` diffs** —
   read via `git show HEAD` directly; confirms `InvitationsRow`, the
   `Insert`'s `Omit<...>` union + override block, and the
   `send_invitation_reminders` `Functions` entry match spec §2 verbatim,
   and the `handler.ts` change is comment-only (no logic diff) as claimed.

## Failure case coverage (explicit ask: at least one)

Confirmed present and passing:
- 401 on missing `Authorization` header, and 401 on a present-but-wrong one
  (RPC never invoked in either case).
- 500 when `CRON_SECRET` is unset (checked before any DB call).
- 500 when the RPC call itself returns a Supabase `error`.
- `sendSms` rejection (the stub's real failure mode) isolated per-reminder,
  job still returns 200 (`smsFailed` incremented).

## Scope check

`git show HEAD --stat` touches exactly the 8 files (+ `.pipeline/*` handoff
files) named in `.pipeline/changes.md` and `.pipeline/spec.md` — no
unrelated files modified by the coder. This stage's own diff is additive
only (one new supplemental test file); no application code touched.

## Not independently re-verifiable in this environment

- The migration SQL's live execution (temp table + `string_agg` + per-week
  loop) cannot be run against a real Postgres instance from this harness —
  same limitation the coder flagged for `accept_invitation`. Verified by
  static read-through against the schema (see item 4 above) instead; this
  is the same standard applied to the reference RPC this migration copies
  from.

## Conclusion

No failing tests. One supplemental test file added (3 new passing tests
closing real coverage gaps, not implementation bugs). Ready for Review.
