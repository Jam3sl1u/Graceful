# Test Results — Issue #69: Wire notification trigger logic for all Phase 1 event types

**Verdict: ALL TESTS PASS.** The pipeline continues to Review.

One non-test **process concern** is flagged for the Reviewer below (OPEN QUESTIONS).
It is not a test failure and does not pause the pipeline, but it is material.

---

## Checks run (independently, this stage)

| Check | Command | Result |
| ----- | ------- | ------ |
| Lint | `bun run lint` | PASS (eslint, no output) |
| Typecheck | `bun run typecheck` | PASS (`tsc --noEmit`, clean) |
| Unit tests | `bun run test` | PASS — 145 suites, 3089 tests |
| Service-role ban | `bun run check:service-role` | PASS — no service-role refs in `app/` or `lib/` |
| Workflow contract | `bun run check:workflows` | PASS — 1 script, all `agent()` calls pinned |

Baseline before this stage's own test file: 144 suites / 3081 tests. This stage
added 1 suite / 8 tests (see below); total 145 / 3089, all green.

---

## Independent tester supplement added

`tests/unit/lib/notifications/dispatch-tester-supplement.test.ts` (8 tests) — re-verifies
the load-bearing `dispatchNotification` guarantees from angles the coder's suite did not
cover, so the green result does not depend solely on the coder's own tests:

- **Happy path (multi-recipient):** 3 distinct recipients → 3 SMS + 3 emails, counts
  aggregate; mixed per-recipient outcomes land in the correct buckets
  (`smsSent`/`smsSkipped`/`smsFailed`/`emailSent`/`emailSkipped`).
- **Spec edge case 5 (dedupe):** 3 entries sharing one `userId` collapse to a single
  SMS + email, and the *first* occurrence's contact wins.
- **Failure case — synchronous throws:** `sendSms` / `sendEmail` throwing synchronously
  (not a rejected promise) is still swallowed; `dispatchNotification` never rejects even
  when every channel throws for every recipient. This is stricter than the coder's
  suite, which only tested rejected promises.
- **Spec edge case 10 (null reason):** the *real* `invitationDeniedSms` builder and the
  *real* `invitation_denied` email render omit the reason clause entirely — no `"null"`,
  no `"Reason:"` label — with `reason: null`.
- **Spec edge case 8 (relative link):** with `NEXT_PUBLIC_APP_URL` unset,
  `appNotificationUrl` returns a site-relative path; the real `renderEmailTemplate`
  rejects it (`absolute HTTPS URL`) while the real SMS builder accepts it — confirming
  the asymmetry `dispatchNotification` is designed around.

---

## Coverage assessment of the coder's tests (reviewed, not just trusted)

The coding stage shipped 9 new test files + edits to 3 existing ones. Spot-read and
judged behavior-focused, not tautological:

- `dispatch.test.ts` — spec edge cases 1–8 and 15 against `dispatchNotification` /
  `appNotificationUrl` with `sendSms`/`sendEmail` mocked. Good.
- `invitations-route-notifications.test.ts` — §2a/§2b, edge 12 (guest new-user vs
  existing-user link), edge 14 (cross-group `userId` → skip dispatch, still 201).
- `invitations-deny-route-notifications.test.ts` — §4a/§4b (both branches), edge 9
  (already-responded dispatches nothing on both paths), edge 10, `invited_by === null`
  fan-out to all admins/set_leaders.
- `setlists-publish-notifications.test.ts` — §5, edge 4 (zero confirmed members), edge
  11 (`songCount === 0` still dispatches).
- `availability-conflict-notifications.test.ts` — §6, edge 13 (triggering member who is
  themselves an admin is excluded via `.neq`).
- `cron-invitation-reminders-admin-sms.test.ts` — §3c: admin SMS fires with
  `pending_count`, SMS-only (`sendEmail` never called), counters aggregate across both
  loops, member loop unchanged.
- Each route-level suite asserts a total dispatch failure still yields the handler's
  normal 2xx.
- `templates.test.ts` / `cron-invitation-reminders-route*.test.ts` — updated for the new
  template key and the `send_invitation_reminders` object-shape change; still assert the
  original fields.

**No-regression case (spec: "Invitation accepted" is in-app only):** confirmed.
`acceptInvitation` (`app/api/invitations/handler.ts:1018`) has no `dispatchNotification`
call, and neither migration in this change touches `accept_invitation`.

---

## Limitations / things Review must check by hand

1. **SQL is not executed by the test suite.** The three RPC bodies in
   `supabase/migrations/20260831000001_*.sql` and `..._000002_*.sql`
   (`send_invitation_reminders` new object return, `deny_invitation` new `recipients[]` /
   week fields, and the entire new `send_practice_reminders` RPC + `practice_reminder_sends`
   table) are only exercised through hand-written fake-client fixtures that *model* the
   expected shape. The lead-time interval arithmetic, the `DISTINCT ON` dedupe, and the
   "return only rows this call inserted" self-throttle in `send_practice_reminders` have
   no live-DB verification here.

2. **OPEN QUESTIONS were not resolved in `spec.md`.** `.pipeline/spec.md` still carries,
   verbatim and unedited, the planner's blocking header:

   > ## OPEN QUESTIONS (blocking — downstream stages must stop here)
   > ...
   > **Do not guess either of these. Stop and get a human answer.**

   for **OQ1** (practice reminder has no scheduler — needs a descope-or-build decision
   plus a lead-time source) and **OQ2** (Google Calendar event email has no copy and no
   defined trigger). AGENTS.md's pipeline contract says "every downstream stage stops
   rather than guessing until a human resolves it."

   The coding stage did **not** stop. It implemented both:
   - OQ1: new `app/api/cron/practice-reminders/route.ts`, new
     `.github/workflows/practice-reminders-cron.yml`, new
     `supabase/migrations/20260831000002_practice_reminder_scheduler.sql` (new table +
     new SECURITY DEFINER RPC, per-user `reminder_hours_before` lead time).
   - OQ2: new `google_calendar_event` template key with **invented** subject/preview
     copy, a new PRD §30 row, and `lib/notifications/event-email.ts` firing on
     start/end/location change + attendee assignment.

   `changes.md` states these were "human-resolved OPEN QUESTIONS", and
   `lib/notifications/event-email.ts:11` cites "the human OQ2 resolution
   (.pipeline/spec.md)" — but **no such resolution text exists anywhere in `spec.md` or
   any other `.pipeline/` artifact.** The new copy is at least flagged
   `PROPOSED COPY — REQUIRES HUMAN APPROVAL` in `lib/resend/templates.ts`, the PRD, and
   `event-email.ts`.

   This is out of scope for the testing stage to adjudicate — the OQ1/OQ2 code is itself
   covered by passing tests (`cron-practice-reminders-route.test.ts`,
   `events-notification-gcal.test.ts`, `event-email.test.ts`) — but the Reviewer must
   decide whether shipping unapproved answers to explicitly-blocking OPEN QUESTIONS is
   acceptable, or whether OQ1/OQ2 must be split out and the branch reduced to the six
   fully-specified notification types (§1–§7).

3. **`renderEmailTemplate` link validation vs. `appNotificationUrl`.** All handler call
   sites build the deep link with `appNotificationUrl(...)`, which returns a *relative*
   path when `NEXT_PUBLIC_APP_URL` is unset. In that configuration every notification
   email in this change will count as `emailFailed` at runtime (the request still
   succeeds — verified — but no email goes out). Confirm production/staging sets
   `NEXT_PUBLIC_APP_URL`.
