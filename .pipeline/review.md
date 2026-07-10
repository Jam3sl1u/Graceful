# Review — Issue #28

## VERDICT: BLOCK

## Reason: pipeline artifacts belong to a different, already-shipped issue; zero code exists for #28

Issue #28 is *"[Sprint 1] Implement remove / archive member with PII anonymization"*
(`DELETE /api/church-group/members/:id`, PII anonymization instead of hard delete,
historical setlist retention, BR-12 last-admin guard, audit-log write).

Independently verified (did not trust changes.md):

- Branch: `issue-28-remove-archive-member-pii-anonymization`.
- `git rev-parse HEAD` == `git rev-parse main` == `1a5e38d`. `git diff main...HEAD` is
  **empty**; `git log main..HEAD` is **empty**. The only working-tree change is a
  modification to `.pipeline/test-results.md` (the Tester's own report).
- `app/api/church-group/members/[id]/route.ts` still exports only a stubbed
  `DELETE` → `notImplemented("DELETE /api/church-group/members/[id]")`. No handler.
- `grep -ril anonymiz` over source returns only PRD/backlog docs — no implementation.
- `.pipeline/spec.md` and `.pipeline/changes.md` describe **Issue #37 — Service Week
  CRUD** (`/api/service-weeks`, draft-setlist auto-create, chat-room open question).
  That work is already merged to `main` (PR #116). These artifacts are stale carryover
  from the previous pipeline run and do not describe #28.

Green typecheck/lint/test only reflect `main`'s existing suite; they say nothing about
#28 because no #28 code exists to exercise.

## What to fix

1. Do not sign off #28 on the current `.pipeline/` contents — they are #37's.
2. Re-run the pipeline for #28 from the Planner/Coder stage so `spec.md` and
   `changes.md` actually cover:
   - `DELETE /api/church-group/members/:id` with PII **anonymization** (not hard delete)
   - historical setlist retention
   - BR-12 last-admin guard
   - audit-log write
3. Only then can Tester/Reviewer meaningfully verify. Nothing to ship in this worktree
   right now.
