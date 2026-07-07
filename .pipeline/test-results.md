# Test Results — Issue #26: Member directory endpoint (`GET /api/church-group/members`)

## Verdict: BLOCKED — feature logic passes, but a critical undisclosed finding requires human review before shipping

This is a fresh, independent re-verification run against the code currently checked out
at HEAD (`494dded`, merge of PR #108). It supersedes the version of this file (and of
`.pipeline/review.md`) already on disk, which were written against an **earlier state of
the branch** (before commit `25d4dd5`) and did not see what is described in §2 below.

## 1. Standard checks — all PASS

- `bun install` — succeeds, no lockfile drift.
- `bun run typecheck` (`tsc --noEmit`) — passes, no errors.
- `bun run lint` (`eslint .`) — passes, no errors/warnings.
- `bun run test` (`jest`) — **7 suites / 53 tests pass**, 0 failures.
  - Note: `.pipeline/changes.md` claims "6 suites / 38 tests"; the actual current repo
    state has 7 suites / 53 tests (`tests/unit/app/api/church-group-members-route.test.ts`
    alone has 13 test cases, not 8). This documentation drift is itself a symptom of
    `changes.md` having been written against an earlier commit than what's now on the
    branch — consistent with the finding in §2.

Feature-logic verification against the spec (`.pipeline/spec.md`), done by direct reading
of `app/api/church-group/members/handler.ts` (not just trusting `changes.md`):
- Order of operations matches spec: `requireAuth` -> `requireRole(["admin","set_leader","member"])`
  -> `getToken({template:"supabase"})` (401 if no JWT) -> 4 parallel group-scoped queries
  -> 500 `INTERNAL` on any `.error` -> in-JS assembly -> `ok({ members })`.
- `email`/`phone` genuinely omitted (not `null`) for non-admins — only assigned inside
  `if (ctx.role === "admin")`. Verified via the test's `"email" in member` assertions.
- No-profile user -> `vocalCapability: 'none'`, `instruments: []`, still listed. Verified.
- Dangling `member_instruments.instrument_id` (no matching `instruments` row) skipped via
  `if (!name) continue`. Verified.
- No sort/pagination/filter added, per spec. Verified.
- `lib/supabase/types.ts` additions match spec's field-by-field description exactly;
  `lib/api/auth.ts` untouched.
- Out-of-scope items (`[id]` stubs, UI, availability wiring, role assignment, member
  removal, new migrations) untouched — confirmed via `git status` / `git diff --stat`.
- All edge cases named in the spec (guest 403, unauthenticated 401, no-JWT 401, admin vs.
  non-admin contact fields, no-profile fallback, no-instruments fallback, dangling
  instrument skip, `availabilityStatus: null`, single-member group, 500 on query error)
  have passing test coverage in `tests/unit/app/api/church-group-members-route.test.ts`.

**On the feature requirements alone, this would be a clean PASS.**

## 2. Critical finding — undisclosed network call injected into shipped handler code

While independently reading the actual source, I found that
`app/api/church-group/members/handler.ts` — the file this issue's feature lives in —
contains this block, verbatim, at the top of `getChurchGroupMembers`'s `try`:

```ts
// #region agent log
if (process.env.NODE_ENV === "test") fetch('http://127.0.0.1:7538/ingest/73d41e57-f389-4de1-b0c9-c98dcb4b4f16',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'8ebabd'},body:JSON.stringify({sessionId:'8ebabd',runId:'pre-fix',hypothesisId:'H1',location:'app/api/church-group/members/handler.ts:entry',message:'getChurchGroupMembers entry',data:{hasLookup:!!lookup},timestamp:Date.now()})}).catch(()=>{});
// #endregion
```

An identical block (different `hypothesisId`/location) is also present in
`app/api/_examples/admin-only/handler.ts`. Neither block appears anywhere in
`.pipeline/changes.md`, `.pipeline/spec.md`, or the prior `.pipeline/review.md` — none of
which mention a `handler.ts` file existing at all. This code:

- Fires a real `fetch()` POST to an external ingest endpoint whenever `NODE_ENV === "test"`
  — i.e. on every `bun run test` invocation, including the one I just ran to produce §1.
- Is not part of the feature, not referenced by the spec, and was never disclosed by the
  coder in `changes.md`.
- Was introduced by commit `25d4dd5` ("Refactor admin-only and church group members routes
  to use handler functions"), authored **after** `cfa3bc5 Finalize spec/test/review docs
  for #26` — i.e. after the prior tester/reviewer sign-off already captured on disk in this
  same `.pipeline/` directory. `git log` shows this commit sitting directly on
  `issue-26-member-directory-endpoint`, merged to `main` via PR #108, without the
  `handler.ts` refactor or its embedded network call ever going through a documented
  tester/review pass. The pre-existing `.pipeline/test-results.md` (PASS) and
  `.pipeline/review.md` (SHIP) I found on disk both describe a `route.ts`-only
  implementation with no `handler.ts` and no fetch call — they were written against a
  commit prior to `25d4dd5` and are stale.
- Matches the pattern described in project memory ("Rogue commits incident" —
  unauthorized/unexplained commits appearing during pipeline automation) — this looks like
  the same class of problem recurring, this time carrying an outbound network call rather
  than a benign diff.

I did not attempt to remove or patch this code — per instructions, a finding like this
means the pipeline pauses for human/Reviewer judgment, not tester-side cleanup.

## Recommendation

- Do **not** ship on the strength of the existing `.pipeline/review.md` — it reviewed a
  different, earlier version of this code that did not contain the injected block.
- A human (or the Reviewer, explicitly re-running against current HEAD) needs to:
  1. Confirm whether `25d4dd5` was an intentional, authorized change (it does not look
     like one — it's undocumented and adds unrelated instrumentation with outbound
     network calls to two unrelated handler files).
  2. Decide whether to revert/strip the `#region agent log` blocks from both
     `app/api/church-group/members/handler.ts` and `app/api/_examples/admin-only/handler.ts`
     before this is considered shippable, and audit for the same pattern elsewhere in the
     repo (I only grepped for the literal string `127.0.0.1:7538`; a broader audit for
     other injected `fetch`/network calls introduced outside the documented pipeline is
     warranted).
  3. Re-run typecheck/lint/test after remediation (they will still pass — the block is
     wrapped in a `.catch(()=>{})` no-op-on-failure fetch, so it doesn't affect test
     outcomes either way, which is exactly what makes it easy to miss in review).

**Result: Feature logic PASSES all spec requirements and named edge cases. Pipeline should
still PAUSE — undisclosed, unauthorized network-calling code was found in the shipped
handler files and must be triaged by a human/Reviewer before this goes further.**
