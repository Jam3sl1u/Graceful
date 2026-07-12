# Changes: Issue #40 — Send set invitation (POST /api/invitations, BR-05)

## Human-resolved open question applied

The planner's spec defaulted `response_token` generation to
`randomBytes(32).toString("hex")`. The human override for this run instead
specifies: two `crypto.randomUUID()` calls, hyphens stripped, concatenated
into a 64-char hex string. Implemented as such in
`app/api/invitations/handler.ts` (`generateResponseToken()`), using the
`crypto` global (available in the Next.js/Node route-handler runtime) rather
than `import { randomBytes } from "node:crypto"`. The BR-05
warn-then-proceed/cancel flow (via `acknowledgeConflict`) matched the spec as
written, so no change was needed there.

## Files changed

- `lib/supabase/types.ts` — replaced the incomplete hand-rolled
  `InvitationsRow` (only had `id/church_group_id/service_week_id/user_id/status/created_at`)
  with the full column set matching the migration: adds `role_note`,
  `response_token`, `responded_at`, `denial_reason`, `denial_count`,
  `response_deadline`, `invited_by`. Updated the `invitations` table entry's
  `Insert` type to omit DB-defaulted/server-generated columns
  (`id`, `created_at`, `status`, `responded_at`, `denial_reason`,
  `denial_count`, `response_deadline`), mirroring the `service_weeks` pattern.

- `schemas/invitations.ts` — added `createInvitationSchema` /
  `CreateInvitationInput` (serviceWeekId/userId as UUIDs, optional roleNote
  1-500 chars trimmed, optional `acknowledgeConflict` boolean). Left the
  existing placeholder `invitationsSchema`/`InvitationsInput` export
  untouched since other stubs may reference it.

- `app/api/invitations/handler.ts` (new file) — `createInvitation(req, lookup?)`:
  1. `requireAuth` + `requireRole(ctx, ["admin", "set_leader"])`.
  2. Parses body with `createInvitationSchema.safeParse`; 400
     VALIDATION_FAILED on failure (including non-JSON body).
  3. Resolves the Supabase JWT client; 401 UNAUTHENTICATED if missing.
  4. Looks up the target `service_weeks` row scoped to
     `id = serviceWeekId AND church_group_id = ctx.churchGroupId`; 404
     NOT_FOUND if missing (wrong-group and missing are indistinguishable by
     design — never 403), 500 INTERNAL on DB error.
  5. BR-05 double-booking check: queries the target user's `accepted`
     invitations in the group, then checks whether any of those weeks
     (excluding the current `serviceWeekId`) share the same `service_date`.
     500 INTERNAL on DB error in either query.
  6. If a collision is found and `acknowledgeConflict !== true`: returns
     `fail(..., ErrorCode.CONFLICT, 409)` without inserting anything. If
     `acknowledgeConflict === true` (or no collision), proceeds.
  7. Generates `response_token` (two concatenated stripped UUIDs, 64 hex
     chars) and `response_deadline` (now + 72h ISO string), inserts the
     invitation (status left unset so the DB default `'pending'` applies),
     narrowly cast to `Database["public"]["Tables"]["invitations"]["Insert"]`
     per the service-weeks pattern. 500 INTERNAL on error/null row.
  8. Writes an audit log entry (`action: "invitation.sent"`,
     `entityType: "invitation"`, metadata includes
     `acknowledged_conflict: parsed.acknowledgeConflict === true`).
  9. Leaves a `// TODO(#67/#68)` comment marking the notification dispatch
     seam — no stub module created, no call made.
  10. Returns `ok({ invitation: toInvitationResponse(invitation) }, 201)`.
  11. Whole body wrapped in the same `try/catch` as `service-weeks/handler.ts`
      (`ApiException` → its status/code; anything else → 500 INTERNAL).
  Also exports `toInvitationResponse` (row → camelCase response DTO) and the
  `InvitationResponse` type.

- `app/api/invitations/route.ts` — POST now delegates to
  `createInvitation`; GET is untouched (`notImplemented` stub, out of scope
  for #40).

- `tests/unit/app/api/invitations-route.test.ts` (new file) — mock
  scaffolding copied from `tests/unit/app/api/service-weeks-route.test.ts`
  (`makeChain`/`makeSupabaseClient`/`setUpAuth`/`makeLookup`), extended with
  an `rpc` mock (`writeAuditLog` calls `supabase.rpc("write_audit_log", ...)`)
  and a `neq` chain method. Because the handler issues **two** sequential
  `service_weeks` selects (the week lookup, then the BR-05 collision check
  when the user has accepted invitations elsewhere), the fixture type gained
  a `selectSecond` field and `makeSupabaseClient` now counts `select()` calls
  per table to route the second `service_weeks` call to it. 14 tests cover:
  401 (no Clerk user / no JWT), 403 (member, guest), 400 (non-JSON body,
  missing serviceWeekId, missing userId, non-uuid userId, roleNote too long),
  404 (service week not found), 201 happy path (asserts no `status` key in
  the insert payload, 64-hex `response_token`, ~72h `response_deadline`,
  `invited_by === USER_ID`, and the `write_audit_log` RPC call with
  `action: "invitation.sent"`), 409 CONFLICT with no `acknowledgeConflict`
  (asserts no invitation insert happened), 201 with
  `acknowledgeConflict: true` on the same collision (asserts the insert did
  happen), and 500 on invitation-insert DB error.

## Explicitly not touched (per spec's out-of-scope list)

- `GET /api/invitations` — left as the existing `notImplemented` stub.
- Accept/deny/withdraw/token-lookup routes (#41-#45) — untouched.
- Writing to the `conflicts` table — that happens at accept time (#41), not
  in this handler.
- SMS/email dispatch (#67/#68) — comment seam only, no stub module.
- Any DB migration or RLS change — schema/RLS already support everything
  this handler needs.
- The `expired` status / DB enum — untouched.

## Verification

- `bun run typecheck` — passes.
- `bun run lint` — passes (0 errors, 0 warnings on touched files).
- `bun run test` — full suite: 20 suites / 274 tests passing, including the
  new 14-test file (`tests/unit/app/api/invitations-route.test.ts`).
- `bunx prettier --check` on all touched/new files — all pass (repo-wide
  `format:check` has pre-existing failures on unrelated files not touched by
  this change).
- `bun audit` — one pre-existing moderate advisory on a transitive
  `next -> postcss` dependency, unrelated to this issue's scope.

## What the Tester should focus on

- The BR-05 collision query logic in `app/api/invitations/handler.ts`
  (two-query approach: accepted invitations for the user in-group, then
  service_weeks with matching date excluding the current week) — verify the
  "exclude current serviceWeekId" and "status = accepted only" conditions
  are correct against real Supabase/RLS behavior, not just the mocked test.
- `response_token` format: confirm 64 lowercase hex chars with no separators
  (two `crypto.randomUUID()` outputs stripped of hyphens and concatenated) —
  satisfies the DB `varchar(64) unique` column and matches the human-provided
  override, not the original spec's `randomBytes` default.
- The 409 vs 201-with-acknowledgeConflict two-step contract end-to-end (a
  client integration/E2E test re-POSTing with `acknowledgeConflict: true`
  after receiving 409 would be valuable, since unit tests only assert each
  call path independently).
- No `conflicts` table row is written anywhere in this handler (confirmed by
  inspection — out of scope per spec, deferred to #41 accept flow).
