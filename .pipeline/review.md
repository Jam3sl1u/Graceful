# Review — Issue #67: Pingram SMS dispatch + webhook verification

VERDICT: NEEDS WORK

Independently verified from `pwd` = `/Users/jamesliu/Documents/Graceful/.claude/worktrees/issue-67`.
Read `spec.md`, `changes.md`, `test-results.md`, the full `git diff main...HEAD`,
every changed/added source and test file, and re-ran `bun run lint` (clean),
`bun run typecheck` (clean), `bun run test` (87 suites / 1130 tests, all pass).

## What is genuinely good

- The implementation follows the spec closely and literally: `sendSms`'s
  order of operations, `toE164` rules, the webhook route's gate ordering,
  the length-check-before-`timingSafeEqual`, throw-on-missing-secret vs.
  return-false-on-bad-input, and the seven PRD §30 template strings (checked
  verbatim against `documentation/prd/graceful_requirements_v10.md` lines
  1698-1707).
- The tests are meaningful, not superficial. `tests/unit/lib/api/webhook-verify.test.ts`
  builds real HMACs and covers same-length-wrong-bytes, different-length
  (no-throw), replay window in both directions, and body-mutated-after-signing.
  `tests/unit/lib/pingram/client.test.ts` asserts `fetch` was *not* called on
  every skip/validation/config path. The route test proves the 401 gate
  precedes `JSON.parse` by feeding malformed JSON with a rejected signature.
  The tester's `cron-...-issue67-supplement.test.ts` closes a real gap (a
  resolved `"skipped"` inside the try block).
- Scope discipline held: the other three webhook verifier stubs are untouched,
  no dependency added, no migration added, `lib/scheduling/reminder.ts` untouched.

## Required before merge

### 1. The blocking OPEN QUESTION is not recorded as resolved (highest priority)

`.pipeline/spec.md` at HEAD still carries, at the very top:

> ## OPEN QUESTION (BLOCKING — do not implement until a human answers)

`changes.md` asserts "A human resolved it: use the provisional defaults", but
that resolution was never written back into `spec.md`, so the durable pipeline
artifact still says do-not-implement while the commit implements it. Per
AGENTS.md, `spec.md` is the handoff artifact of record for exactly this.

This matters materially, not just procedurally. Everything in
`lib/pingram/client.ts` / `lib/api/webhook-verify.ts` §7 is invented:
`https://api.pingram.io/v1/messages`, `Authorization: Bearer`, `{to, text, from}`,
`x-pingram-signature`, `x-pingram-timestamp`, `${timestamp}.${rawBody}`,
lowercase hex. If any of those is wrong (and the planner correctly noted the
repo and the PRD contain zero evidence for any of them), then in production
**every real Pingram callback is rejected with 401** — the precise inversion of
the PRD §15.7 acceptance criterion this issue exists to satisfy — and every
send fails against a hostname that may not exist. Green tests prove only that
the code matches its own guess.

Action:
- Human must explicitly confirm "land the provisional defaults as scaffolding",
  and that confirmation must be recorded in `.pipeline/spec.md` (replace the
  BLOCKING banner with a RESOLVED note).
- The PR description must state that the Pingram wire contract is unverified
  and that a follow-up issue exists to confirm it against Pingram's real docs
  before this path is enabled in staging/production.
- **If the human did not in fact approve the provisional defaults, this is a
  BLOCK, not NEEDS WORK** — the pipeline would have proceeded past a stop sign.

### 2. `lib/notifications/sms-templates.ts` — the 160-char clamp silently destroys the link

`clamp()` hard-truncates at 160 chars. The spec's rationale ("links are always
last so a pathological clamp degrades the link, not the meaning") is backwards:
for an action SMS the link *is* the meaning. Reproduced against the committed
code:

- `setInvitationSms({date: "Sunday, Aug 1, 2026", roleNote: "Acoustic guitar + backing vocals", link: <84-char respond URL>})`
  → `"... Respond here: https://graceful.vercel.app/invitations/r"` — link cut
  mid-path, member cannot respond.
- `invitationDeniedSms` with max-length inputs (the exact scenario the existing
  test asserts) → ends `"... View rost"` with **no link at all**.

The per-field budgets (memberName 40, reason 60, roleNote 40, each +3 for `...`)
were chosen without reserving room for the link, and the tests only assert
`length <= 160` — which is why this passes green while producing an unusable
message. A 28-char `LINK` fixture hides it; real respond URLs will be 60-90 chars.

Fix in `/Users/jamesliu/Documents/Graceful/.claude/worktrees/issue-67/lib/notifications/sms-templates.ts`:
compute the free-text budget as `SMS_MAX_LENGTH - (fixed copy + link.length)`
and truncate the free-text fields against that, so the link is never cut; or
throw/`console.warn` when the clamp would fire. Then add assertions in
`/Users/jamesliu/Documents/Graceful/.claude/worktrees/issue-67/tests/unit/lib/notifications/sms-templates.test.ts`
that `result.endsWith(link)` (or `result.includes(link)`) for every
link-bearing builder under max-length inputs and a realistic 84-char link.

### 3. The one live caller can now hard-fail on long names/titles

`sendSms` now throws `SmsValidationError` for `body.length > 160`, but the only
production caller feeds it untruncated free text:
`buildMemberReminderSms(memberName, weekLabel)` in `lib/scheduling/reminder.ts`
has a 75-char fixed body, and `users.name` is `varchar(100)` while
`service_weeks.title` is `varchar(100)` — maximum 275 chars, and a plausible
real row ("Jonathan Smith-Anderson" + "Sunday Morning Worship + Youth Combined
Service (Guest Speaker: Pastor Michael)") already yields **177 chars**. That
member is silently never reminded; it just increments `smsFailed` and logs.

This is masked today only because `sendSms` used to throw unconditionally, so
it is a latent regression that activates the moment item 1 is corrected. No test
covers it. Fix at the call site in
`/Users/jamesliu/Documents/Graceful/.claude/worktrees/issue-67/app/api/cron/invitation-reminders/route.ts`
(truncate `member_name` / `weekLabel` before building) or in
`lib/scheduling/reminder.ts`, and add a cron-route test with a >160-char
rendered body asserting the reminder still sends.

### 4. Testing-stage artifacts are uncommitted

`git status` shows `tests/unit/schemas/pingram.test.ts` and
`tests/unit/app/api/cron-invitation-reminders-route-issue67-supplement.test.ts`
as untracked and `.pipeline/test-results.md` as modified-but-unstaged. Only the
Coder's commit `c250686` is on the branch. These must be committed or the PR
ships without the Testing stage's work.

## Non-blocking observations

- `.env.example`: `PINGRAM_API_BASE_URL=   # optional override` relies on the
  loader stripping inline comments. `@next/env` does, and `NEXT_PUBLIC_APP_URL`
  sets a precedent, so this is fine — but if a stricter parser is ever used the
  value becomes the comment text and every send goes to a garbage URL. Moving
  the comment to its own line is safer.
- Signature comparison is case-sensitive on hex; an uppercase-hex provider would
  always fail. Fold to lowercase when the real contract is confirmed.
- Several PRD §30 strings contain an em dash (`—`), which forces UCS-2 encoding
  and a **70**-char single-segment limit, not 160. The stated rationale for the
  160 cap ("never silently send a multi-segment message" on a 100 SMS/month free
  tier) therefore does not hold for `memberReminderSms`,
  `schedulingConflictSms`, and `practiceReminderSms`. Worth a follow-up: either
  use `-` or budget those templates at 70.
- `truncateField` returns up to `max + 3` chars (the `...` is appended, not
  substituted), so the documented "40 char" limits are effectively 43. Harmless
  but worth noting alongside the item-2 budget rework.
- The webhook route reads the entire body via `req.text()` before verification.
  Unavoidable for raw-body signing and Vercel caps request size, so this is
  acceptable — noted only so it is a conscious choice.
- `toE164` accepts `+` followed by 8-15 digits (any country) despite the
  "US-only" comment. Matches the spec; the comment is slightly misleading.

## Summary

The engineering is careful and the tests are real — this is not a rubber-stamp
NEEDS WORK. It does not ship as-is because (1) the pipeline's own stop sign is
still standing in `spec.md` while the commit implements a guessed vendor
contract, and (2) two concrete, test-invisible correctness defects exist in the
message-length handling: the clamp eats the respond link, and the live cron
caller can exceed the new hard 160-char limit and drop reminders.
