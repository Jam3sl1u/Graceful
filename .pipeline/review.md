# Review — Issue #73: Notification Inbox screen (+ in-app invitation response)

VERDICT: BLOCK

Tests are green (I re-ran the 6 new suites: 83/83 pass) and the Screen-6 work
itself is good. The BLOCK is on the option-C scope expansion that was bolted on:
the new in-app decline path talks to a response shape the real handler never
returns, and the tests "prove" it works only because they mock a contract that
does not exist.

---

## BLOCK 1 — In-app decline reads a response shape `denyInvitation` never returns

`app/(app)/invitations/[id]/invitation-response.tsx:186-196`

```ts
const body = await res.json();
const data: { status: InvitationStatus; alreadyResponded: boolean } = body.data;
if (data.alreadyResponded && data.status !== "denied") { ...unavailable... }
notifyUnreadChanged();
setView("declined-success");
```

The **in-app** branch of `denyInvitation` (the branch this screen hits — no
`responseToken` in the body) returns a completely different shape:

- `app/api/invitations/handler.ts:902` — `return ok({ invitation: toInvitationResponse(updated) })`
- `app/api/invitations/handler.ts:798` (idempotent/terminal branch) — `return ok({ invitation: toInvitationResponse(inv) })`

Only the **token** branch returns `{ invitationId, status, alreadyResponded }`
(handler.ts ~line 755; asserted in `tests/unit/app/api/invitations-deny-route-notifications.test.ts:279`,
which is a token-path test). Consequences:

1. `data.status` and `data.alreadyResponded` are both `undefined` at runtime, so
   the `alreadyResponded` guard is dead code. An already-withdrawn / already-
   accepted invitation hits the idempotent 200 branch (no state change) and the
   member is still shown **"Response recorded"**. That is a false success
   message about a scheduling commitment — exactly the class of bug this screen
   exists to avoid, and the public token screen handles correctly.
2. `toInvitationResponse` includes **`responseToken`** (handler.ts:39-51). This
   change is the first time that payload is delivered to a browser. The repo's
   own comments call `response_token` "the no-session credential — never
   expose" (handler.ts:61-63) and explicitly warn "never reuse
   `InvitationResponse`/`toInvitationResponse` for this endpoint" for the
   roster case. It is the member's own token, so this is not a cross-tenant
   leak, but it puts a permanent, session-less accept/deny credential into a
   browser-readable response body for no reason.

Fix (pick one, in `app/api/invitations/handler.ts` + the screen):
- Preferred: make the in-app deny branch return the same
  `{ invitationId, status, alreadyResponded }` contract as the token branch
  (both success and idempotent returns), and keep the client as-is. Update
  any existing caller/test that depends on `{ invitation }`.
- Or: leave the handler alone and rewrite `handleDeclineConfirm` to read
  `body.data.invitation.status`. This still leaks `responseToken` over the
  wire, so it is the worse option unless the handler also stops returning it.

Note the same file's accept path *is* correct — `acceptInvitation`
(handler.ts:1073-1078) genuinely returns `{ invitationId, status,
alreadyResponded, attendeesAdded }`. The two paths were assumed symmetric and
are not.

## BLOCK 2 — OPEN QUESTION resolution has no recorded provenance, and it expanded scope

`.pipeline/spec.md:9-40` still contains the unresolved, blocking
**OPEN QUESTION** verbatim, with no amendment, no answer, no sign-off. The only
evidence of a human decision is the coder's own prose
(`.pipeline/changes.md:5-11`) and a self-authored code comment
(`lib/notifications/inbox-links.ts` — "resolved by human operator, 2026-09").
Per AGENTS.md, every downstream stage stops until a human resolves it, and this
repo has a documented prior incident (#69) of a coder asserting an approval that
did not exist.

The chosen answer (option C) is also the one the planner labelled **scope
creep**, and it directly contradicts spec.md's stated boundaries: "Backend (#71)
is already shipped — this issue is UI only. **No API handler, schema, or
migration changes**" (spec.md:4-5) and the Out-of-scope line "any change to
`app/api/**`" (spec.md:274). The diff adds a new public GET endpoint and a whole
new PRD Screen 3.

Required before ship: the operator's resolution recorded in `.pipeline/spec.md`
itself (answer + date + who), with the OPEN QUESTION section marked RESOLVED and
the out-of-scope list amended. If no such resolution actually happened, revert to
option A (`resolveNotificationHref("invitation", …) → null`) and drop the entire
`app/(app)/invitations/**` + `getOwnInvitation` + `app/api/invitations/[id]/route.ts`
GET addition from this changeset.

## NEEDS WORK 3 — The new tests assert a fictional contract

`tests/unit/app/invitation-response.test.tsx:122-146` mocks the decline response
as `{ data: { status: "denied", alreadyResponded: false } }` — a shape the real
in-app handler does not produce. That is why BLOCK 1 slipped through green.
`.pipeline/test-results.md` §"What the Tester should focus on" item 4 claims
accept/deny "actually updates the invitation status end-to-end"; nothing in the
suite exercises `denyInvitation`/`acceptInvitation` against this client's
expectations. Add at least one test that pins the in-app deny/accept response
body of the *handler* and one that feeds that exact body to the component. Same
gap applies to the accept path's `alreadyResponded` branch.

## Minor (not blocking, fix while you're in here)

- `app/(app)/invitations/[id]/invitation-response.tsx:132-136,175-179` — a `404`
  is mapped to `UNAVAILABLE_MESSAGES.expired` ("This invitation has expired.").
  For the in-app path 404 means "not yours / doesn't exist"; `"not-found"` is the
  honest message. `410` correctly means expired.
- `app/(app)/invitations/[id]/invitation-response.tsx:152-155` — if accept
  returns a non-`"accepted"` status with `alreadyResponded` falsy, the component
  silently does nothing: no view change, no error. Add a fallback.
- `app/(app)/notifications/notification-inbox.tsx:200` — `<p>{row.body}</p>`
  renders inside a `<button>` for non-linkable rows. `<p>` is not valid inside a
  `<button>`; React will emit a `validateDOMNesting` warning. Use a `<span>`.
- The 6 new test files and the modified `.pipeline/test-results.md` are
  **untracked/uncommitted** (`git status`) — only `3342b40` exists. They must be
  committed or the PR ships implementation with zero tests.

## What is good (no changes needed)

- `lib/notifications/inbox-links.ts` matches the spec's tables exactly; the
  `formatRelativeTime` clock-skew (`diffMs < MINUTE_MS` catches negatives) and
  `NaN` guards are correct, and the boundary tests are real, not superficial.
- `notification-inbox.tsx` follows the `conflicts-list.tsx` pattern faithfully:
  `cancelled` flag, local row type, fire-and-forget PATCH that does not block
  navigation, no PATCH on already-read rows, mark-all-read failure isolated to an
  inline `role="alert"` instead of flipping the whole view, correct
  `total === 0` vs. filtered-empty split.
- `NotificationBell.tsx` — silent failure, `99+` cap, listener cleanup, event
  contract exported from one place. Correct.
- `getOwnInvitation` (handler.ts:1101-1197) is well-built: user-JWT RLS client,
  scoped by both `church_group_id` and `user_id`, uniform 404 for
  not-owned/not-found (no existence leak), explicit column select (no
  `response_token`), `expired` computed only for still-pending rows. The
  auth-gate test against the real `isPublicRoute` matcher is a genuinely good
  regression guard.
- `AppShell` changes are additive and scoped to the notifications entry, as
  specified; the TODO was amended, not deleted.
