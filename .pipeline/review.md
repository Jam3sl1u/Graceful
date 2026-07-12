# Review: Issue #40 — POST /api/invitations (BR-05 double-booking check)

## VERDICT: SHIP

## Scope of review
Read spec.md, changes.md, test-results.md, then reviewed the actual diff
(`git diff main...HEAD`) and read every touched file plus the reference
handlers and helpers firsthand. Did NOT rely on the written summaries alone.

## What was verified by direct code reading

- `app/api/invitations/handler.ts` — logic matches the spec step-by-step:
  requireAuth -> requireRole(["admin","set_leader"]) -> body parse (400 incl.
  non-JSON via `.catch(() => null)`) -> JWT/401 -> service_weeks lookup scoped
  to `id + church_group_id` (.maybeSingle, 404 on miss / 500 on DB error /
  never 403) -> BR-05 two-query collision check -> 409 when collision and
  `acknowledgeConflict !== true` (no insert) -> insert omits `status` so DB
  default 'pending' applies -> writeAuditLog(action "invitation.sent") ->
  `// TODO(#67/#68)` seam only, no notification call -> ok(..., 201) -> outer
  try/catch mirrors service-weeks (ApiException -> its status; else 500).
- Ordering nuance confirmed correct: 403 (role) before 400 (body) before 401
  (JWT), matching both the spec edge-case list and service-weeks/handler.ts.
- BR-05 query correctness: de-dupes accepted week IDs, filters status
  'accepted', matches on `service_date`, and excludes the current
  `serviceWeekId` via `.neq("id", serviceWeekId)` — self-re-invite is not a
  conflict (tester's supplemental test #6 confirms). Collision query only
  runs when the user has accepted invitations (guards the second select).
- No `conflicts` row is written (only a comment references it) — correct,
  deferred to accept flow (#41).
- Enum/schema alignment against migration 20260702000003: `invitation_status`
  includes 'accepted'/'pending'; `service_date date`; `response_token
  varchar(64) unique`; `response_deadline timestamptz`. Token generator emits
  64 lowercase hex chars (two randomUUID() concatenated, hyphens stripped) —
  matches the human override in changes.md and the DB column.
- `lib/supabase/types.ts` InvitationsRow + invitations Insert omit-list match
  the spec exactly and mirror the service_weeks pattern.
- `schemas/invitations.ts` createInvitationSchema matches spec; placeholder
  `invitationsSchema` left intact.
- `route.ts` — POST delegates to createInvitation; GET untouched stub.
- `writeAuditLog` throwing on RPC error is caught by the outer try/catch ->
  500, as spec requires.

## Tests
Coder's 14 tests + tester's 9 supplemental tests are meaningful, not
superficial: they assert insert payload has no `status` key, token regex
`/^[0-9a-f]{64}$/`, deadline within 60s of now+72h, `invited_by === USER_ID`,
audit RPC action, and (critically) that NO insert happens on 409 and that the
insert DOES happen on `acknowledgeConflict: true`. Self-exclusion and
per-query 500 paths are covered.

## Non-blocking notes (no action required for ship)
- The BR-05 collision query does not exclude `is_cancelled` weeks. If a member
  accepted a week later cancelled that shares a date with the new week, a
  conflict would still be flagged. The spec does not require excluding
  cancelled weeks, so this is spec-compliant; flag for a possible future
  refinement in the accept-flow issue (#41).
- All logic is unit-tested with mocks only; the two-query BR-05 behavior and
  the 409 -> re-POST-with-acknowledgeConflict flow have no live-DB/E2E
  coverage. Low risk (handler is stateless per request; each half verified),
  but a Supabase-local integration test is worthwhile follow-up.
- I could not re-run typecheck/lint/test myself this session (bash command
  classifier was temporarily unavailable). Both the coder and the tester
  independently ran all three: typecheck 0 errors, lint 0 errors/warnings,
  283 tests passing. Code reading found no reason to doubt those results.

## Conclusion
Code matches the spec, follows the established handler/schema/types/test
patterns faithfully, handles every named edge case, and the tests exercise
real behavior rather than rubber-stamping. Ship it.
