# Spec — Issue #27: Role assignment & multi-admin support

## OPEN QUESTIONS (resolved by human decision; documented here for the record)

1. **404 vs 403 for a target user that doesn't exist or is in a different
   church group.** Resolved: always **404 NOT_FOUND** for both cases, never
   403. `requireRole(ctx, ["admin"])` already fully covers "is the caller
   allowed to call this route at all" (403); 403 for the target user would
   imply the caller could distinguish "exists in another tenant" from
   "doesn't exist" — an unwanted cross-tenant existence leak. The explicit
   `.eq("church_group_id", ctx.churchGroupId)` filter on the lookup query
   collapses both cases to "no row found" by construction.
2. **Audit-log metadata key names.** `writeAuditLog`'s own contract (issue
   #29) and its existing test fixture
   (`tests/unit/lib/audit/write-audit-log.test.ts`) use `old_value`/`new_value`
   for the `"user.role_changed"` action — used verbatim here, not
   `old_role`/`new_role`.
3. **Same-role PATCH (no-op).** Treated as a valid idempotent success: still
   performs the update and still writes an audit entry with
   `old_value === new_value`. This is a deliberate choice, not a special
   case — BR-03/BR-04 explicitly call for no identity/role special-casing.

Everything else below is unambiguous.

---

## Background: what already exists (do NOT rebuild)

- `lib/api/auth.ts` — `requireAuth`/`requireRole` (#15), already merged.
- `app/api/church-group/members/handler.ts` — GET member directory (#26),
  the pattern to mirror for auth/Supabase-client wiring.
- `lib/audit/write-audit-log.ts` + `write_audit_log` RPC (#29) — merged into
  this branch from `origin/main` as a prerequisite for this issue (this
  branch was 15 commits behind `origin/main` at the start of this work,
  missing #29/#30/#31/#33; brought current via `git merge origin/main`
  before any #27 code was written).
- `types/domain.ts` — `UserRole = "admin" | "set_leader" | "member" | "guest"`.
- `lib/supabase/types.ts` — `users.Update = Partial<UsersRow>` already
  supports `{ role }`; no type-generation change needed.

## The gap this issue closes

`app/api/church-group/members/[id]/role/route.ts` was a `notImplemented`
stub (a prior automated pipeline run produced zero code for this issue — see
git history `6499592`/`dba4126` — both Tester and Reviewer correctly
self-blocked rather than ship it). This spec covers the actual
implementation.

## Files to create / modify

### 1. `schemas/role.ts` (new)
`z.object({ role: z.enum(["admin", "set_leader", "member", "guest"]) })`,
mirroring the style of `schemas/church-group.ts`.

### 2. `app/api/church-group/members/[id]/role/handler.ts` (new)
`patchMemberRole(req, targetUserId, lookup?)`. Control flow, each failure
short-circuiting inside one try/catch (`ApiException` → `fail()`):

1. `requireAuth` → 401 `UNAUTHENTICATED`.
2. `requireRole(ctx, ["admin"])` → 403 `FORBIDDEN` for set_leader/member/guest.
   This is the **sole** enforcement of "admin-only" and "only route that
   writes `users.role`" — the `users_update_leader_admin` RLS policy is
   broader (permits set_leader-or-admin at the DB layer, no column-level
   granularity). Noted as a code comment; not a fix target for this issue.
3. JWT → `getSupabaseClient(jwt)`; missing token → 401.
4. Validate body (`updateRoleSchema`) → 400; validate the path `id` is a
   UUID → 400.
5. Look up the target user scoped to `ctx.churchGroupId` → 404 if missing or
   cross-group (see Open Question 1); 500 on DB error.
6. **BR-12**: only when `target.role === "admin" && newRole !== "admin"`,
   count admins in the group; if count ≤ 1 → 422 `VALIDATION_FAILED`
   ("Cannot demote the last remaining admin..."). No special-casing for
   promotions (BR-03/BR-04) or self-demotion — the rule keys off
   `target.role`/group count, not identity.
7. `update({ role: newRole })` scoped by id + church_group_id → 500 on
   error/no row.
8. `writeAuditLog(supabase, { action: "user.role_changed", entityType:
   "user", entityId: targetUserId, metadata: { old_value, new_value } })` —
   a throw here propagates through the outer catch as 500.
9. `return ok({ id, role })`.

### 3. `app/api/church-group/members/[id]/role/route.ts` (rewrite from stub)
Thin wrapper unwrapping Next 15's async `params`, delegating to the handler
— matches `app/api/instruments/[id]/route.ts`'s pattern exactly.

### 4. `tests/unit/app/api/church-group-members-role-route.test.ts` (new)
See Definition of Done for coverage.

## Definition of done
- All ACs from the issue met: admin-only (403 otherwise), BR-12 422 on
  last-admin demotion, BR-03/BR-04 unlimited co-admins with no
  special-casing, audit log written, only this route writes `users.role`.
- `bun run typecheck`, `bun run lint`, `bun run test`, `bun run format:check`
  all pass.
