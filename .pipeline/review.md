# Review — Issue #44: Token-based public invitation lookup

## VERDICT: SHIP

Reviewed the actual diff for commit `8563bbb` (not just the summaries), re-ran
`bun run typecheck` (clean) and `bun run test` (29 suites / 368 tests pass), and
cross-checked correctness beyond green tests.

## What was verified

- **Matches spec.** All six files match the spec's code samples near-verbatim:
  the `get_invitation_by_token` RPC (STABLE / SECURITY DEFINER / `search_path=''`,
  `P0001` NOT_FOUND raise, `coalesce` to `'[]'` for events, computed `expired`
  only for still-pending past-deadline rows, GRANT to anon+authenticated,
  commented DOWN line), the `lib/supabase/types.ts` Functions entry, the schema,
  the handler, and the thin route wrapper.
- **Security / anti-enumeration is real, not superficial.** Malformed tokens
  return the byte-identical `{ error: "Not found", code: "NOT_FOUND" }` 404 as
  unknown-but-valid tokens, and the RPC / `getAnonSupabaseClient` are never
  reached on a malformed token. Confirmed by the route tests (two malformed
  variants asserting `not.toHaveBeenCalled()`) and the supplemental deep-equal
  test. No Clerk/session/`requireAuth` on this path, by design (#40).
- **No false-404 risk on real tokens.** `respondTokenParamSchema`
  (`.length(64).regex(/^[0-9a-f]{64}$/)`) is the exact shape the already-shipped
  #41 no-session accept path uses to validate `responseToken`, so genuine
  lowercase-hex `response_token` values pass validation. The lowercase-only
  regex is intentional and consistent with the existing path.
- **Tests are meaningful.** The route test covers all 7 spec edge cases (happy,
  expired→200, already-responded parameterized over accepted/denied/withdrawn,
  unknown→404, two malformed variants, empty events, unexpected error→500) and
  asserts the actual camelCase mapping, not just status codes. The Tester's
  supplemental file adds genuine gaps (deep-equal anti-enumeration, uppercase-hex
  404, client-construction throw → 500, promise-rejection → 500, null
  pass-through).
- **Scope is clean.** The #44 commit touches only the intended files plus the
  pipeline artifacts; no scope creep, no unrelated refactors. (The deny-route and
  async-agent-flow docs appearing in a `main...HEAD` three-dot diff are from
  already-merged PRs #128/#129, not this issue's commit.)

## Notes (non-blocking)

- The RPC body itself has no live-DB test harness in this repo — consistent with
  the `accept_invitation` precedent and explicitly out of scope per spec. RPC
  correctness rests on code review against the established pattern, which holds.
- Handler does not null-guard `data` before `data.invitation_id`; the RPC never
  returns null on success (it raises on not-found), and any surprise null would
  fall through to the outer `try/catch` → 500. Acceptable.
- Malformed-vs-unknown paths differ in latency (malformed short-circuits before
  the DB round-trip). The spec's acceptance criterion is body-identity only,
  which is met; a timing side-channel is out of scope.

Ship it. Human still owns the final PR-diff sign-off and merge.
