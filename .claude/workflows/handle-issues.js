export const meta = {
  name: 'handle-issues',
  description: 'Process exactly one GitHub issue (oldest unclaimed by default, or a specific issue number via args.issueNumber) through plan/code/test/review and open a PR for it.',
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

phase('Setup')

let issue
if (args && args.issueNumber) {
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
  issue = await agent(
    `Fetch GitHub issue #${args.issueNumber} in this repo's working directory: \`gh issue view ${args.issueNumber} --json number,title,body,url\`. Return its number, title, body, and url exactly as given.`,
    { phase: 'Setup', schema: ISSUE_SCHEMA }
  )
} else {
  const QUEUE_SCHEMA = {
    type: 'object',
    properties: {
      found: { type: 'boolean' },
      number: { type: 'number' },
      title: { type: 'string' },
      body: { type: 'string' },
      url: { type: 'string' },
    },
    required: ['found'],
  }
  const result = await agent(
    `List open GitHub issues in this repo oldest-first: \`gh issue list --state open --sort created --order asc --limit 20 --json number,title,body,url\`. Then list open PRs: \`gh pr list --state open --json body,headRefName\`. An issue is already claimed if any open PR's body contains "Closes #<number>" or its headRefName matches "issue-<number>-*" -- exclude those. If there is at least one unclaimed open issue, return found=true plus the SINGLE oldest unclaimed issue's number/title/body/url. If every open issue is claimed, or there are no open issues at all, return found=false.`,
    { phase: 'Setup', schema: QUEUE_SCHEMA }
  )
  issue = result && result.found ? result : null
}

if (!issue) {
  log('No unclaimed open issue to process.')
  return { status: 'no-op', reason: 'no unclaimed open issues found' }
}

log(`Processing issue #${issue.number}: ${issue.title}`)

await agent(
  `Claim and set up GitHub issue #${issue.number} ("${issue.title}") for work, in this repo's working directory:\n1. Assign it to yourself: \`gh issue edit ${issue.number} --add-assignee @me\`.\n2. \`git checkout main && git pull origin main && git checkout -b issue-${issue.number}-<kebab-case-slug-of-title>\`. If a branch with that exact name already exists (e.g. from a prior interrupted run on this same issue), just check it out instead of failing -- don't create a duplicate.\n3. Ensure a \`.pipeline/\` directory exists (create if needed).\nDo not do any implementation work -- this is claiming and branch setup only.`,
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
  return { status: 'planner-failed', issue: { number: issue.number, title: issue.title, url: issue.url } }
}

if (plan.hasOpenQuestion) {
  log(`Issue #${issue.number} has a genuine open question -- stopping for human input instead of guessing.`)
  return { status: 'blocked-on-question', issue: { number: issue.number, title: issue.title, url: issue.url }, summary: plan.summary }
}

await agent(
  `You are the coder stage. Read .pipeline/spec.md in full and implement exactly what it specifies for issue #${issue.number} -- no scope creep. Verify your changes (lint/typecheck/tests/whatever the spec calls for) before finishing. Commit your changes on the current branch with a clear message referencing issue #${issue.number} (do not push). Write a summary of what changed and where to .pipeline/changes.md.`,
  { agentType: 'coder', label: `code:${issue.number}`, phase: 'Code' }
)

await agent(
  `You are the tester stage. Read .pipeline/changes.md and .pipeline/spec.md. Independently verify the coder's claims rather than trusting them -- re-run whatever checks are relevant (lint, typecheck, existing test suite, manual verification of the feature) and write pass/fail findings to .pipeline/test-results.md for the reviewer.`,
  { agentType: 'tester', label: `test:${issue.number}`, phase: 'Test' }
)

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
  `Open the PR for issue #${issue.number} yourself (not via a subagent). Confirm the working tree is clean on the current branch (commit anything outstanding), then \`git push -u origin <current-branch-name>\`. Open the PR with \`gh pr create --base main --head <branch> --title "..." --body "..."\` directly -- do NOT use the mcp__github create_pull_request tool, since that would attribute the PR to the Claude GitHub App instead of the repo owner's own gh auth. Do NOT request any reviewer on the PR -- GitHub rejects requesting the PR author as their own reviewer, and gh pr create authenticates as the repo owner who is also the author here, so skip --reviewer entirely. Title: "Fix #${issue.number}: ${issue.title}". Body must include "Closes #${issue.number}" on its own line, the reviewer's verdict (${review ? review.verdict : 'UNKNOWN'}) and summary (${review ? review.summary.replace(/"/g, '\\"') : ''}), whether the pipeline fully completed, and any problems hit. Never merge the PR, never push to main, never close the issue. After opening the PR, check out main again. Return the PR URL.`,
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
