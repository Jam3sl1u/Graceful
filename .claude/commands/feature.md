---
description: Claim a specific GitHub issue, create and link its branch, and run the full 4-agent pipeline — plan, code, test, review — to solve it. Can be run in the background.
argument-hint: "<issue-number> — the GitHub issue number to solve (required — this no longer picks the oldest open issue for you)"
---

You are the orchestrator for a four-stage feature pipeline that solves a specific GitHub issue in this repo, given as `$ARGUMENTS`. Run the four specialist subagents in order, using the Agent/Task tool. Each stage hands off through files in `.pipeline/`. Do NOT do the work yourself — delegate each stage to its agent.

**Stage 0 — Setup.**
1. Parse `$ARGUMENTS` as the issue number. If it's missing or not a positive integer, stop and ask the user for one — do not fall back to scanning the backlog for the oldest open issue.
2. Fetch it: `gh issue view <number> --json number,title,body,url`.
3. Claim it immediately, before any planning work: `gh issue edit <number> --add-assignee @me` (assigns the issue to the currently authenticated `gh` user).
4. Create AND link a branch to the issue in one step, so it shows up in the issue's own GitHub "Development" sidebar (not just associated by naming convention): `git fetch origin main && gh issue develop <number> --name issue-<number>-<kebab-case-slug-of-title> --base origin/main --checkout`. If a linked branch already exists for this issue (`gh issue develop <number> --list`), check it out instead of creating a duplicate. Do NOT use plain `git checkout -b` for this.
5. The fetched issue's title + body is the feature request for the Planner.
6. Ensure the `.pipeline/` directory exists (create it if needed).

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
