# Review — Issue #39: Service week cancel/reactivate (BR-17)

VERDICT: SHIP

## Summary
The implementation matches the spec on every material point. I verified the diff
directly (not just the summaries), re-ran typecheck/lint/tests, and cross-checked the
new types against the real DB migrations.

## What I verified
- **Handler** (`app/api/service-weeks/[id]/handler.ts`): `cancelServiceWeek` /
  `reactivateServiceWeek` are thin wrappers over a shared `setServiceWeekCancelled`.
  Flow is correct: `requireAuth` -> `requireRole(["admin"])` -> JWT (401 if missing)
  -> `update({is_cancelled}).eq("id").eq("church_group_id").select("*").maybeSingle()`
  (500 on error, 404 on null) -> `invitations.select("user_id").eq("service_week_id")
  .in("status",["pending","accepted"])` (500 on error) -> Set-dedup -> per-recipient
  notifications insert with correct shape (500 on error, skipped when zero recipients).
  No 409 short-circuit for already-in-state (matches idempotency note). Both TODO no-op
  comments (chat / GCal) present. Child rows never touched.
- **Types**: `NotificationsRow` and the `notifications` table Insert-optionality
  (`id`/`created_at`/`is_read`) match the cluster-5 migration columns exactly.
  `NotificationType` union matches the DB enum plus the two new values verbatim.
- **Migration** `20260711000001_...sql`: two `ALTER TYPE ... ADD VALUE IF NOT EXISTS`
  with commented DOWN. Correct.
- **Routes**: both 501 stubs replaced with clean POST delegators; `notImplemented`
  removed.
- **Tests**: coder's two suites assert exact insert payloads, dedup, tenant eq-order,
  and all four error paths independently for both directions. Reactivate happy-path
  fixture defaults to `is_cancelled:false`, so `isCancelled===false` is a real assertion,
  not an artifact. Tester supplement closes a genuine gap (the coder's `.in()` mock
  ignored its arguments, so a wrong-status-filter bug would slip through) by asserting
  the literal `.in("status",["pending","accepted"])` args.

## Checks re-run by me
- `bun run typecheck` — PASS (clean)
- `bun run lint` — PASS (clean)
- `bun run test` — PASS: 290 tests / 22 suites

## Non-blocking notes
- The tester-supplement test file and the two `.pipeline/*.md` edits are currently
  untracked/uncommitted; only commit `534deaf` (implementation + the coder's two
  suites) is on the branch. Ensure the supplement is committed before merge, or the
  extra coverage is lost. Does not affect correctness of shipped code.
- Migration enum values were not applied against a live Postgres instance in this
  sandbox (no DB). Both `ADD VALUE IF NOT EXISTS` statements are standard; recommend the
  usual CI/staging `test:rls` pass before deploy.
- Spec's edge-case list mentions "expired" as an excluded status; the actual
  `invitation_status` enum is `pending|accepted|denied|withdrawn` (no "expired"). The
  `.in(["pending","accepted"])` allow-list is correct regardless — harmless spec wording.
