# Review — Issue #69 (PR #194), round 3

**VERDICT: SHIP**

Round-3 remediation of MED-1 / MED-2 / MED-3 is correct. I executed the SQL against a
real Postgres 16 instance (throwaway Docker container, removed afterwards), including a
run as a non-superuser migration owner with the `anon` role as caller, and every claimed
behaviour held. No regression found in the round-3 delta.

## 1. Repo checks (exact numbers)

| Check | Command | Result |
| --- | --- | --- |
| Typecheck | `bun run typecheck` | PASS — `tsc --noEmit`, no output |
| Unit tests | `bun run test` | PASS — 145 suites, 3098 tests, 0 failures |
| Lint | `bun run lint` | PASS — `eslint .`, no output |
| Service-role ban | `bun run check:service-role` | PASS — "no service-role key references found outside comments" |
| Workflow contract | `bun run check:workflows` | PASS — 1 script checked, all `agent()` calls pinned |

## 2. SQL executed (Postgres 16, Docker, minimal schema)

`supabase/migrations/20260831000002_practice_reminder_scheduler.sql` applied with **zero
syntax errors**, twice: once as superuser, once as a `NOSUPERUSER` owner role with the
call made under `SET ROLE anon` (the shape the cron route actually uses). Both work.

- **MED-1 per-channel done — VERIFIED.** Attempt 1 for a `reminder_sms + reminder_email`
  user, `confirm(secret, e, u, true, false)` (SMS ok, email down) → ledger `(t, f)`.
  After the 90-min claim expiry the selector returns the pair again with
  `sms_done=true, email_done=false`, so the route computes `needSms=false`,
  `needEmail=true` and sends **email only**. The SMS is never re-sent.
- **Permanent drop-out — VERIFIED.** A pair whose enabled channels are all done
  (`sms_done`/`email_done` covering `reminder_sms`/`reminder_email`) is never returned by
  the selector again, and its `attempts` is not bumped.
- **Flag accumulation — VERIFIED.** `confirm(…, true, false)` then `confirm(…, false, true)`
  → `(t, t)`. The `WHERE (p_sms_done AND NOT sms_done) OR (p_email_done AND NOT email_done)`
  guard correctly returns `false` for a repeat `(true, true)`, for `(false, false)`, and for
  a non-existent pair. Wrong secret raises `FORBIDDEN` from both RPCs.
- **SMS-only user — VERIFIED.** `reminder_sms=true, reminder_email=false`; route sends SMS
  and confirms `(true, true)` (email never attempted → `emailFailed === 0`). The pair leaves
  the selector permanently.
- **MED-3 `LIMIT 200` + `DISTINCT ON` subquery — VERIFIED VALID.** With 251 due pairs the
  first run returns exactly 200, and they are the 200 soonest by `start_time` (0 claimed
  pairs beyond the 200th-soonest event). The next run drains the remaining 51. The outer
  `ORDER BY start_time` resolves against the inner alias correctly. `DISTINCT ON` still
  collapses a member holding two accepted invitations for the same week.
- **Claim CTE concurrency without `confirmed_at IS NULL` — VERIFIED SAFE.** Two overlapping
  sessions, stale-claim case: one got the pair (1 row), the other got 0, `attempts` bumped
  exactly once (1→2). Fresh-pair case (no ledger row at all): one got 3 rows, the other 0,
  all `attempts = 1`. The `ON CONFLICT DO UPDATE ... WHERE claimed_at <= now() - 90 min AND
  attempts < 3` guard is doing the work the dropped `confirmed_at` predicate used to share.
- **3-attempt cap — VERIFIED.** attempts 1→2→3 then the pair is permanently excluded.
- **MED-2 REVOKE — VERIFIED.** `has_table_privilege('anon','public.app_secrets','SELECT')`
  = false (also INSERT), `authenticated` = false; same for
  `public.practice_reminder_sends` (SELECT/INSERT/UPDATE). At runtime as `anon`:
  `permission denied for table app_secrets` / `permission denied for table
  practice_reminder_sends`. `assert_cron_secret` is not executable by `anon`; the two
  wrapper RPCs are.
- **`search_path = ''` hazards — VERIFIED CLEAN.** Re-ran against a faithful schema where
  `invitations.status` is the real `public.invitation_status` ENUM: `inv.status = 'accepted'`
  resolves fine under the empty search path. The `LEFT JOIN notification_preferences`
  default path (user with no preferences row → sms true / email false / 24 h) also works.
  The temp table resolves via the implicit `pg_temp` lookup; functions/operators are never
  resolved from `pg_temp`, so there is no SECURITY DEFINER shadowing surface.
- No prior definition of `send_practice_reminders` / `practice_reminder_sends` exists on
  `main` or in any other migration, so the new 1-arg signature does not leave a
  zero-arg, anon-callable overload behind. No stale `confirmed_at` / `sent_at` references
  remain anywhere in the SQL, types, or route.

## 3. Route logic (`app/api/cron/practice-reminders/route.ts`)

`p_sms_done: counts.smsFailed === 0` when `needSms` is false is **correct and harmless**:
either `sms_done` is already true (the RPC's `WHERE` makes it a no-op and returns false), or
`reminder_sms` is false, in which case setting the flag only suppresses a duplicate reminder
if the user flips the toggle after the reminder for that event already went out.

**No path marks a genuinely-failed channel done.** `counts` is computed per-reminder inside
the loop (the module-level totals are separate accumulators), so one user's failure cannot
contaminate another's. `smsFailed` / `emailFailed` are incremented only on a thrown error;
`sendSms` throws `SmsDispatchError` on any non-2xx from Pingram and `SmsNotConfiguredError`
when env is missing, and only returns `"skipped"` for permanent conditions
(`not_opted_in` / `no_phone` / `invalid_phone`) — marking those done is right. `sendEmail`
failures throw and are counted; a missing/blank address is `emailSkipped`, also permanent.

Tests are meaningful, not superficial: the MED-1 test asserts `sendSms` is *not* called and
the exact `confirm_practice_reminder_sent` argument object, and the partial-failure and
total-failure tests pin `(true,false)` and `(false,false)` respectively.

## 4. Non-blocking observations (do not block merge)

- **LOW-A — `supabase/migrations/20260831000002_...sql:126`.** Two
  `send_practice_reminders()` calls inside one transaction fail with
  `relation "due_practice_reminders" already exists` (the temp table is `ON COMMIT DROP`).
  Not reachable today: PostgREST gives each RPC its own transaction and the route calls it
  once per invocation. Worth a comment if anyone ever batches these.
- **LOW-B — `app/api/cron/practice-reminders/route.ts:55` / migration:168 (throughput).**
  A full 200-pair batch is 200 × (SMS + email + confirm) sequential HTTP round trips inside a
  single route invocation, with no `export const maxDuration`. Realistically 1–2 minutes,
  which will exceed most serverless function limits; a mid-loop timeout leaves the remaining
  pairs claimed with `attempts` already bumped, burning retries. Strictly better than round 2
  (which had no cap at all), so not a regression — but consider a lower cap or an explicit
  `maxDuration` before enabling the hourly workflow in production.
- **LOW-C — migration:92-98.** `assert_cron_secret` compares the secret with plain `=`
  (not constant-time) on an RPC any `anon` caller can invoke. Theoretical timing side
  channel only.
- **LOW-D.** Because the route marks channels it did not attempt as done, a user who enables
  `reminder_email` *after* their SMS reminder already went out gets no email for that same
  event. Consistent with "one reminder per event"; noted, not a defect.
- **INFO — human sign-off.** `.pipeline/spec.md` itself asks a reviewer to confirm the OQ1 /
  OQ2 resolutions with the operator, and this round flips PRD §30 and
  `lib/resend/templates.ts` from "PROPOSED COPY — REQUIRES HUMAN APPROVAL" to
  "Copy approved 2026-08-31". That approval is asserted from the spec's resolution block, not
  independently verifiable here — the human should confirm it before merge.
- **INFO — deploy.** The "fresh apply only" / secret-seed / migration-order notes in
  `.pipeline/changes.md` match what the SQL actually requires. `20260831000002` uses a bare
  `CREATE TABLE`, so any environment that already applied an earlier iteration of this same
  migration version must drop the objects first.

---

## Post-verdict follow-up (applied after this SHIP, does not change the verdict)

Per LOW-B, the per-run cap was lowered `LIMIT 200` → `LIMIT 100` and
`export const maxDuration = 300` was added to
`app/api/cron/practice-reminders/route.ts`, plus short comments in the migration
for LOW-A (one call per transaction) and LOW-C (non-constant-time compare,
accepted). `bun run typecheck` / `bun run test` (3098) / `bun run lint` /
`check:service-role` / `check:workflows` still green.
