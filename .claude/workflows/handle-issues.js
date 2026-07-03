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

let issue
if (issueArgs && issueArgs.issueNumber) {
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
    `Fetch GitHub issue #${issueArgs.issueNumber} in this repo's working directory: \`gh issue view ${issueArgs.issueNumber} --json number,title,body,url\`. Return its number, title, body, and url exactly as given.`,
    { phase: 'Setup', schema: ISSUE_SCHEMA }
  )
} else {
  // Deliberately excludes `body` here -- with a large open-issue backlog, fetching every
  // issue's full body just to pick the oldest unclaimed one caused the subagent to blow past
  // context limits (100k+ tokens) round-tripping the payload through scratch files. Only the
  // winning issue's body is ever needed downstream, so it's fetched separately below, once,
  // by number -- same cheap pattern as the args.issueNumber branch above.
  const ISSUES_SCHEMA = {
    type: 'object',
    properties: {
      issues: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            number: { type: 'number' },
            title: { type: 'string' },
            url: { type: 'string' },
            createdAt: { type: 'string' },
          },
          required: ['number', 'title', 'url', 'createdAt'],
        },
      },
    },
    required: ['issues'],
  }
  const issuesResult = await agent(
    `Fetch open GitHub issues in this repo's working directory and return them raw, unsorted, unfiltered: \`gh issue list --state open --limit 100 --json number,title,url,createdAt\`. Return the parsed JSON array as-is under "issues". Do not sort, filter, or interpret it -- note that \`gh issue list\` has no --sort/--order flags, so do not attempt to use them. Do NOT fetch issue bodies -- they are not needed here.`,
    { phase: 'Setup', schema: ISSUES_SCHEMA }
  )

  const PRS_SCHEMA = {
    type: 'object',
    properties: {
      prs: {
        type: 'array',
        items: {
          type: 'object',
          properties: { body: { type: 'string' }, headRefName: { type: 'string' } },
          required: ['body', 'headRefName'],
        },
      },
    },
    required: ['prs'],
  }
  const prsResult = await agent(
    `List open GitHub PRs in this repo's working directory and return them raw: \`gh pr list --state open --json body,headRefName\`. Return the parsed JSON array as-is under "prs". Do not interpret it.`,
    { phase: 'Setup', schema: PRS_SCHEMA }
  )

  if (!issuesResult || !prsResult) {
    log('Fetching open issues/PRs failed (agent-level failure, e.g. a session/usage limit or transient API error) -- NOT the same as an empty queue. Stopping here so this is not silently misreported as "no open issues." Re-invoke this workflow once whatever caused the failure has cleared.')
    return { status: 'fetch-failed', reason: !issuesResult ? 'issues fetch failed' : 'PR fetch failed' }
  }

  const openIssues = issuesResult.issues || []
  const openPrs = prsResult.prs || []

  const claimed = new Set()
  for (const pr of openPrs) {
    const closes = (pr.body || '').match(/Closes #(\d+)/i)
    if (closes) claimed.add(Number(closes[1]))
    const branch = (pr.headRefName || '').match(/^issue-(\d+)-/)
    if (branch) claimed.add(Number(branch[1]))
  }

  const unclaimed = openIssues
    .filter(i => !claimed.has(i.number))
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))

  const picked = unclaimed[0] || null

  if (picked) {
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
      `Fetch GitHub issue #${picked.number} in this repo's working directory: \`gh issue view ${picked.number} --json number,title,body,url\`. Return its number, title, body, and url exactly as given.`,
      { phase: 'Setup', schema: ISSUE_SCHEMA }
    )
  } else {
    issue = null
  }
}

if (!issue) {
  log('No unclaimed open issue to process.')
  return { status: 'no-op', reason: 'no unclaimed open issues found' }
}

log(`Processing issue #${issue.number}: ${issue.title}`)

await agent(
  `Claim and set up GitHub issue #${issue.number} ("${issue.title}") for work, in this repo's working directory:\n1. Assign it to yourself: \`gh issue edit ${issue.number} --add-assignee @me\`.\n2. \`git fetch origin main\`.\n3. If a local branch named exactly \`issue-${issue.number}-<kebab-case-slug-of-title>\` already exists (e.g. from a prior interrupted run on this same issue), just check it out as-is to resume it -- don't create a duplicate. Otherwise create it fresh without ever checking out local \`main\` (this working directory may be an isolated worktree where \`main\` is already checked out elsewhere, and checking it out here would fail): \`git checkout -b issue-${issue.number}-<kebab-case-slug-of-title> --no-track origin/main\`.\n4. Ensure a \`.pipeline/\` directory exists (create if needed).\nDo not do any implementation work -- this is claiming and branch setup only.`,
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
