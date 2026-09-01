# Test Results — Issue #69: Wire notification trigger logic for all Phase 1 event types

**Verdict: ALL TESTS PASS.** Post-BLOCK remediation, round 3 (rounds 1 and 2 were
each reviewed; round 1's practice-reminder fix was incomplete, round 2 was
`NEEDS WORK` on MED-1..3 — all now addressed).

---

## Checks run (independently re-run after the round-3 edits)

| Check | Command | Result |
| ----- | ------- | ------ |
| Lint | `bun run lint` | PASS (eslint, no output) |
| Typecheck | `bun run typecheck` | PASS (`tsc --noEmit`, clean) |
| Unit tests | `bun run test` | PASS — 145 suites, 3098 tests |
| Service-role ban | `bun run check:service-role` | PASS |
| Workflow contract | `bun run check:workflows` | PASS |

Original run: 145 / 3089. Now 145 / 3098 (+9), no new suite.

The SECOND independent reviewer (round 2) stood up Postgres 16 and executed the
migration: verified `assert_cron_secret` is fail-closed, the claim CTE returns
only rows the run actually claimed (concurrency), the 3-attempt cap terminates,
`GET DIAGNOSTICS … ROW_COUNT` works, and MJ2 (`reminder_email` default false is
honoured). That empirical check predates the round-3 per-channel change but the
predicate structure is unchanged; re-running it against `…000002.sql` is the
recommended final gate.

---

## Round-3 coverage (MED-1..3 + LOW)

- `cron-practice-reminders-route.test.ts` — reworked for per-channel confirm:
  - cron secret passed through to `send_practice_reminders`;
  - RPC error (secret not seeded → `FORBIDDEN`) → 500;
  - per-user `reminder_sms` / `reminder_email` gating;
  - **`sms_done` already true → only email is re-sent, SMS is not** (MED-1);
  - partial failure (SMS ok, email down) → `confirm(p_sms_done: true,
    p_email_done: false)`;
  - total failure → `confirm(false, false)`, pair stays retryable;
  - clean dispatch → `confirm(true, true)`, `confirmed` counter.
- `event-email.test.ts` — recipients default to `event_attendees` for the event
  (MJ1); a new assertion checks the actual `.eq("event_id", …)` /
  `.eq("church_group_id", …)` / `.in("id", …)` filters, not just the table name
  (LOW-4).
- `events-notification-gcal.test.ts` — `eventId` plumbed from both callers.
- `templates.test.ts` — "PROPOSED COPY" labels → "approved" (LOW-3).

Round-1/2 coverage still in place: M1 bare-array back-compat; N5 `"A member"` on
both deny paths.

---

## Findings status

| Finding | Status |
| --- | --- |
| B1 | Resolved — spec `> RESOLUTION` blocks; no stale approval language in code. |
| B2 / B2-R1 / B2-R2 / M3 | Resolved — secret-gated RPCs (fail-closed), claim/confirm with per-channel flags, 90-min expiry, 3-attempt cap. |
| M1 | Resolved + tested. |
| M2 | Accepted + documented. |
| MJ1 | Resolved — GCal update email targets `event_attendees`. |
| MJ2 | Resolved — `reminder_email` (default false) honoured in the selector. |
| MED-1 | Resolved — per-channel `sms_done` / `email_done`; a succeeded channel is never re-sent. |
| MED-2 | Resolved — `REVOKE ALL … FROM PUBLIC, anon, authenticated` on `app_secrets` and `practice_reminder_sends`. |
| MED-3 | Resolved — `LIMIT 100`, soonest-first, so a backlog drains across runs. |
| MN1 | Resolved — `conflict-detection.ts` fallback `"A member"`. |
| LOW-1 | Resolved — `users` lookup tenant-scoped in `event-email.ts`. |
| LOW-2 | Resolved — PRD §30 em dash matches the template. |
| LOW-3 / LOW-4 | Resolved — test labels + filter assertions. |
| LOW-5 | Documented — fresh-apply-only note in Deploy notes. |
| LOW-6 / N1 / MN5 | Informational — no change (pre-existing pattern / spec-conformant, tracked follow-up). |

---

## Limitations Review must check by hand

1. **Migration bodies are not executed by the Jest suite.** Recommended:
   re-run the round-2 reviewer's Postgres check against the current
   `…000002.sql` (per-channel columns, `confirm_practice_reminder_sent`'s
   5-arg signature, the `LIMIT 100` subquery, both table `REVOKE`s).
2. **Deploy order + secret seed + `NEXT_PUBLIC_APP_URL`** — see
   `.pipeline/changes.md` "Deploy notes".
3. **Human sign-off on OQ1/OQ2** — recorded in `.pipeline/spec.md` from a direct
   operator answer on 2026-08-31; a reviewer should still confirm the specifics
   with the operator before merge.
4. **`send_invitation_reminders()`** keeps its pre-existing `anon` grant
   (bounded); a `CRON_SECRET` gate for it is a tracked follow-up, not #69.
