# Test Results: Issue #40 — Send set invitation (POST /api/invitations, BR-05)

## Verdict: PASS

All coder claims independently re-verified. Added a supplemental test file with
9 additional tests covering edge cases the spec named that the coder's own
suite didn't directly exercise; all pass.

## Commands run (fresh, independently)

- `bun install` — clean, no changes needed.
- `bun run typecheck` (`tsc --noEmit`) — **passes**, 0 errors.
- `bun run lint` (`eslint .`) — **passes**, 0 errors/warnings, repo-wide.
- `bun run test` (full suite, before adding my tests) — **20 suites / 274
  tests passing**, matches the coder's claim in `changes.md` exactly.
- `bun run test` (full suite, after adding my supplemental test file) —
  **21 suites / 283 tests passing** (274 + 9 new).
- `bunx prettier --check` on all touched/new files, including my new test
  file — all pass.

## Files independently read and cross-checked against spec.md

- `app/api/invitations/handler.ts` — logic matches spec step-by-step:
  requireAuth → requireRole → body parse (400 on failure, including
  non-JSON) → JWT/401 → service_weeks lookup scoped to
  `id + church_group_id` (404 on miss, 500 on DB error, never 403) → BR-05
  two-query collision check (accepted invitations for target user in-group,
  then service_weeks matching date excluding current week via `.neq`) → 409
  CONFLICT if collision and no `acknowledgeConflict`, else insert → insert
  omits `status` (DB default applies) → `writeAuditLog` with
  `action: "invitation.sent"` → `// TODO(#67/#68)` comment seam, no stub
  module → `ok(..., 201)` → outer try/catch mirrors service-weeks pattern.
- `app/api/invitations/route.ts` — POST delegates to `createInvitation`, GET
  untouched `notImplemented` stub, matches spec exactly.
- `schemas/invitations.ts` — `createInvitationSchema` matches spec's zod
  shape exactly (uuid serviceWeekId/userId, optional trimmed roleNote
  1-500, optional acknowledgeConflict boolean). Placeholder
  `invitationsSchema` left in place as instructed.
- `lib/supabase/types.ts` — `InvitationsRow` and the `invitations` table's
  `Insert` omit-list match the spec's exact required shape.
- `generateResponseToken()` — confirmed as the human-overridden format (two
  `crypto.randomUUID()` calls, hyphens stripped, concatenated → 64 lowercase
  hex chars), not the original spec's `randomBytes` default. Regex-verified
  in both the coder's test and my supplemental token-uniqueness test.
- `lib/api/auth.ts`, `lib/api/response.ts`, `lib/api/errors.ts`,
  `lib/audit/write-audit-log.ts` — confirmed `requireAuth`/`requireRole`/
  `ok`/`fail`/`ErrorCode.CONFLICT`(409)/`writeAuditLog` all behave as the
  handler assumes; no surprises vs. the `service-weeks` reference handler.

## Coder's own test file (`tests/unit/app/api/invitations-route.test.ts`)

Ran in isolation: **14/14 passing**, matching the claimed count. Covers 401
(x2), 403 (x2), 400 (x5), 404, 201 happy path (asserts no `status` key,
64-hex token, ~72h deadline, `invited_by`, audit RPC call), 409 CONFLICT
(asserts no insert), 201 with `acknowledgeConflict: true` (asserts insert
did happen), 500 on insert error. Assertions inspected directly, not just
trusted — they check the right things (e.g. `insertPayload).not.toHaveProperty("status")`,
`response_token` regex, deadline within 60s of expected).

## Supplemental tests added by Tester (`tests/unit/app/api/invitations-route.supplemental.test.ts`)

Independently written, not copied from the coder's file (fresh fixtures/mock
scaffolding rebuilt from spec, same style as the existing suite). 9/9 passing:

1. `roleNote` whitespace-only ("   ") → 400 VALIDATION_FAILED (spec names
   this explicitly: "roleNote empty/whitespace ... → 400").
2. Cross-group `serviceWeekId` → 404 NOT_FOUND, not 403 (spec: "wrong-group
   and missing indistinguishable ... always 404, never 403").
3. `service_weeks` lookup query DB error → 500 INTERNAL.
4. BR-05 first query (accepted invitations) DB error → 500 INTERNAL.
5. BR-05 second query (colliding service_weeks) DB error → 500 INTERNAL.
6. **Self-exclusion correctness**: target user already has an *accepted*
   invitation for the *same* `serviceWeekId` being re-invited to — must NOT
   409, since the spec requires excluding the current week from the
   collision set (models the real `.neq("id", serviceWeekId)` Supabase
   filter behavior). This is the most important behavioral edge case named
   in "What the Tester should focus on" in changes.md — verified correct.
7. Audit log exact payload shape: `p_action: "invitation.sent"`,
   `p_entity_type: "invitation"`, `p_entity_id`, and `p_metadata` containing
   `service_week_id`, `user_id`, `acknowledged_conflict: false` — asserted
   with a full object match, not just `objectContaining`.
8. `writeAuditLog`'s RPC erroring → outer try/catch surfaces it as 500
   INTERNAL (per spec: "writeAuditLog throwing ApiException is caught by
   the outer try/catch and surfaces as 500").
9. **Failure case / token uniqueness**: two sequential invitation creations
   produce two distinct, correctly-formatted 64-hex tokens (guards against a
   naive implementation that might reuse or derive predictable tokens).

## Not independently re-verified (noted, not blocking)

- Real Supabase/RLS behavior (all tests are mocked, per the coder's own
  "What the Tester should focus on" note) — no live DB available in this
  environment to run an integration/E2E check of the two-query BR-05 logic
  against actual Postgres semantics. The mock-level logic and exclusion
  behavior were verified as thoroughly as unit tests allow (see item 6
  above), but a live-DB or Supabase-local integration test would still be
  valuable follow-up, as the coder itself flagged.
- The 409 → re-POST-with-`acknowledgeConflict:true` end-to-end client flow
  — both halves are independently unit-tested and both pass, but no
  single test chains an actual two-request flow. Low risk since the
  handler is stateless per-request and each half is verified correct.

## Conclusion

No failures found. Spec compliance confirmed by direct code reading, not
just by trusting `changes.md`. Recommend proceeding to Reviewer.
