# Review — Issue #27: Role assignment & multi-admin support

## VERDICT: BLOCK

## Reason: no implementation exists, and the pipeline docs describe the wrong issue

This worktree is on branch `issue-27-role-assignment-multi-admin-support`, whose
subject (per `gh issue view 27`) is `PATCH /api/church-group/members/:id/role`
with the BR-12 last-admin guard, admin-only enforcement, and audit-log write.

### Independently verified (not just trusting test-results.md)
- `git rev-parse HEAD` == `git rev-parse main` == `dba4126`. The branch has **zero
  commits** beyond main. `git diff main...HEAD` and `git diff main..HEAD` are both
  empty. The only working-tree change is `.pipeline/test-results.md` itself.
- The issue #27 target, `app/api/church-group/members/[id]/role/route.ts`, is still
  the original stub:
  ```ts
  export async function PATCH(_req: NextRequest) {
    return notImplemented("PATCH /api/church-group/members/[id]/role");
  }
  ```
  No admin-only check, no BR-12 last-admin-demotion 422, no BR-03/BR-04 multi-admin
  handling, no audit-log write, no 403 for set_leader/member. None of AC-1..AC-5 met.

### The spec/changes docs are for a different, already-shipped issue
- `.pipeline/spec.md` and `.pipeline/changes.md` describe **issue #26** ("Member
  directory endpoint, `GET /api/church-group/members`"), not #27. `changes.md` claims
  edits to `route.ts`, `lib/supabase/types.ts`, and a new test — but those are already
  merged to `main` (PR #108, plus the PR #110 beacon-strip fix per project memory) and
  are therefore **not** in this branch's diff. The claimed "38 tests pass" reflects
  main's state, not new work for #27.

## What must happen before this can ship
1. Regenerate `.pipeline/spec.md` and `.pipeline/changes.md` for issue #27
   (role-assignment `PATCH .../[id]/role`), not #26.
2. Actually implement `app/api/church-group/members/[id]/role/route.ts`:
   - admin-only via `requireAuth` + `requireRole(["admin"])`; 403 for set_leader/member.
   - BR-12: count `role='admin'` users in the group; reject demoting the last admin
     with 422 + clear message.
   - BR-03/BR-04: promoting additional admins works with no special-casing.
   - Audit-log write (note: depends on #29 — confirm whether that dependency is landed).
   - This must be the only route that writes `users.role`.
3. Add real unit tests for the above and re-run `bun run lint`, `bun run typecheck`,
   `bun run test`.

## Operational flag
Given the recent rogue-commit incident in project memory, someone should confirm this
worktree/branch wasn't misconfigured or the spec files stale-copied from the #26 run.
The Coder stage produced nothing for #27 in this worktree.
