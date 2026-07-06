---
description: Process a specific list of GitHub issue numbers, each in its own isolated worktree, by delegating to the handle-issues Workflow. Meant to run unattended/in the background.
argument-hint: "<issue-numbers> — one or more issue numbers, e.g. \"23 45 67\" (required — this no longer scans the backlog for you)"
---

You are the batch orchestrator for a specific list of GitHub issue numbers. You do **not** do implementation work yourself — every issue's claim/branch-link/plan/code/test/review/PR work happens inside `.claude/workflows/handle-issues.js`, invoked once per issue via the `Workflow` tool. Do not duplicate that logic here.

**Setup.**
1. Parse `$ARGUMENTS` as a whitespace/comma-separated list of issue numbers. If it's empty or contains anything that isn't a positive integer, stop and ask the user for explicit issue numbers — do NOT fall back to scanning the open-issue backlog for "oldest unclaimed" or anything similar. Issue numbers are always provided by the caller now.
2. PROCESSED = [] (issue number, title, PR URL, verdict, or failure status — filled in as you go).

**Loop — for each issue number, in the order given, one at a time (not in parallel — this avoids two orchestrators touching the same repo state concurrently):**
1. `EnterWorktree` to get a fresh, isolated worktree for this issue. Each issue gets its own worktree, opened right before its run and closed right after — issues are never processed in a worktree left over from a previous issue in this same loop.
2. Invoke `Workflow({scriptPath: '.claude/workflows/handle-issues.js', args: {issueNumber: <N>}})` — use `scriptPath` (not `name`) on every call in this loop, including the first: repeated `Workflow({name:...})` calls in one session can silently reuse a stale script snapshot from an earlier call, `scriptPath` forces a fresh read every time. The workflow itself claims the issue and creates/links its branch as its very first action, before any planning.
3. Sanity-check the result: confirm the returned `issue.number` matches the `<N>` you requested (a silent mismatch is the signature of the stale-snapshot bug above — if it doesn't match, stop and report this explicitly rather than continuing the loop).
4. `ExitWorktree` to close out this issue's isolated worktree before moving to the next one.
5. Append the issue number/title/PR URL/verdict/status to PROCESSED.
6. Before moving to the next issue, judge honestly: has this conversation grown long enough that you're leaning on auto-compaction, or would another full pipeline risk degraded output? If so, stop early and say so in the final report — don't push through the remaining issue numbers.

**Final report.** Summarize:
- Every issue number requested, whether it was processed, and its outcome (PR URL + verdict, or the failure/blocked status returned by the workflow).
- Any issue numbers not reached because you stopped early for context-safety reasons.

Never merge PRs, close issues, or push to `main` — the workflow and the repo's `.claude/settings.json` permissions/hooks already enforce this; do not attempt to work around them.

To run this fully unattended, invoke it as a backgrounded agent rather than in the foreground session, so it doesn't block your terminal while it works through the list.
