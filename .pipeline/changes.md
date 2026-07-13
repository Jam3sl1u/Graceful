# Changes: Issue #42 — Deny invitation with reason (BR-08 denial cap)

## Files changed

- `schemas/invitations.ts` — added `denyInvitationSchema` (`reason` optional string, trimmed,
  max 200 chars, no `.min(1)` so empty/whitespace-only is valid) and its inferred
  `DenyInvitationInput` type, alongside the existing `createInvitationSchema`.

- `app/api/invitations/handler.ts` — two changes:
  1. Added `denyInvitation(req, id, lookup?)`, copying `createInvitation`'s structure
     (`requireAuth` → tolerant body parse → `auth()`/`getToken({template:"supabase"})` →
     `getSupabaseClient(jwt)` → try/catch tail). Logic: fetch the caller's own invitation
     (`id` + `church_group_id` + `user_id` scoped, so a wrong owner/group/id is
     indistinguishable → 404); if `status !== "pending"` return the current invitation as-is
     (200, no side effects — idempotent re-response per PRD §12); otherwise count prior
     `status = 'denied'` rows for that member+service_week, set this row's
     `denial_count = count + 1`, update `status/denial_reason/denial_count/responded_at`,
     write an `invitation.denied` audit log (metadata omits the raw reason text, only
     `reason_provided: boolean`), and return the updated invitation. Left a
     `TODO(#67/#68)` comment for the deferred SMS/email dispatch to the inviting admin, per
     spec's precedent from `createInvitation`.
  2. Added the BR-08 send-guard inside `createInvitation`, immediately after the existing
     `!week` 404 check and before the BR-05 double-booking check: counts
     `status = 'denied'` invitations for `(userId, serviceWeekId)`; if `>= 3`, returns
     409 CONFLICT ("Member has denied 3 invitations for this week and cannot be
     re-invited (BR-08)") without touching any later branch. Purely additive — no existing
     `createInvitation` behavior/branch order changed.

- `app/api/invitations/[id]/deny/route.ts` — replaced the `notImplemented(...)` stub with a
  real `POST` handler wired to `denyInvitation`, following the `params: Promise<{id:string}>`
  pattern from `app/api/service-weeks/[id]/cancel/route.ts`.

- `tests/unit/app/api/invitations-deny-route.test.ts` (new) — unit tests, mock scaffolding
  copied in style from `tests/unit/app/api/invitations-route.test.ts` (jest.mock of
  `@clerk/nextjs/server` + `@/lib/supabase/client`, `makeReq`/`makeLookup`/`setUpAuth`/
  `makeChain`/`makeSupabaseClient` helpers). Covers:
  - 401 (no JWT; Clerk userId null with lookup never consulted)
  - 404 (invitation not found / not owned by caller)
  - 400 (`reason` > 200 chars; `reason` not a string)
  - happy path pending → denied: `status`/`denial_reason`/`denial_count=1` set, and
    `invitation.denied` audit rpc call asserted with expected metadata shape
  - empty-body and whitespace-only-reason deny → `denial_reason` stored as `null`, not a 400
  - idempotent already-denied invitation → 200, no `update`/`rpc` call at all
  - `denial_count` becomes 2 when one prior denied row exists for the same member+week
  - 500 when the invitation lookup query errors
  - BR-08 send guard on `createInvitation`: 409 when 3 denied rows already exist for
    member+week, and 201 when only 2 exist (guard does not over-trigger)

## Verification

- `bun run lint` — clean (no errors/warnings).
- `bun run typecheck` — clean (`tsc --noEmit`, no errors).
- `bun run test` — all 26 suites / 339 tests pass, including the new tests in
  `invitations-deny-route.test.ts`. No existing tests (e.g. `invitations-route.test.ts`,
  `invitations-route.supplemental.test.ts`) were modified or broken by the new BR-08 guard
  query added to `createInvitation` — their default fixture (`invitations.select` returns
  `{ data: [], error: null }`) satisfies both the new deniedForWeek check and the
  pre-existing acceptedInvitations check.

## Notes for the Tester

- The spec's OPEN QUESTIONS section documents non-blocking design decisions already baked
  into this implementation (no `requireRole` on deny; deferred notification dispatch;
  "slot reopens" needs no extra code since there's no `slots` table). These are not gaps —
  verify behavior matches, not that they were left undone.
- Worth double-checking against real Supabase behavior (not just mocks): the BR-08
  denial-count query is scoped to `(user_id, service_week_id)` across all invitation rows
  regardless of `church_group_id`/`id`, matching the spec's exact query; and the deny
  handler's ownership scoping (`id` + `church_group_id` + `user_id`) really does make
  cross-user/cross-group/nonexistent ids indistinguishable (all 404).
- Two unrelated files (`.claude/workflows/handle-issues.js`, `.pipeline/test-results.md`)
  show as modified/stale in `git status` in this worktree but were **not touched by this
  stage** and are intentionally left out of the commit — they predate this session and are
  orchestration/pipeline-history artifacts, not part of issue #42's scope. `.pipeline/spec.md`
  is the Planning stage's own output and is committed as-is (unmodified by this stage).
