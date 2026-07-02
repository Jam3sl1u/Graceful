---
description: "LEGACY FALLBACK — foreground/manual only. For on-demand automated runs, prefer Workflow({name: 'handle-issues'}); see callout below. This command works down the open-issue backlog oldest-first via a freeform chat orchestrator, until the queue is empty or a safe per-run cap is hit."
argument-hint: "[max-issues] (optional, default 3 — hard cap on how many issues this run will process)"
---

> **Prefer `Workflow({name: 'handle-issues'})` instead of this command for on-demand runs.** This command's Agent-tool background path was found to be unreliable in practice: it can silently no-op (narrate "kicking off work" without doing any), and a running instance is not reliably stoppable via `TaskStop`, unlike a `Workflow`-tracked run. `.claude/workflows/handle-issues.js` is a deterministic script (one issue per invocation — call it in a loop or repeatedly for a batch) that doesn't have either failure mode. Recommended pattern for an isolated, on-demand run: `EnterWorktree({name: '...'})` → `Workflow({name: 'handle-issues', args: {issueNumber?: N}})` (runs in the background automatically) → `ExitWorktree({action: 'keep'})` to return to your main checkout immediately while it keeps working in the isolated worktree. Keep this command around as a foreground fallback for watching every subagent's reasoning live, e.g. while iterating on the agent prompt files themselves.

You are the batch orchestrator for working down the open-issue backlog. You do **not** do implementation work yourself — every issue's plan/code/test/review work happens inside the `feature` skill, which you invoke once per issue via the Skill tool. That skill already delegates to the planner/coder/tester/reviewer subagents and opens the PR; do not duplicate that logic here.

**Why a cap, not a token counter.** There's no reliable API in a plain session for "tokens remaining until the limit." The harness auto-compacts context as it fills up, so this won't crash — but a long unattended chain of full pipelines (plan+code+test+review+PR, four subagent calls each) degrades quality well before that. Treat the cap below as the safety valve, and your own judgment as a second check.

**Setup.**
1. Read `$ARGUMENTS` as MAX_ISSUES if it's a positive integer; otherwise MAX_ISSUES = 3. Do not process more than 5 in a single run even if asked — if the user wants more, tell them to run `/handle-issues` again afterward (already-claimed issues are automatically skipped, see below).
2. ISSUES_DONE = 0. PROCESSED = [] (issue number, title, PR URL, verdict — filled in as you go).

**Loop — repeat while ISSUES_DONE < MAX_ISSUES:**
1. Check the queue: `gh issue list --state open --limit 100 --json number,title,url,createdAt` — `gh issue list` has no `--sort`/`--order` flags, so sort the result by `createdAt` ascending yourself (e.g. `jq 'sort_by(.createdAt)'` or `python3`) to get oldest-first. Then `gh pr list --state open --json body,headRefName` to find issues already claimed (open PR body contains `Closes #<N>`, or branch matches `issue-<N>-*`). If every open issue is claimed, or there are no open issues, stop the loop now and go to **Final report**.
2. Invoke the `feature` skill (it independently re-derives the oldest unclaimed issue — same check as above, so this is safe even if the queue changed since step 1).
3. Increment ISSUES_DONE. Append the issue number/title/PR URL/verdict to PROCESSED.
4. Before looping again, judge honestly: has this conversation grown long enough that you're leaning on auto-compaction, or would another full pipeline risk degraded output? If so, stop early — don't wait to hit MAX_ISSUES. Say so in the final report.

**Final report.** Summarize:
- Every issue processed this run: number, title, PR URL, verdict (SHIP/NEEDS WORK/BLOCK).
- Whether you stopped because the cap was hit, the queue emptied, or a context-safety judgment call — and if the latter, say that explicitly so the user knows to just re-run `/handle-issues` rather than assuming the backlog is done.
- Any open issues still unclaimed and how many.

Never merge PRs, close issues, or push to `main` — same rules as `/feature`.

To run this fully unattended, invoke it as a backgrounded agent rather than in the foreground session, so it doesn't block your terminal while it works through the queue.
