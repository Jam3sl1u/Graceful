@AGENTS.md

## Claude Code-specific notes

- The four pipeline stages (planning/coding/testing/review) are implemented
  as subagents in `.claude/agents/*.md`. Their model/tool assignments are
  Claude-Code-specific and live only in that frontmatter, not in AGENTS.md.
- Orchestration (`.claude/commands/feature.md`, `.claude/commands/handle-issues.md`,
  `.claude/workflows/handle-issues.js`) implements the AGENTS.md pipeline
  contract and git/PR policy using this harness's own tools (`Workflow`,
  `agent()`, `EnterWorktree`) — it is not portable to other agent harnesses.
- Any new script under `.claude/workflows/` must implement AGENTS.md's
  "Orchestration working-directory contract" using the `pin()`-style helper
  pattern in `handle-issues.js` (wrap every `agent()` prompt so it re-asserts
  its working directory before doing anything else) and must pass
  `bun run check:workflows`, which enforces this mechanically.
