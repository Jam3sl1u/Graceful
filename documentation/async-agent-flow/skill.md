# Skill: `/handle-issues`

## What it does

`/handle-issues <issue-numbers...>` takes a list of GitHub issue numbers you
give it explicitly and, for each one in turn, runs the full four-stage
pipeline (plan → code → test → review) and opens a PR — unattended. It does
**not** decide which issues to work on; you always supply the numbers.

Example:

```
/handle-issues 41 42 45
```

This processes issue #41, then #42, then #45, one at a time (never in
parallel — two orchestrators touching the same repo state concurrently is
exactly what caused a real incident, see `memory.md`).

## How it's wired (already in this repo, nothing to install)

```
/handle-issues  (.claude/commands/handle-issues.md)
   │  parses issue numbers, loops one issue at a time
   ▼
EnterWorktree            — fresh, isolated git worktree per issue
   ▼
Workflow(handle-issues.js) — claims issue, links branch, runs 4 subagent stages, opens PR
   │     ├─ planner  → .pipeline/spec.md
   │     ├─ coder    → implements spec, commits
   │     ├─ tester   → .pipeline/test-results.md
   │     └─ reviewer → .pipeline/review.md, verdict SHIP/NEEDS WORK/BLOCK
   ▼
ExitWorktree              — closes out the worktree, verified push-safe first
```

Full contract (planning/coding/testing/review responsibilities, `.pipeline/`
file handoff format, git/PR policy) is documented in [`AGENTS.md`](../../AGENTS.md)
at the repo root — that's the source of truth, not this file.

## Per-issue outcome — two fields, not one

Every processed issue reports back **two independent signals** — check both:

- `status` — `shipped` means a PR was opened. It does **not** mean the
  review passed.
- `verdict` — `SHIP` / `NEEDS WORK` / `BLOCK`, from the reviewer subagent.

A `status: shipped` PR with `verdict: BLOCK` needs your attention just as
much as an outright failure — don't read "shipped" as "done."

## What you're responsible for as the human operator

Per `AGENTS.md`'s git/PR policy (also mechanically enforced by
`.claude/hooks/block-main-branch.sh`):

- The pipeline never merges a PR, never pushes to `main`/`master`, never
  closes the originating issue, and never requests you as your own
  reviewer. All of that is on you.
- **Manually diff every shipped PR before merging it**, even a
  `verdict: SHIP` one. The pipeline's own verify-gates (see `memory.md`)
  prove a real diff was committed — they don't prove it's *correct*. The
  reviewer subagent is the same vendor/model family as the coder subagent,
  so it isn't a fully independent check.
- If a run comes back `blocked-on-question`, the planner found a genuine
  ambiguity it refused to guess on — you'll be prompted with the question
  and the planner's own proposed resolution(s) via `AskUserQuestion`.

## Resuming / retrying

Runs are stateful via `.claude/state/handle-issues-runs.json` (gitignored,
ephemeral). Re-running `/handle-issues <same numbers>` resumes any
non-terminal issue (any `*-failed` status, or `blocked-on-question`) from
where it left off — only the failed phase and anything after it re-runs,
the rest replays from cache. `shipped` and `abandoned` are terminal and
won't be re-attempted.

## Prerequisites

- `gh` CLI authenticated as **you** (not a bot) — `gh auth status`.
- `bun install` run at least once.
- Push access to the repo (PRs go up under your own GitHub identity).

## Before running this unattended for the first time

Read [`memory.md`](memory.md) in this folder. It's a distilled record of
bugs that actually shipped bad PRs in production before they were fixed —
knowing the failure modes (and that the fixes are gated by
`bun run check:workflows` in CI) will save you from re-diagnosing something
that's already a known, closed issue.
