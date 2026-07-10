# Changes — Issue #27: Role assignment & multi-admin support

## Context: why this file previously described the wrong issue
A prior automated pipeline run on this branch produced **zero commits** for
#27 — the Coder stage silently no-op'd, leaving `.pipeline/spec.md`/
`changes.md` describing issue #26 (already shipped) and the target route
still an unimplemented stub. The Tester and Reviewer stages both caught this
independently and issued BLOCK verdicts (see `6499592` in git history). This
file documents the actual manual implementation that followed.

## Prerequisite: branch brought current with `origin/main`
This branch was 15 commits behind `origin/main`, missing #29's audit-log
infrastructure (`lib/audit/write-audit-log.ts`, the `write_audit_log` RPC,
`schemas/audit-log.ts`) that this issue's AC requires. Merged `origin/main`
in (merge, not rebase, since the branch's PR was already open/pushed);
resolved the two doc-only conflicts (`.pipeline/review.md`,
`test-results.md`) by taking `origin/main`'s side, since both are rewritten
below anyway. No application-code conflicts.

## Files changed

### `schemas/role.ts` (new)
`updateRoleSchema = z.object({ role: z.enum(["admin", "set_leader",
"member", "guest"]) })`, mirroring `schemas/church-group.ts`'s style.

### `app/api/church-group/members/[id]/role/handler.ts` (new)
`patchMemberRole(req, targetUserId, lookup?)` implementing the full control
flow: `requireAuth` → `requireRole(["admin"])` → path-id/body validation →
target-user lookup (404 if missing/cross-group) → BR-12 last-admin check
(422) → `update` → `writeAuditLog` (`action: "user.role_changed"`,
`metadata: { old_value, new_value }`) → `ok({ id, role })`. This is:
- The first real consumer of `writeAuditLog` outside its own unit test.
- The first `.update()` call anywhere in this codebase (no existing pattern
  to copy; `Database["public"]["Tables"]["users"]["Update"]` already
  supported `{ role }` with no type changes needed).

### `app/api/church-group/members/[id]/role/route.ts` (rewritten from stub)
Was a `notImplemented` PATCH stub; now unwraps Next 15's async `params` and
delegates to `patchMemberRole`, matching the
`app/api/instruments/[id]/route.ts` pattern exactly.

### `tests/unit/app/api/church-group-members-role-route.test.ts` (new)
20 cases: 401 (no Clerk user; no JWT), 403 for each of
set_leader/member/guest, 400 for invalid role value / non-JSON body /
malformed target-id UUID, 404 for missing target and cross-group target,
422 for BR-12 (including self-demotion as sole admin), 200 for demoting an
admin with a co-admin present (including self-demotion with a co-admin),
200 for promoting a second admin (BR-03/BR-04, asserted via call-count that
no admin-count query is made for promotions), 200 for a same-role no-op
PATCH (still audit-logged), and 500 for target-lookup/count/update/
audit-log failures. Uses a queue-based chainable Supabase query-builder mock
(no existing test mocked a multi-call-same-table sequence with mixed
`.select()+.eq()+.maybeSingle()`, a bare-count `.select(...).eq().eq()`, and
`.update()...maybeSingle()` shapes, so this is a new small mock utility
local to this file).

## Design note flagged for reviewers (not fixed here, out of scope)
The `users_update_leader_admin` RLS policy permits any `set_leader` **or**
`admin` to `UPDATE` any same-group `users` row at the Postgres layer, with
no column-level restriction. `requireRole(ctx, ["admin"])` in this handler
is therefore the **sole** enforcement point for both "only admins may change
role" and "this route is the only writer of `users.role`" — a future route
doing a raw `.update()` on `users` could still write `role` at the DB layer.
A real fix (column-level RLS or a dedicated RPC) is a larger, separate
change.

## No changes needed (confirmed, not touched)
- `lib/api/auth.ts`, `lib/api/errors.ts`, `lib/api/response.ts`,
  `lib/supabase/client.ts` — reused as-is.
- `lib/supabase/types.ts` — `users.Update` already typed for `{ role }`.

## Verification
- `bun run typecheck` — passes.
- `bun run lint` — passes.
- `bun run test` — 12 suites / 132 tests pass (20 new for this route; no
  regressions in the suites pulled in by the `origin/main` merge).
- `bun run format:check` — the 4 files this issue touched are formatted;
  16 pre-existing files flagged by prettier (brought in by the
  `origin/main` merge, e.g. `tests/integration/rls/**`, README.md,
  tsconfig.json) were already unformatted before this change and are out of
  this issue's scope.

## What a reviewer should focus on
- BR-12's exact trigger condition (`target.role === "admin" && newRole !==
  "admin"`, count ≤ 1) — confirm it never fires for promotions or same-role
  no-ops, and always fires for self-demotion identically to any other
  demotion.
- The 404-not-403 decision for missing/cross-group targets (Open Question 1
  in `spec.md`).
- The `old_value`/`new_value` metadata key choice against #29's actual
  contract, not just the issue text.
