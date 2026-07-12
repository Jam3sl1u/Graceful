---
description: Claim a specific GitHub issue and run the full plan/code/test/review pipeline to solve it, resuming a prior run if one exists.
argument-hint: "<issue-number> — the GitHub issue number to solve (required — this no longer picks the oldest open issue for you)"
---

You are a thin wrapper around the same pipeline `.claude/commands/handle-issues.md` uses for a single issue — do not reimplement any of its git/gh/PR logic yourself. All policy (branch-linking, PR authoring, never touch main) lives in `AGENTS.md` and `.claude/workflows/handle-issues.js`; this command only drives the Workflow tool and the resume state file for one issue.

1. Parse `$ARGUMENTS` as one issue number. If missing or not a positive integer, stop and ask for one.
2. Read `.claude/state/handle-issues-runs.json` if it exists (empty object `{}` otherwise). Look up the entry for this issue number.
3. Determine `resumeFromRunId`: if an entry exists with `status` NOT in `shipped`/`abandoned`, use its `runId`; otherwise omit it (fresh run).
4. Call `Workflow({scriptPath: '.claude/workflows/handle-issues.js', resumeFromRunId, args: {issueNumber: N, humanAnswer: entry?.pendingHumanAnswer}})`.
5. From the tool call's result, take the returned `runId` and the script's own return value (`status`, `issue`, `prUrl`, `verdict`). Write/update the entry in `.claude/state/handle-issues-runs.json`: `{runId, status, phaseReached: status, updatedAt: <now>, attempts: (prior attempts ?? 0) + 1, pendingHumanAnswer: null, prUrl, verdict}`.
6. If `status` is `blocked-on-question`: use `AskUserQuestion` with the returned `summary` as the question (offer the planner's own proposed resolution as one option if it suggested one, plus room for a different answer). Once answered, set `pendingHumanAnswer` on the state entry and go back to step 3 (this time `resumeFromRunId` will be set, so the planner's already-completed work replays from cache instead of rerunning). Repeat if it blocks again on a different question.
7. If `status` ends in `-failed`: check `attempts` on the state entry. If `attempts >= 3`, mark the entry `status: 'abandoned'` (terminal), stop, and report the failure to the user instead of retrying again. Otherwise, go back to step 3 to retry — `resumeFromRunId` means only the failed phase and anything after it actually re-runs.
8. Once `status` is `shipped` (or `abandoned`), report to the user: issue number/title/URL, PR URL, verdict, and the `.pipeline/*` artifact paths so they can read the details.

Never merge, push to main, or close the issue yourself — the workflow and this repo's `.claude/settings.json` permissions/hooks already enforce this.
