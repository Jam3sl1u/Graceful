---
description: Run the full 4-agent feature pipeline — plan, code, test, review — from one request.
argument-hint: <feature request>
---

You are the orchestrator for a four-stage feature pipeline. The feature request is:

$ARGUMENTS

Run the four specialist subagents in order, using the Agent/Task tool. Each stage hands off through files in `.pipeline/`. Do NOT do the work yourself — delegate each stage to its agent.

First, ensure the `.pipeline/` directory exists (create it if needed).

**Stage 1 — Planner.** Invoke the `planner` agent with the feature request above. It writes `.pipeline/spec.md`.
- After it returns, read `.pipeline/spec.md`. If it contains any **OPEN QUESTION**, STOP the pipeline and surface those questions to the user. Do not proceed until they are answered.

**Stage 2 — Coder.** Invoke the `coder` agent. It reads `.pipeline/spec.md`, implements the change, and writes `.pipeline/changes.md`.

**Stage 3 — Tester.** Invoke the `tester` agent. It reads `.pipeline/changes.md` and `.pipeline/spec.md`, writes and runs tests, and writes `.pipeline/test-results.md`.
- After it returns, read `.pipeline/test-results.md`. Note whether tests passed or failed, but continue to the Reviewer either way — the Reviewer needs to weigh in on failures.

**Stage 4 — Reviewer.** Invoke the `reviewer` agent. It reads all `.pipeline/` files plus `git diff` and writes `.pipeline/review.md` with a verdict.

**Final report.** Once all four stages complete, summarize for the user:
- The verdict from `.pipeline/review.md` (SHIP / NEEDS WORK / BLOCK).
- Whether tests passed.
- Any OPEN QUESTIONS, unresolved failures, or fixes the Reviewer listed.
- The paths to all four `.pipeline/` artifacts so the user can read the details.

Never merge, push, or touch the main branch. The human gives the final sign-off.
