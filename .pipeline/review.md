# Review — Issue #50: Build Conflict Resolution screen (PRD §13 Screen 7)

## VERDICT: SHIP

## What I checked (not just trusting the summaries)
- Read spec.md, changes.md, test-results.md.
- Isolated the actual #50 commit (`aacfbb6`) — the `main...HEAD` three-dot diff
  also shows #51 / cron-scheduler work that is not this issue; the #50 commit
  itself touches exactly the 8 files the spec scopes (handler + route test +
  4 new screen/test files + 2 pipeline artifacts). No scope creep.
- Read every changed/created source file firsthand, plus both untracked
  tester-supplement test files.
- Re-ran `bun run typecheck` (clean), `bun run lint` (clean), `bun run test`
  (43 suites / 495 tests, 0 failures).

## Correctness assessment
- **Handler change** matches the spec exactly: `roleNote` added to `OpenConflict`,
  `role_note` added to both the `Pick<>` type and the `.select()`, surfaced as
  `roleNote: invitation?.role_note ?? null`. `resolveConflict` untouched.
- **Button → action mapping** is correct: "Mark as Resolved" POSTs
  `member_reconfirmed`, "Dismiss" POSTs `admin_dismissed`, "Find a Replacement"
  is a pure `<a>` navigation (no API call, conflict stays open) with a
  forward-compatible `/invitations/new` URL and `encodeURIComponent(roleNote ?? "")`.
- **View-state machine** and all named edge cases are handled: not-found / non-OK
  / network error on load → `unavailable`; 409 on resolve → `unavailable`;
  other non-OK / thrown error → inline fixed-string `role="alert"`, buttons stay
  usable; double-submit guarded by `submitting`; null `serviceWeekTitle` →
  "Service", null `roleNote` / `triggerReason` lines omitted cleanly.
- **No sensitive-data leak**: `actionError` is always a fixed string; no
  `error`/`code`/`status` is ever interpolated into rendered text.
- **Out-of-scope boundaries held**: list stub, resolve endpoint/schema, and all
  migrations are untouched.

## Test quality
- The coder's component test and route test are behavioral (assert rendered DOM,
  fetch URL+body, response envelope) — not superficial.
- The two tester-supplement files close real gaps behaviorally: click-produces-no-
  fetch for "Find a Replacement", `!res.ok` load branch, null-roleNote href
  encoding, `guest` role gate, and `role_note`-column-null vs invitation-row-
  missing distinction. Both are legitimate assertion-on-behavior tests with no
  suspicious content. They are untracked in the worktree — they must be committed
  (or intentionally dropped) before/with the PR so the coverage they claim is not
  silently lost.

## Non-blocking notes (no action required to ship)
- "Find a Replacement" anchor is not disabled during an in-flight resolve, though
  the mapping-table narrative says all three are enabled "except while a request
  is in flight." This is consistent with the spec's own detailed section 4 (only
  the two `Button`s get the disabled treatment; the link is a plain anchor that
  navigates away), so it is intentional, not a defect.
- The jest run emits a jsdom "navigation not implemented" console warning from the
  click-the-anchor test; it is cosmetic (jsdom can't perform anchor navigation)
  and does not affect any assertion or the pass result.

Green tests here reflect genuinely correct behavior. Ship it.
