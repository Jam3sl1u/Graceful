# Review — Issue #28: Remove/archive member with PII anonymization

## VERDICT: SHIP, with one flagged pre-merge action

## Provenance note

This implementation was done directly in an interactive session (plan mode →
approved plan → implementation), not via the automated `/feature` 4-agent
pipeline. `spec.md`/`changes.md`/`test-results.md`/`review.md` are written in
the same handoff format for consistency and to correct the stale #37
carryover the previous run left behind, but there was no separate blind
Reviewer pass — this file is a self-review against the approved plan and the
actual diff, not an independent second opinion.

## What changed

`DELETE /api/church-group/members/:id` is implemented as a right-to-erasure
anonymization, backed by a new `SECURITY DEFINER` RPC
(`remove_church_group_member`) that atomically: checks caller is admin,
locks the target + all current group admins in one `ORDER BY id FOR UPDATE`
query, 404s on missing/wrong-group/already-anonymized targets, 422s
(`LAST_ADMIN`) on removing the group's sole admin, anonymizes PII fields
(including `clerk_id`, the actual access-revocation lever under this repo's
RLS design), and deletes future-only per-user rows while leaving
`invitations`/`event_attendees`/etc. pointing at the now-anonymized row.
Audit log entry `member.removed` is written with empty metadata. The member
directory query now excludes anonymized users.

Full file list and reasoning: `changes.md`. Design rationale and the
alternatives considered (why not mirror the PATCH-role handler's shape, why
UPDATE not DELETE): `spec.md` and the approved plan file.

## Verification performed

- `bun run typecheck`, `bun run lint`, `bun run test` — all clean (186/186
  unit tests). Confirmed directly, not taken on faith from a prior stage.
- Read the actual migration SQL, handler code, and both test files before
  writing this verdict — not just the summaries above.
- Confirmed via `git diff main...HEAD --stat` that only the intended files
  changed (no stray artifacts, no unrelated reverted/re-added content).

## Known gap (does not block SHIP, but must be closed before this merges)

`tests/integration/rls/tables/member-removal.test.ts` has not been run
against a live Postgres/Supabase instance — none is available in this
environment, and standing one up here would require changing
`supabase/config.toml`'s `[api] enabled = false` placeholder, which is
outside this issue's scope. See `test-results.md` for the full explanation.
**Before merging**, run `supabase start && bun run test:rls` (or the
equivalent CI job, if one exists) and confirm the "concurrent BR-12
enforcement" case passes — it exercises real Postgres row-locking, which is
the one piece of this change a mocked unit test cannot verify.

## BR-12 carried forward correctly

Removal-side BR-12 is enforced independently inside the RPC (not shared code
with `role/handler.ts`'s demotion-side check, since they run on different
sides of the SQL/TS boundary) but both are cross-referenced in comments in
their respective files so a future change to one doesn't silently drift from
the other.

## Out of scope, confirmed still out of scope

GDPR-style data export-on-request (per the issue) and Clerk Backend API
identity deletion (flagged as an open question with a recommended default in
the plan; not implemented — `clerk_id` overwrite is sufficient to revoke app
access per the issue's own acceptance criteria).
