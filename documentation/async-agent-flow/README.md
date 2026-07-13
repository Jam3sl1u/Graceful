# Async Agent Flow — `/handle-issues`

This folder packages the `/handle-issues` autonomous pipeline for a new team
member. It does **not** duplicate the actual mechanism — that already lives
in this repo, tracked in git, and you get it for free by cloning:

| File | What it is |
| --- | --- |
| `AGENTS.md` (repo root) | Vendor-neutral pipeline contract + git/PR policy |
| `.claude/commands/handle-issues.md` | The batch orchestrator (the "skill" you invoke as `/handle-issues`) |
| `.claude/workflows/handle-issues.js` | The per-issue Workflow script it delegates to |
| `.claude/agents/{planner,coder,tester,reviewer}.md` | The four pipeline-stage subagents |
| `.claude/settings.json` + `.claude/hooks/block-main-branch.sh` | Permission allowlist + runtime guardrail against committing/pushing to `main` |

What's genuinely new in this folder is the **operational knowledge** that
doesn't travel with `git clone` — it lives in the original author's personal
memory store, not the repo:

- **[skill.md](skill.md)** — human-facing guide to what `/handle-issues` does
  and how to run it. Read this first.
- **[memory.md](memory.md)** — the accumulated gotchas, incidents, and
  execution patterns discovered while running this pipeline in production.
  Read this *before* running the pipeline unattended, and paste it into your
  own Claude memory (or just keep it open) so you don't rediscover the same
  bugs the hard way.

## Setup for a new team member

**Comes for free with the clone** (already committed to git — see the table
above): the command, the workflow script, the subagents, the pipeline
contract, and the permission allowlist + branch-protection hook.

**You need to set up yourself** — none of this travels with `git clone`:

1. Clone the repo and confirm `bun install` succeeds.
2. Authenticate `gh` (`gh auth status`) with your own personal GitHub
   account that has write access to this repo — PRs are opened under the
   operator's own credentials, not a shared bot identity.
3. Confirm your Claude Code plan/session actually exposes the harness-level
   tools this pipeline depends on: `Workflow`, `EnterWorktree`/
   `ExitWorktree`, `AskUserQuestion`, `ScheduleWakeup`. These are session
   features, not repo config — if they're unavailable, the pipeline can't
   run regardless of what's checked into git.
4. Know that `.claude/settings.local.json` is **not tracked** (excluded by
   a global gitignore rule, not the repo's own `.gitignore`) — it's
   personal to each machine. Expect your own local permission-approval
   prompts the first few times you run things; this is separate from the
   project-level allowlist in `.claude/settings.json`, which is committed
   and applies to you automatically.
5. Know that `.claude/state/handle-issues-runs.json` is gitignored too
   (ephemeral per-checkout run bookkeeping) — you'll start with a clean
   slate, not resume runs from anyone else's machine.
6. Read `skill.md`, then `memory.md` — the latter is the substitute for
   operational knowledge that otherwise lives only in the original author's
   private Claude memory, not in the repo. Actually read it, don't just
   keep it as a reference — it covers real incidents that shipped bad PRs
   before the fixes landed.
7. Run `bun run check:workflows` once to confirm your checkout's
   `.claude/workflows/*.js` still satisfies the working-directory contract
   (this is also enforced in CI).
