# Review — Issue #45: 24-hour dual-party invitation reminder scheduler

## VERDICT: SHIP

Reviewed the actual issue-45 commit (`88e2541`) — not `main...HEAD`, which is
noisy because the local `main` ref is stale (behind merged PRs #42/#43/#44). The
issue-45 commit touches exactly the 8 code files named in the spec plus the
pipeline artifacts. No scope creep.

## What I verified firsthand (not just trusting the summaries)

- **Spec fidelity.** Migration, `lib/scheduling/reminder.ts`, cron route,
  `vercel.json`, `types.ts`, and the `handler.ts` comment-only change all match
  `spec.md` §1–§6 verbatim, including the D1 (automatic cancellation) and D2
  (per-week admin aggregation) design decisions.
- **SQL schema references.** Independently cross-checked every table/column the
  RPC reads or writes:
  - `notifications` INSERT columns (`church_group_id, user_id, type, title,
    body, link_entity_type, link_entity_id`) all exist; all NOT NULL columns are
    supplied; `title` fits `varchar(200)`.
  - `notification_type` enum already contains `invitation_reminder`
    (`20260702000005`) — correctly not re-added.
  - `users.name/phone/sms_opted_in/role/church_group_id` and
    `service_weeks.is_cancelled/title/service_date/church_group_id` all confirmed.
  - Selector, per-week member re-query (includes pending-but-not-yet-due),
    and stamp-only-due-rows logic all match the spec's edge cases 5–8.
- **`isReminderDue`** mirrors the SQL selector exactly and is the correct pure
  analogue of the DB threshold.
- **Tests are meaningful, not superficial.** Ran the 3 relevant suites: 21/21
  pass. They cover real boundaries (exact-24h, 23h59m under, 25h over, repeat,
  all 3 non-pending statuses) and real failure paths (401 missing/wrong bearer
  with RPC never called, 500 on unset secret, 500 on RPC error, sendSms
  rejection isolated → still 200). The tester supplement legitimately closes the
  OR-vs-AND skip-condition gap and the `data: null` shape gap.
- **Guards.** `bun run typecheck` clean; `bun run check:service-role` clean (cron
  route/RPC caller use `getAnonSupabaseClient()`, never the service-role key).

## Non-blocking notes (do not need to fix for this ship)

1. The tester's supplemental test file
   (`tests/unit/app/api/cron-invitation-reminders-route-tester-supplement.test.ts`)
   and the updated `.pipeline/test-results.md` are currently **untracked/uncommitted**
   in the worktree — they are not part of commit `88e2541`. The orchestration
   verify-gate must commit them before the worktree is torn down, or that
   coverage and the test report are lost. Flagging because it is easy to drop.
2. The `CRON_SECRET` bearer check uses a plain `!==` string comparison
   (non-constant-time). This is exactly what the spec prescribed and matches the
   conventional Vercel Cron pattern; acceptable for a shared cron token. Noted
   only for completeness.
3. Correctness of the SQL RPC body (temp table + `string_agg` + per-week loop)
   is verified by static read-through against the schema, as the repo has no
   live-DB harness for RPC bodies — same standard applied to the
   `accept_invitation` RPC it copies. Recommend a manual sanity check of the
   admin-notification body once a preview DB is available, but this is not a
   blocker under the established convention.
