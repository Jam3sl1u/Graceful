---
description: Create a branch from main, pull the oldest open GitHub issue, and run the full 4-agent pipeline — plan, code, test, review — to solve it. Can be run in the background.
argument-hint: (none — always pulls the oldest open issue; runs in the background when invoked via a backgrounded agent)
---

You are the orchestrator for a four-stage feature pipeline that solves the oldest open GitHub issue in this repo. Run the four specialist subagents in order, using the Agent/Task tool. Each stage hands off through files in `.pipeline/`. Do NOT do the work yourself — delegate each stage to its agent.

**Stage 0 — Setup.**
1. Fetch open issues oldest-first: `gh issue list --state open --sort created --order asc --limit 20 --json number,title,body,url`. Then fetch in-flight PRs: `gh pr list --state open --json body,headRefName`. An issue is already claimed if any open PR's body contains `Closes #<number>` or its branch matches `issue-<number>-*` — skip those (this pipeline may already be running against them). Pick the oldest issue that isn't claimed. If there are no open issues, or every open issue is already claimed, stop and report that to the user — do not proceed.
2. Create a fresh branch off `main` for this issue: `git checkout main && git pull origin main && git checkout -b issue-<number>-<kebab-case-slug-of-title>`. Every pipeline run gets its own new branch from `main` — never reuse or build on top of a previous run's branch.
3. The fetched issue's title + body is the feature request for the Planner (replaces any free-text argument).
4. Ensure the `.pipeline/` directory exists (create it if needed).

**Stage 1 — Planner.** Invoke the `planner` agent with the issue title/body/url from Stage 0. It writes `.pipeline/spec.md`.
- After it returns, read `.pipeline/spec.md`. If it contains any **OPEN QUESTION**, STOP the pipeline and surface those questions to the user. Do not proceed until they are answered.

**Stage 2 — Coder.** Invoke the `coder` agent. It reads `.pipeline/spec.md`, implements the change, and writes `.pipeline/changes.md`.

**Stage 3 — Tester.** Invoke the `tester` agent. It reads `.pipeline/changes.md` and `.pipeline/spec.md`, writes and runs tests, and writes `.pipeline/test-results.md`.
- After it returns, read `.pipeline/test-results.md`. Note whether tests passed or failed, but continue to the Reviewer either way — the Reviewer needs to weigh in on failures.

**Stage 4 — Reviewer.** Invoke the `reviewer` agent. It reads all `.pipeline/` files plus `git diff` and writes `.pipeline/review.md` with a verdict.

**Stage 5 — Open the PR.** Do this yourself, not via a subagent.
1. Make sure everything is committed on the issue branch (`git status` should be clean; `git add` + `git commit` anything outstanding).
2. Push the branch: `git push -u origin <branch-name>`.
3. Open the PR with the `gh` CLI directly — `gh pr create --base main --head <branch-name> --title "..." --body "..."`. Do **not** use the `mcp__github` create_pull_request tool for this: it authenticates as the Claude GitHub App, and the PR would show up as opened by/with Claude instead of you. `gh pr create` uses your own `gh auth` login, so the PR is under your account.
4. Title: reference the issue, e.g. `Fix #<number>: <issue title>`.
5. Body must include:
   - `Closes #<number>` on its own line, so GitHub links the PR to the issue (and auto-closes it once you merge — it won't close on its own before then).
   - The verdict from `.pipeline/review.md`.
   - Whether the pipeline fully completed the task; if not, exactly what failed and what's still outstanding.
   - Any problems hit along the way — failed tests, blocked steps, anything the Coder/Tester/Reviewer flagged — even if the overall verdict is SHIP.
6. Never merge the PR and never push to `main` — this stage only opens the PR. The human reviews and merges.

**Final report.** Once all five stages complete, summarize for the user:
- The issue solved (number, title, URL) and the branch name created for it.
- The PR URL.
- The verdict from `.pipeline/review.md` (SHIP / NEEDS WORK / BLOCK).
- Whether tests passed.
- Any OPEN QUESTIONS, unresolved failures, or fixes the Reviewer listed.
- The paths to all four `.pipeline/` artifacts so the user can read the details.

Never merge, push to main, touch the main branch, or close the issue yourself. Committing and pushing the feature branch, and opening (not merging) the PR, are fine — the human gives final sign-off on merging and closing.
