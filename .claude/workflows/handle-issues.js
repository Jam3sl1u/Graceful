export const meta = {
  name: 'handle-issues',
  description: 'Process exactly one GitHub issue, given explicitly via args.issueNumber, through claim/branch-link/plan/code/test/review and open a PR for it.',
  phases: [
    { title: 'Setup' },
    { title: 'Plan' },
    { title: 'Code' },
    { title: 'Test' },
    { title: 'Review' },
    { title: 'Ship' },
  ],
}

// This workflow only ever handles ONE issue per invocation, start to finish, before
// returning. No loop, no parallel()/pipeline() -- to process another issue, invoke this
// workflow again. That keeps exactly one agent active at a time and makes each run trivial
// to reason about and resume (Workflow({name: 'handle-issues', resumeFromRunId: ...})).
//
// INVOCATION CONTRACT: if launching this from inside an EnterWorktree-created worktree for
// isolation, the caller must stay cwd-pinned to that worktree for the entire run -- do not
// call ExitWorktree (or otherwise change the session's current directory) until this run
// completes. Only the FIRST agent() call below reliably inherits the worktree's cwd; every
// later agent() call re-resolves against the caller's *live* current directory at the moment
// it fires. Exiting the worktree right after launch causes every stage past the first to
// silently execute against whatever directory the caller moved to instead -- verified via
// live testing, not a theoretical concern.

phase('Setup')

// The Workflow runtime delivers `args` JSON-stringified rather than as the real
// object/array that was passed in -- confirmed via a minimal repro. Without this,
// `args.issueNumber` is always undefined (since `args` is a truthy string), so a
// specific issueNumber request silently fell through to the "scan everything, pick
// oldest unclaimed" branch below every single time.
const issueArgs = typeof args === 'string' ? JSON.parse(args) : args

async function abandonStaleBranchIfEmpty(issueNumber, reasonLabel) {
  const result = await agent(
    `A previous stage for issue #${issueNumber} did not complete normally (${reasonLabel} -- most likely a token/usage limit or transient failure, not a real blocker). Before this issue can be retried cleanly, in this repo's working directory:\n1. Find the local branch matching \`issue-${issueNumber}-*\` exactly (there should be at most one -- if none exists, there's nothing to clean up, report that and stop).\n2. Check how many commits it has beyond \`origin/main\`: \`git rev-list --count origin/main..<branch>\`.\n3. If that count is 0 (no real work committed yet -- e.g. only the empty branch-creation checkout happened before the stoppage): switch off the branch WITHOUT checking out local \`main\` (this working directory may be an isolated worktree where \`main\` is already checked out elsewhere) -- use \`git checkout --detach origin/main\`, then delete the stale branch: \`git branch -D <branch-name>\`. This lets the next run start completely fresh instead of resuming a half-done branch.\n4. If that count is greater than 0, DO NOT delete anything -- there is real committed work on the branch. Just report the branch name and commit count so a human can decide what to do with it.\n5. NEVER touch origin or any remote branch (no push, no remote delete, no force-push) -- only ever operate on the local branch.\nReport what you found and whether you deleted the branch.`,
    {
      phase: 'Setup',
      label: `abandon:${issueNumber}`,
      schema: {
        type: 'object',
        properties: {
          branchFound: { type: 'boolean' },
          deleted: { type: 'boolean' },
          commitsAheadOfMain: { type: 'number' },
        },
        required: ['branchFound', 'deleted'],
      },
    }
  )
  if (result) {
    log(`Cleanup for issue #${issueNumber}: branchFound=${result.branchFound}, deleted=${result.deleted}${result.commitsAheadOfMain != null ? `, commitsAheadOfMain=${result.commitsAheadOfMain}` : ''}`)
  } else {
    log(`Cleanup agent for issue #${issueNumber} itself failed to complete -- branch state unknown, leaving as-is.`)
  }
  return result
}

if (!issueArgs || !issueArgs.issueNumber) {
  log('No issueNumber provided in args -- this workflow always requires an explicit issue number now (no backlog scan). Invoke it as Workflow({..., args: {issueNumber: N}}).')
  return { status: 'no-op', reason: 'issueNumber not provided in args' }
}

const ISSUE_SCHEMA = {
  type: 'object',
  properties: {
    number: { type: 'number' },
    title: { type: 'string' },
    body: { type: 'string' },
    url: { type: 'string' },
  },
  required: ['number', 'title', 'body', 'url'],
}
const issue = await agent(
  `Fetch GitHub issue #${issueArgs.issueNumber} in this repo's working directory: \`gh issue view ${issueArgs.issueNumber} --json number,title,body,url\`. Return its number, title, body, and url exactly as given.`,
  { phase: 'Setup', schema: ISSUE_SCHEMA }
)

if (!issue) {
  log(`Fetching issue #${issueArgs.issueNumber} failed (agent-level failure, e.g. a session/usage limit or transient API error, or the issue number doesn't exist). Stopping here so this isn't silently misreported. Re-invoke this workflow with the same issueNumber to retry.`)
  return { status: 'fetch-failed', reason: `could not fetch issue #${issueArgs.issueNumber}` }
}

log(`Processing issue #${issue.number}: ${issue.title}`)

// Claim + branch-link happen FIRST, before any planning work -- this is the very first
// thing done once the issue is resolved. Uses `gh issue develop` (not plain `git checkout -b`)
// so the branch shows up as a linked branch in the issue's own GitHub "Development" sidebar,
// not just associated by naming convention.
await agent(
  `Claim and set up GitHub issue #${issue.number} ("${issue.title}") for work, in this repo's working directory. Do this BEFORE any planning or implementation work -- this step is claiming and branch setup only:\n1. Assign the issue to yourself: \`gh issue edit ${issue.number} --add-assignee @me\`.\n2. \`git fetch origin main\`.\n3. Check for an existing linked branch first: \`gh issue develop ${issue.number} --list\`. If one already exists (e.g. from a prior interrupted run on this same issue), check it out as-is to resume it -- don't create a duplicate: \`git checkout <existing-branch-name>\`.\n4. Otherwise create a new branch that is both created AND linked to this issue in GitHub's UI (not just named to imply a link), based off \`origin/main\`, and check it out in one step: \`gh issue develop ${issue.number} --name issue-${issue.number}-<kebab-case-slug-of-title> --base origin/main --checkout\`. Do NOT use plain \`git checkout -b\` for this -- it would create a branch but not link it to the issue.\n5. Ensure a \`.pipeline/\` directory exists (create if needed).`,
  { label: `setup:${issue.number}`, phase: 'Setup' }
)

const plan = await agent(
  `You are the planner stage of a 4-stage feature pipeline (planner -> coder -> tester -> reviewer). Working directory is the repo root, on the branch just created/checked-out for issue #${issue.number}. Turn this GitHub issue into an implementation spec written to .pipeline/spec.md (overwrite anything already there, including any stale spec from a different issue):\n\nIssue #${issue.number}: ${issue.title}\nURL: ${issue.url}\n\n${issue.body}\n\nInspect the actual current repo state yourself rather than assuming -- much of this repo may already satisfy parts of the issue. Write a concrete, actionable spec scoped only to this issue. If there's a genuine blocking ambiguity that requires a human decision, say so clearly.`,
  {
    agentType: 'planner',
    label: `plan:${issue.number}`,
    phase: 'Plan',
    schema: {
      type: 'object',
      properties: {
        hasOpenQuestion: { type: 'boolean' },
        summary: { type: 'string' },
      },
      required: ['hasOpenQuestion', 'summary'],
    },
  }
)

if (!plan) {
  log(`Planner for issue #${issue.number} did not complete (agent-level failure, e.g. a session/usage limit -- NOT a real open question). Stopping here so this isn't silently mislabeled. Re-invoke this workflow with the same issueNumber to retry once whatever caused the failure has cleared.`)
  await abandonStaleBranchIfEmpty(issue.number, 'planner did not complete')
  return { status: 'planner-failed', issue: { number: issue.number, title: issue.title, url: issue.url } }
}

if (plan.hasOpenQuestion) {
  log(`Issue #${issue.number} has a genuine open question -- stopping for human input instead of guessing.`)
  return { status: 'blocked-on-question', issue: { number: issue.number, title: issue.title, url: issue.url }, summary: plan.summary }
}

const coded = await agent(
  `You are the coder stage. Read .pipeline/spec.md in full and implement exactly what it specifies for issue #${issue.number} -- no scope creep. Verify your changes with Bun (bun run lint, bun run typecheck, bun run test, or whatever the spec calls for) before finishing. Commit your changes on the current branch with a clear message referencing issue #${issue.number} (do not push). Write a summary of what changed and where to .pipeline/changes.md.`,
  { agentType: 'coder', label: `code:${issue.number}`, phase: 'Code', schema: { type: 'object', properties: { done: { type: 'boolean' } }, required: ['done'] } }
)

if (!coded) {
  log(`Coder for issue #${issue.number} did not complete (agent-level failure, e.g. a session/usage limit or transient API error). Stopping here rather than letting the pipeline silently proceed against a half-finished change. Re-invoke this workflow with the same issueNumber to retry.`)
  await abandonStaleBranchIfEmpty(issue.number, 'coder did not complete')
  return { status: 'coder-failed', issue: { number: issue.number, title: issue.title, url: issue.url } }
}

const tested = await agent(
  `You are the tester stage. Read .pipeline/changes.md and .pipeline/spec.md. Independently verify the coder's claims rather than trusting them -- re-run whatever checks are relevant with Bun (bun run lint, bun run typecheck, bun run test, manual verification of the feature) and write pass/fail findings to .pipeline/test-results.md for the reviewer.`,
  { agentType: 'tester', label: `test:${issue.number}`, phase: 'Test', schema: { type: 'object', properties: { done: { type: 'boolean' } }, required: ['done'] } }
)

if (!tested) {
  log(`Tester for issue #${issue.number} did not complete (agent-level failure). Stopping here rather than letting the pipeline silently proceed to Review without real test results. Re-invoke this workflow with the same issueNumber to retry.`)
  await abandonStaleBranchIfEmpty(issue.number, 'tester did not complete')
  return { status: 'tester-failed', issue: { number: issue.number, title: issue.title, url: issue.url } }
}

const review = await agent(
  `You are the reviewer stage (final stage) for issue #${issue.number}. Read .pipeline/spec.md, .pipeline/changes.md, .pipeline/test-results.md, and run \`git diff main...HEAD\` yourself to see the actual changes firsthand -- don't just trust the written summaries. Be genuinely critical. Write your verdict to .pipeline/review.md.`,
  {
    agentType: 'reviewer',
    label: `review:${issue.number}`,
    phase: 'Review',
    schema: {
      type: 'object',
      properties: {
        verdict: { type: 'string', enum: ['SHIP', 'NEEDS WORK', 'BLOCK'] },
        summary: { type: 'string' },
      },
      required: ['verdict', 'summary'],
    },
  }
)

const ship = await agent(
  `Open the PR for issue #${issue.number} yourself (not via a subagent). Confirm the working tree is clean on the current branch (commit anything outstanding), then \`git push -u origin <current-branch-name>\`. Open the PR with \`gh pr create --base main --head <branch> --title "..." --body "..."\` directly -- do NOT use the mcp__github create_pull_request tool, since that would attribute the PR to the Claude GitHub App instead of the repo owner's own gh auth. Do NOT request any reviewer on the PR -- GitHub rejects requesting the PR author as their own reviewer, and gh pr create authenticates as the repo owner who is also the author here, so skip --reviewer entirely. Title: "Fix #${issue.number}: ${issue.title}". Body must include "Closes #${issue.number}" on its own line, the reviewer's verdict (${review ? review.verdict : 'UNKNOWN'}) and summary (${review ? review.summary.replace(/"/g, '\\"') : ''}), whether the pipeline fully completed, and any problems hit. Never merge the PR, never push to main, never close the issue. Leave the current branch checked out after opening the PR -- do NOT check out \`main\` (this working directory may be an isolated worktree where \`main\` is already checked out elsewhere, and checking it out here would fail). Return the PR URL.`,
  {
    label: `ship:${issue.number}`,
    phase: 'Ship',
    schema: {
      type: 'object',
      properties: { prUrl: { type: 'string' } },
      required: ['prUrl'],
    },
  }
)

log(`Issue #${issue.number} shipped: ${ship ? ship.prUrl : 'PR step failed'} (verdict: ${review ? review.verdict : 'unknown'})`)

return {
  status: 'shipped',
  issue: { number: issue.number, title: issue.title, url: issue.url },
  prUrl: ship ? ship.prUrl : null,
  verdict: review ? review.verdict : null,
}
