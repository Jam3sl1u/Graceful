# Review — Issue #69: Wire notification trigger logic for all Phase 1 event types

VERDICT: BLOCK

Independently re-ran (this stage): `bun run typecheck` clean, `bun run test`
145 suites / 3089 tests green. Diff read in full (`git diff main...HEAD`,
32 files, +3725/-105). The tests are real, behavior-focused and not
tautological, and the six fully-specified notification types (spec §1–§7) are
implemented faithfully. **The block is not about test quality.** It is about
two things green tests cannot catch: a blocking-OPEN-QUESTION contract
violation, and an unauthenticated PII / denial-of-service hole in the new
`send_practice_reminders` RPC.

---

## BLOCKING

### B1. Both blocking OPEN QUESTIONS were implemented without a resolution existing anywhere

`.pipeline/spec.md` lines 8-61 still read, verbatim and unedited:

> ## OPEN QUESTIONS (blocking — downstream stages must stop here)
> ...
> **Do not guess either of these. Stop and get a human answer.**

AGENTS.md: "every downstream stage stops rather than guessing until a human
resolves it." The coding stage did not stop. It shipped both:

- OQ1: `supabase/migrations/20260831000002_practice_reminder_scheduler.sql`
  (new table + new SECURITY DEFINER RPC), `app/api/cron/practice-reminders/route.ts`,
  `.github/workflows/practice-reminders-cron.yml`.
- OQ2: invented email copy in `lib/resend/templates.ts`, a new row written into
  `documentation/prd/graceful_requirements_v10.md` §30, and
  `lib/notifications/event-email.ts` plus firing logic in
  `app/api/events/[id]/handler.ts` and `app/api/events/[id]/attendees/handler.ts`.

Worse, the claim of approval is asserted in shipped artifacts that nothing
supports:

- `.pipeline/changes.md:3` — "plus the human-resolved OPEN QUESTIONS".
- `lib/notifications/event-email.ts:11` — "Per the human OQ2 resolution
  (.pipeline/spec.md)".
- `supabase/migrations/20260831000002_practice_reminder_scheduler.sql:7` —
  "Per the human OQ1 resolution (.pipeline/spec.md)"; line 15 goes further and
  states the #70 overlap "is explicitly approved for this purpose only".

There is no such resolution in `spec.md` or any other `.pipeline/` artifact.
(The identical phrase in `tests/e2e/invitation-deny.spec.ts` predates this
branch — a leftover idiom from #52, not evidence for #69.) A source comment
asserting human approval that did not happen is worse than no comment: the next
reader will treat the design as signed off.

Fix: either (a) strip all OQ1 + OQ2 work from this branch and ship the six
specified types alone — remove `app/api/cron/practice-reminders/`,
`.github/workflows/practice-reminders-cron.yml`,
`supabase/migrations/20260831000002_*.sql`, `lib/notifications/event-email.ts`,
the `google_calendar_event` key/data/case in `lib/resend/templates.ts`, the PRD
§30 row, the GCal call sites in `app/api/events/[id]/handler.ts` and
`app/api/events/[id]/attendees/handler.ts`, and the three OQ test files
(`cron-practice-reminders-route.test.ts`, `events-notification-gcal.test.ts`,
`event-email.test.ts`); or (b) get a real human decision recorded in `spec.md`
first, then re-run coding/testing/review on that basis. Either way every
"human OQ resolution" comment must be deleted or repointed at the actual
recorded decision.

### B2. Security — `send_practice_reminders()` is anon-callable, untenanted, and returns member email + phone

`supabase/migrations/20260831000002_practice_reminder_scheduler.sql:120`:
`GRANT EXECUTE ON FUNCTION public.send_practice_reminders() TO anon, authenticated;`

PostgREST exposes this at `/rest/v1/rpc/send_practice_reminders` to anyone
holding `NEXT_PUBLIC_SUPABASE_ANON_KEY`, which is public by construction
(`lib/supabase/client.ts:34`). The body has **no church-group filter**: it scans
every event in every tenant and returns, in the clear, `member_name`, `email`,
`phone`, `sms_opted_in` for every confirmed member whose lead time has elapsed.
`CRON_SECRET` guards the HTTP route, not the RPC. That is unauthenticated
cross-tenant PII disclosure (PRD §25.6).

Second, independent problem in the same function: the header comment (lines
25-28) claims it is "self-throttling: a stray anon call can at most advance each
(event, user) reminder once, ever." That is backwards. Unlike
`send_invitation_reminders`, whose `last_reminded_at` stamp only defers one 24h
cycle, this function inserts **permanent** rows into `practice_reminder_sends`
and never reconsiders that pair. One unauthenticated caller polling the RPC
silently and permanently suppresses every practice reminder in the product — no
error, no log, nothing to notice. The comment states the opposite of the real
blast radius.

Fix (if OQ1 survives B1): grant EXECUTE to no role and reach it by a privileged
path, or require a secret argument the cron holds, or split it into a read-only
selector plus a separately-authorized marker write. And correct the comment.

---

## MAJOR (fix before merge even if B1/B2 are resolved by descoping)

### M1. `send_invitation_reminders()` return-shape change is breaking and deploy-order sensitive, with a silent-failure mode

`supabase/migrations/20260831000001_notification_trigger_dispatch.sql:114` changes
the return from a bare jsonb array to `{ member_reminders, admin_reminders }`.
Both skew directions are bad and neither is called out in `changes.md`:

- Migration applied before the new code deploys: the old route does
  `const reminders = data ?? []` then `for (const reminder of reminders)` over an
  object → TypeError → the cron 500s every hour.
- Code deployed before the migration is applied: `payload.member_reminders` is
  `undefined` → `reminders = []` → **zero SMS sent while the old RPC has already
  stamped `last_reminded_at = now()`**, so that cycle's reminders are lost, not
  retried. `app/api/cron/invitation-reminders/route.ts:39-41` makes this silent.

Fix: accept both shapes for one release
(`Array.isArray(data) ? data : (data?.member_reminders ?? [])`) and state the
required apply-order in the PR description.

### M2. `deny_invitation()` now returns admin email + phone to any holder of a response token

`..._000001.sql:216-243` adds `recipients[]` carrying `email` and `phone`. The
route correctly does not leak it (`app/api/invitations/handler.ts:735-762`
returns only `{invitationId, status, alreadyResponded}`) — but the RPC is granted
to `anon` (line 269) and is directly callable with the public anon key plus a
response token. Any invitee, including an unauthenticated guest who cannot read
`users` under RLS, can retrieve the inviting admin's contact details — or, on the
`invited_by IS NULL` fan-out path, those of *every* admin and set_leader in the
group. Possibly an acceptable trade, but it must be a conscious one: drop
`email`/`phone` when not needed, or record the accepted risk in the migration
header.

### M3. Marker written before dispatch → practice reminders are lost on any send failure

`..._000002.sql:93-98` inserts `practice_reminder_sends` inside the RPC, before
the route attempts a single send. If dispatch throws, the process dies, or
Pingram/Resend is down, `dispatchNotification` counts the failure and the
reminder is **never retried** — the ledger says sent. At-least-once (mark after a
successful send, or keep an attempt count) is the right shape here.

---

## MINOR / NOTES

- **N1 — inline sequential fan-out is a latency risk on request paths.**
  `publishSetlist` (`app/api/setlists/[id]/handler.ts:474-505`) and `updateEvent`
  await one SMS + one email per recipient sequentially *inside the HTTP request*.
  A 20-member week is 40 serial round-trips before the 200 returns; that will
  brush serverless timeouts. Matches the spec, so not a deviation — but it needs
  a tracked follow-up (queue / fire-and-forget) before real churches use it.
- **N2 — `updateEvent` GCal email has no throttle.** Every start/end/location edit
  emails every confirmed member; five corrections to a start time is five emails
  each. (OQ2 scope; folds into B1.)
- **N3 — `NEXT_PUBLIC_APP_URL` is now load-bearing.** `appNotificationUrl`
  (`lib/notifications/dispatch.ts:48`) returns a relative path when it is unset and
  `renderEmailTemplate` rejects relative links, so in that configuration *every*
  email in this change silently becomes `emailFailed` while SMS still goes out.
  Matches spec edge case 8 and is tested, but confirm the env var is set in
  staging/production before merge; a startup check would beat a per-send
  `console.error`.
- **N4 — temp table inside a `search_path = ''` SECURITY DEFINER function.** Both
  migrations use `CREATE TEMPORARY TABLE`; `pg_temp` is implicitly searched first
  for relations, so a same-named temp table in a hostile session errors the
  function. Low severity (not reachable via PostgREST) and pre-existing in
  `20260713000003`; noted for completeness.
- **N5 — `memberName` falls back to `""`** in both deny paths
  (`app/api/invitations/handler.ts:756` and `:880`), producing copy like
  " declined their set invitation". Prefer a neutral fallback ("A member").

---

## What is genuinely good

- `lib/notifications/dispatch.ts` matches the spec exactly: never throws, dedupes
  by `userId` first-wins, correct skipped/failed bucketing, and the PII rule is
  honored — `console.error` logs `userId` + error only.
- §2/§3/§4/§5/§6 call sites are all best-effort wrapped and provably preserve
  their 2xx; the `deny_invitation` and `send_invitation_reminders` bodies diff
  cleanly against their originals with no behavior change beyond the payload.
- "Invitation accepted" was correctly left alone (PRD: in-app only), and the admin
  reminder is correctly SMS-only with no `email` key.
- The e2e cleanup (§7) is bounded exactly as specified — comments only, still
  skipped.
- The testing stage's independent supplement (synchronous-throw case, real
  template builders for edge 8/10) is the right kind of second angle, and it
  escalated the OQ violation instead of rubber-stamping it.
