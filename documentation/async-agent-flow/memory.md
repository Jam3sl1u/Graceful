# Operational memory: `/handle-issues`

This is a distilled record of everything learned the hard way while running
the `/handle-issues` pipeline in this repo. None of this lives in git — it
was accumulated across sessions in one person's private Claude memory. If
you're picking up this pipeline for the first time, read this end to end
before running it unattended on real issues. If your own Claude setup has a
persistent memory system, consider pasting the relevant sections in as your
own memory entries.

Current as of **2026-07-12**.

---

## 1. The pipeline only runs issues you name — never a backlog scan

`args.issueNumber` (or the numbers passed to `/handle-issues`) is a hard
requirement. There is no "pick the oldest unclaimed issue" fallback — that
was deliberately removed. If you invoke it with no issue numbers, it fails
fast (`status: 'no-op'`) rather than guessing what to work on. Never try to
have it derive "the next issue" itself.

## 2. Run the batch loop in the foreground, not as a backgrounded subagent

Delegating the `/handle-issues` orchestrator loop to a background `Agent`
subagent fails: `Workflow` and `AskUserQuestion` are not available to
Agent-tool subagents (confirmed via direct `ToolSearch` — `EnterWorktree`/
`ExitWorktree` resolve fine, those two don't), even though a
general-purpose subagent nominally has `Tools: *`. Without `Workflow` the
subagent can't invoke `handle-issues.js` at all.

**Apply:** run the `EnterWorktree → Workflow → (AskUserQuestion if
blocked) → ExitWorktree` loop directly in your main/foreground session.
This blocks your terminal for the duration of the batch — that's expected,
not a bug. If you need a truly unattended/background run, that needs a
different mechanism (a scheduled/cron routine), not a plain subagent.

## 3. Process issues one at a time, never in parallel

Two orchestrators touching the same repo state concurrently is exactly the
kind of thing that produces the cwd-drift bug in §5. Each issue gets its
own worktree, opened right before its run and closed right after — never
reused from a previous issue in the same loop.

## 4. Don't poll a backgrounded `Workflow` call — use `ScheduleWakeup`

`Workflow(...)` returns a task ID immediately, not a final result. Rather
than polling, call `ScheduleWakeup` with a long fallback delay (~1200s)
whose prompt restates exactly where to resume. The real signal is the
`<task-notification>` on completion; `ScheduleWakeup` is just the safety
net for a missed notification, not the primary wait mechanism.

## 5. `status: shipped` ≠ a clean review — always check `verdict` separately

Every completed run returns two independent fields. `status: shipped`
only means a PR was opened. `verdict` (`SHIP` / `NEEDS WORK` / `BLOCK`)
is the reviewer's actual judgment. A shipped PR with `verdict: BLOCK` must
be surfaced to whoever's watching as needing attention — don't fold it
into a blanket "N issues shipped" success message.

## 6. Verify a worktree is push-safe *before* removing it

Before `ExitWorktree({action: "remove"})`, check
`git log @{u}..HEAD --oneline` is empty (i.e. HEAD is fully pushed to the
remote branch backing the PR) — don't just trust the tool. Separately,
`ExitWorktree({action:"remove"})` has been observed to leave the local
branch ref alive even though it claims to delete both the worktree and the
branch. After removal, `git branch --list "<name>*"` and force-delete with
`git branch -D` if it's still there — otherwise a later run against the
same issue can silently resume the supposedly-discarded branch, including
its stale commits.

## 7. `args` arrives JSON-stringified, not as a real object

Any `Workflow` script that reads `args.someField` directly gets `undefined`
even when the tool call itself received a proper object — `args` shows up
inside the script as a JSON string. `handle-issues.js` already guards
against this:

```js
const issueArgs = typeof args === 'string' ? JSON.parse(args) : args
```

If you write a *new* workflow script, copy this pattern — the underlying
harness behavior is unfixed, this is a per-script workaround.

## 8. Repeated `Workflow({name: ...})` calls can silently run a stale script

Only the first `Workflow({name: 'handle-issues'}, ...)` call in a session
reliably reads the current on-disk script; the 2nd/3rd+ calls can silently
reuse a cached snapshot from the first call, even if the file on disk has
since changed. **Always use `scriptPath` (not `name`) from the second call
onward** in any loop — this forces a fresh read every time. This is also
why every result should be sanity-checked: confirm the returned
`issue.number` matches what you actually requested, since a silent
fallback to a stale/wrong issue is easy to miss when the run still
"completes successfully."

## 9. Editing the workflow script mid-session doesn't reach an open worktree

A git worktree has its own independent working-tree copy of tracked files.
If you're pinned inside `.claude/worktrees/<name>/` and you edit
`.claude/workflows/handle-issues.js` in the **main checkout**, the open
worktree's `Workflow` calls keep reading the old, unedited copy — it looks
exactly like "the fix didn't take" / "the same bug again," costing a full
wasted pipeline run before you notice the two files have diverged. Either
edit the file inside the worktree directly, or `cp` the fixed file into the
worktree's matching path before relaunching `Workflow` there.

## 10. The cwd-drift incident (issues #41/#42, 2026-07-12) — read this one carefully

This is the most serious incident on record and the reason the pipeline now
has independent verification gates instead of trusting subagent self-report.

**What happened:** only the *first* `agent()` call in a `Workflow` launched
from inside an `EnterWorktree` worktree reliably inherits that worktree's
cwd. Every later call re-resolves against the caller's *live* current
directory at the moment it fires — which had drifted back to the main repo
root mid-run. Setup/Coder/Tester happened to land in the right place, but
Planner and Reviewer silently wrote `.pipeline/spec.md` /
`.pipeline/review.md` into the **main repo root** instead of the pinned
worktree. The coder then read a stale spec describing an unrelated,
already-shipped issue, correctly reported `done: false` — but the script at
the time never checked that flag, and shipped a PR with **zero real code**
anyway.

A second, related bug compounded it: `gh issue develop <N> --list` stops
listing a branch once it has an open PR against it. A retry's Setup stage,
trusting only that command, concluded no branch existed and created a
second duplicate empty branch instead of resuming the real one.

**What's fixed now** (already live in this repo's `handle-issues.js`, so
you get it for free — this section is context, not a to-do):

- Every `agent()` prompt is wrapped in a `pin()` helper that prepends an
  explicit `pwd`-check-then-`cd` instruction using an absolute
  `worktreePath` passed through `args`. Every stage is now self-correcting
  regardless of what the caller's live cwd actually is.
- Setup falls back to `git branch -a --list` and `gh pr list --search` in
  addition to `gh issue develop --list`, and prefers any existing
  non-scratch branch over creating a new one.
- An independent, deliberately *mechanical* verify step runs right after
  the coder stage: raw `git status --porcelain` / `git diff --stat`
  output only, no judgment call, no reading files. If the non-`.pipeline`
  diff is empty, the run fails as `coder-verify-failed` regardless of what
  the coder itself claimed.
- The same check runs again immediately before opening the PR (last-mile
  guard) — aborts as `ship-aborted` rather than shipping an empty PR even
  if every earlier gate somehow got fooled.
- `bun run check:workflows` (CI-blocking) statically verifies every
  `.claude/workflows/*.js` wraps all its `agent()` calls in `pin(...)`.
  This is the mechanical enforcement of `AGENTS.md`'s "Orchestration
  working-directory contract" — read that section if you're ever writing a
  *new* workflow script, not just modifying this one.

**What's explicitly NOT covered — this is the important part for you as
the human operator:** the verify-gates prove a diff exists and is
committed. They do **not** prove the diff is *correct*. The reviewer
subagent is the only semantic check, and it's the same vendor/model family
as the coder — not a truly independent check. **Keep manually diffing
every shipped PR before merging**, verdict SHIP or not, until you've built
up enough confidence from clean runs to taper that off. Never grant this
pipeline merge/close/push-main rights regardless — that's enforced
mechanically by `.claude/hooks/block-main-branch.sh` and
`.claude/settings.json`, don't work around it.

## 11. Rate limits are not pipeline failures — don't burn a retry attempt on them

If a `Workflow` call fails because of a session/usage limit (detectable in
its `<failures>` diagnostics via text like "session limit", "usage limit",
or "resets at ..."), that's not a real blocker and shouldn't count against
the 3-attempt-then-abandon cap. Parse the reset time if present: bounded
wait (poll `date` in a loop) if it's within ~30 minutes, otherwise use a
scheduled one-shot resumption for later. Cap silent rate-limit retries at 2
so a bug in the detection regex can't cause an infinite loop.

## 12. A `blocked-on-question` result needs an immediate human prompt, not a queue

A `Workflow` run can't pause mid-flight and wait for input — once control
returns to the orchestrator with `status: blocked-on-question`, surface it
immediately via `AskUserQuestion` (using the planner's own proposed
resolution as one of the options) rather than parking it and moving to the
next issue. Once answered, resume the **same issue in the same still-open
worktree** with `resumeFromRunId` set — don't `ExitWorktree` first, and
don't give up if it comes back blocked a second time with a different
question; ask again.

---

## Quick-reference: what NOT to do

- Don't invent a backlog-scanning fallback — issue numbers are always
  explicit.
- Don't background the orchestrator loop as an `Agent` subagent.
- Don't process more than one issue at a time.
- Don't poll a backgrounded `Workflow` call in a tight loop.
- Don't treat `status: shipped` as equivalent to a passing review.
- Don't trust `ExitWorktree`'s claim that it deleted the branch — verify.
- Don't call `Workflow({name: ...})` more than once per session — use
  `scriptPath` from the second call on.
- Don't edit `.claude/workflows/*.js` in the main checkout and expect an
  already-open worktree to see it.
- Don't skip manually diffing a shipped PR, even on `verdict: SHIP`.
- Don't let this pipeline merge PRs, push to `main`, or close issues —
  that's a human's call, always.
