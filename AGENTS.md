# AGENTS.md — repo conventions and pipeline contract

This file is the vendor-neutral source of truth for how AI coding agents should
work in this repo, regardless of which tool is driving them. It intentionally
avoids naming any specific tool's internals — anything that names actual tool
calls (subagent frontmatter, orchestration scripts) lives under `.claude/` and
is that tool's own wiring around the conventions described here.

## Repo conventions

This repo uses Bun for package management and scripts:
- Install dependencies with `bun install`.
- Run package.json scripts with `bun run <script>` (e.g. `bun run lint`,
  `bun run typecheck`, `bun run test`). `bun run test` runs Jest — do not use
  the bare `bun test` native runner, it's incompatible with this repo's test
  layout.
- Use `bun audit` for dependency scanning.
- Do not use npm, yarn, or pnpm, and do not reference them in specs, code, or
  commit messages.

## Pipeline contract

Feature work in this repo flows through four stages: a planning stage, an
implementation stage, a testing stage, and a review stage. Each stage reads
the prior stage's output and writes its own to `.pipeline/`, which is the
durable, git-tracked handoff format between stages (and between agents,
regardless of which AI system is running them):

| File               | Written by  | Read by   | Contents                             |
| ------------------ | ----------- | --------- | ------------------------------------- |
| `spec.md`          | Planning    | Coding    | Implementation spec + OPEN QUESTIONS  |
| `changes.md`       | Coding      | Testing   | Summary of what changed and where     |
| `test-results.md`  | Testing     | Review    | Pass/fail report                      |
| `review.md`        | Review      | Human     | Verdict: SHIP / NEEDS WORK / BLOCK    |

Each run overwrites these files — they reflect the most recent run only, not
a running history. A genuine blocking ambiguity gets flagged as an
**OPEN QUESTION** at the top of `spec.md`, and every downstream stage stops
rather than guessing until a human resolves it.

- **Planning**: read the actual current state of the relevant code (do not
  assume) and write a concrete, actionable spec scoped only to the issue at
  hand — files to touch, signatures, edge cases, and which existing patterns
  to copy. Do not write implementation code.
- **Coding**: implement exactly what the spec describes, no scope creep, no
  unrelated refactors. Verify the change (lint/typecheck/test) before
  finishing.
- **Testing**: independently verify the implementation's claims rather than
  trusting them — cover the happy path, the spec's named edge cases, and at
  least one failure case. A failing test pauses the pipeline for review; it
  is not something this stage patches around.
- **Review**: read every `.pipeline/` artifact plus the actual diff, and
  judge critically — green tests are not the same as correct behavior. This
  is the last line of defense before a human sees the result.

## Git / PR policy

- Work happens on a branch linked to the originating issue through your git
  host's own issue-linking mechanism (e.g. GitHub's "Development" sidebar),
  not just a branch name that merely implies the link.
- If a branch already exists and is linked to the issue, resume work on it
  rather than creating a duplicate.
- If working in an isolated worktree, switch branches via a detached
  checkout of the remote default branch (never check out the shared local
  default branch — another worktree may have it checked out already).
- Open pull requests under the human operator's own git host credentials,
  not a bot/app identity, so authorship and attribution are correct.
- Never request the PR author as their own reviewer.
- Never merge a PR, never push directly to the default branch, never close
  the originating issue. A human gives final sign-off on all of those.
