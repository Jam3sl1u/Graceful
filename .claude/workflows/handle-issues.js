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

// Only the very first agent() call in this script reliably inherits the cwd of the
// EnterWorktree-created worktree the caller launched this from -- every later agent()
// call re-resolves against the caller's *live* current directory at the moment it fires,
// which has been observed to drift back to the main repo root mid-run (verified via a
// real run against issues #41/#42: the Planner and Reviewer stages silently wrote
// .pipeline/spec.md and .pipeline/review.md into the main repo instead of the pinned
// worktree, while Setup/Coder/Tester happened to land in the right place -- an
// inconsistent, silent failure, not a theoretical one). Passing `worktreePath` in args
// and prefixing every prompt with an explicit cd-and-verify instruction removes the
// dependency on inherited cwd entirely, regardless of root cause.
const worktreePath = issueArgs.worktreePath || null
function pin(prompt) {
  return worktreePath
    ? `Your working directory must be exactly \`${worktreePath}\`. Run \`pwd\` first; if it does not print exactly that path, \`cd ${worktreePath}\` before doing anything else in this task. Never read from or write to any other checkout of this repo (e.g. the main repo root) even if it seems to work. ${prompt}`
    : prompt
}

async function abandonStaleBranchIfEmpty(issueNumber, reasonLabel) {
  const result = await agent(
    pin(`A previous stage for issue #${issueNumber} did not complete normally (${reasonLabel} -- likely a token/usage limit or transient failure, not a real blocker). Per AGENTS.md's git policy (detached checkout, never touch origin): find the local branch matching \`issue-${issueNumber}-*\` (at most one; if none, report and stop). Check \`git rev-list --count origin/main..<branch>\`. If 0, \`git checkout --detach origin/main\` then \`git branch -D <branch>\` so the next run starts fresh. If >0, leave it and just report the branch/count for a human. Never touch origin. Report what you found and whether you deleted the branch.`),
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
  pin(`Fetch GitHub issue #${issueArgs.issueNumber} in this repo's working directory: \`gh issue view ${issueArgs.issueNumber} --json number,title,body,url\`. Return its number, title, body, and url exactly as given.`),
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
  pin(`Claim and set up GitHub issue #${issue.number} ("${issue.title}") per AGENTS.md's git policy, before any planning/implementation:\n1. \`gh issue edit ${issue.number} --add-assignee @me\`.\n2. \`git fetch origin main\`.\n3. \`gh issue develop ${issue.number} --list\` -- if a linked branch already exists, \`git checkout <it>\` to resume. NOTE: this command has been observed to stop listing a branch once that branch has an open PR against it, even though the branch is still very much the right one to resume -- so ALSO run \`git branch -a --list '*issue-${issue.number}-*'\` and \`gh pr list --search "issue #${issue.number} in:body" --state open --json headRefName,url\` as a fallback. If either check turns up an existing non-scratch branch (i.e. not \`worktree-issue-${issue.number}\`) for this issue -- whether or not \`gh issue develop --list\` mentioned it -- check that one out and resume it instead of creating a new one, even if it already has an open PR. Only create a brand-new branch (step 4) if truly none exists anywhere (local or remote).\n4. Otherwise: \`gh issue develop ${issue.number} --name issue-${issue.number}-<kebab-case-slug-of-title> --base origin/main --checkout\` (not plain \`git checkout -b\`, which wouldn't link it).\n5. Ensure \`.pipeline/\` exists (create if needed).`),
  { label: `setup:${issue.number}`, phase: 'Setup' }
)

const plan = await agent(
  pin(`You are the planner stage of a 4-stage feature pipeline (planner -> coder -> tester -> reviewer). Working directory is the repo root, on the branch just created/checked-out for issue #${issue.number}. Turn this GitHub issue into an implementation spec written to .pipeline/spec.md (overwrite anything already there, including any stale spec from a different issue):\n\nIssue #${issue.number}: ${issue.title}\nURL: ${issue.url}\n\n${issue.body}\n\nInspect the actual current repo state yourself rather than assuming -- much of this repo may already satisfy parts of the issue. Write a concrete, actionable spec scoped only to this issue. If there's a genuine blocking ambiguity that requires a human decision, say so clearly.`),
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

if (plan.hasOpenQuestion && !issueArgs.humanAnswer) {
  log(`Issue #${issue.number} has a genuine open question -- stopping for human input instead of guessing.`)
  return { status: 'blocked-on-question', issue: { number: issue.number, title: issue.title, url: issue.url }, summary: plan.summary }
}

if (plan.hasOpenQuestion && issueArgs.humanAnswer) {
  log(`Issue #${issue.number}: resuming past the open question with a human-provided answer.`)
}

const coded = await agent(
  pin(`You are the coder stage. Read .pipeline/spec.md in full and implement exactly what it specifies for issue #${issue.number} -- no scope creep.${issueArgs.humanAnswer ? ` A human has resolved the open question(s) the planner flagged -- apply this resolution, overriding anything in spec.md that conflicts with it: "${issueArgs.humanAnswer.replace(/"/g, '\\"')}"` : ''} Verify your changes with Bun (bun run lint, bun run typecheck, bun run test, or whatever the spec calls for) before finishing. Commit your changes on the current branch with a clear message referencing issue #${issue.number} (do not push). Write a summary of what changed and where to .pipeline/changes.md. Set done:true only if you actually implemented and committed real code for this issue; if spec.md turns out to already be fully satisfied by the current branch (verify this with \`git diff origin/main...HEAD\` and by reading the actual files -- not by assuming), set done:false and explain why in your own reasoning rather than committing nothing and claiming success.`),
  { agentType: 'coder', label: `code:${issue.number}`, phase: 'Code', schema: { type: 'object', properties: { done: { type: 'boolean' } }, required: ['done'] } }
)

if (!coded || !coded.done) {
  log(`Coder for issue #${issue.number} did not produce a real implementation (${!coded ? 'agent-level failure' : 'reported done:false'}). Stopping here rather than letting the pipeline silently proceed to Test/Review/Ship against missing code. Re-invoke this workflow with the same issueNumber to retry.`)
  await abandonStaleBranchIfEmpty(issue.number, coded ? 'coder reported done:false' : 'coder did not complete')
  return { status: 'coder-failed', issue: { number: issue.number, title: issue.title, url: issue.url } }
}

const tested = await agent(
  pin(`You are the tester stage. Read .pipeline/changes.md and .pipeline/spec.md. Independently verify the coder's claims rather than trusting them -- re-run whatever checks are relevant with Bun (bun run lint, bun run typecheck, bun run test, manual verification of the feature) and write pass/fail findings to .pipeline/test-results.md for the reviewer.`),
  { agentType: 'tester', label: `test:${issue.number}`, phase: 'Test', schema: { type: 'object', properties: { done: { type: 'boolean' } }, required: ['done'] } }
)

if (!tested) {
  log(`Tester for issue #${issue.number} did not complete (agent-level failure). Stopping here rather than letting the pipeline silently proceed to Review without real test results. Re-invoke this workflow with the same issueNumber to retry.`)
  await abandonStaleBranchIfEmpty(issue.number, 'tester did not complete')
  return { status: 'tester-failed', issue: { number: issue.number, title: issue.title, url: issue.url } }
}

const review = await agent(
  pin(`You are the reviewer stage (final stage) for issue #${issue.number}. Read .pipeline/spec.md, .pipeline/changes.md, .pipeline/test-results.md, and run \`git diff main...HEAD\` yourself to see the actual changes firsthand -- don't just trust the written summaries. Be genuinely critical. Write your verdict to .pipeline/review.md.`),
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

if (!review) {
  log(`Reviewer for issue #${issue.number} did not complete (agent-level failure, e.g. a session/usage limit). Stopping here rather than shipping without a real review. Re-invoke this workflow with the same issueNumber to retry.`)
  await abandonStaleBranchIfEmpty(issue.number, 'reviewer did not complete')
  return { status: 'reviewer-failed', issue: { number: issue.number, title: issue.title, url: issue.url } }
}

const ship = await agent(
  pin(`Open the PR for issue #${issue.number} yourself, per AGENTS.md's git/PR policy. Confirm the working tree is clean on the current branch (commit anything outstanding), \`git push -u origin <current-branch-name>\`, then \`gh pr create --base main --head <branch> --title "Fix #${issue.number}: ${issue.title}" --body "..."\` directly (not the mcp__github tool, and no --reviewer). Body must include "Closes #${issue.number}" on its own line, the reviewer's verdict (${review.verdict}) and summary (${review.summary.replace(/"/g, '\\"')}), whether the pipeline fully completed, and any problems hit. Never merge/push-main/close the issue. Leave the current branch checked out (do not check out main). Return the PR URL.`),
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

log(`Issue #${issue.number} shipped: ${ship ? ship.prUrl : 'PR step failed'} (verdict: ${review.verdict})`)

return {
  status: 'shipped',
  issue: { number: issue.number, title: issue.title, url: issue.url },
  prUrl: ship ? ship.prUrl : null,
  verdict: review.verdict,
  humanAnswerApplied: issueArgs.humanAnswer || null,
}
