# Test Results — Issue #44: Token-based public invitation lookup

## Verdict: PASS

All checks re-run independently in the pinned worktree
(`/Users/jamesliu/Documents/Graceful/.claude/worktrees/issue-44`, branch
`issue-44-token-based-public-invitation-lookup`), confirmed clean, and
cross-checked against `.pipeline/spec.md` line by line (RPC SQL,
`lib/supabase/types.ts`, `schemas/invitations.ts`,
`app/api/invitations/handler.ts`, `app/api/invitations/respond/[token]/route.ts`).
Implementation matches the spec's code samples closely (near-verbatim in
several places). This file overwrites a stale leftover from a prior issue
(#42) that was still sitting at this path.

## Commands re-run

- `bun run lint` — clean, no errors/warnings.
- `bun run typecheck` (`tsc --noEmit`) — clean, no errors.
- `bun run test` (Jest, full suite) — **29 suites / 368 tests passed** (the
  coder's 28 suites / 363 tests, plus this stage's new supplemental file with
  5 additional tests; no failures, no skips).

## Independent verification performed

Read the actual diff (not just `changes.md`'s description) for every file
listed:
- `supabase/migrations/20260712000002_get_invitation_by_token_rpc.sql` —
  matches spec's SQL sample verbatim; `STABLE`/`SECURITY DEFINER`/
  `SET search_path = ''`, `P0001` NOT_FOUND raise, coalesce to `'[]'` for
  events, computed `expired` only for still-pending + past-deadline rows,
  `GRANT ... TO anon, authenticated`, commented DOWN line present.
- `lib/supabase/types.ts` — `EventType` added to the domain import,
  `get_invitation_by_token` entry added to `Database["public"]["Functions"]`
  with the spec's exact `Args`/`Returns` shape.
- `schemas/invitations.ts` — `respondTokenParamSchema` added with the same
  64-char lowercase-hex shape as `acceptInvitationParamSchema`'s token.
- `app/api/invitations/handler.ts` — `getInvitationByToken` added exactly per
  spec: validates format first (anti-enumeration), never calls `requireAuth`/
  `auth()`/`getSupabaseClient`, uses `getAnonSupabaseClient()`, maps
  `NOT_FOUND` → 404, other RPC errors → 500, success → camelCase
  `PublicInvitationLookup`.
- `app/api/invitations/respond/[token]/route.ts` — thin `GET` wrapper,
  awaits `params`, delegates to the handler; `notImplemented` stub removed.

## New test file written by this stage (Tester)

`tests/unit/app/api/invitations-respond-route.supplemental.test.ts` (5 tests,
all passing) — closes gaps not exercised by the coder's own test file:

1. **Anti-enumeration, strengthened**: asserts the unknown-token response and
   a malformed-token response are deep-equal *to each other* (status + body),
   not just each separately matching a literal object. This is what the
   acceptance criterion in the spec actually requires and is a stronger check
   than the coder's two independent literal-equality assertions.
2. **Case-sensitivity edge case**: an uppercase-hex token of the correct
   length (`"A".repeat(64)`) is malformed under the regex
   (`^[0-9a-f]{64}$`, lowercase only) and must 404 without ever calling
   `getAnonSupabaseClient` — not in the spec's enumerated edge cases or the
   coder's tests, but a real gap in the anti-enumeration surface if a caller
   relied on case-insensitive matching.
3. **Failure case A**: `getAnonSupabaseClient()` itself throwing
   synchronously (e.g. missing env var) is caught by the handler's outer
   `try/catch` and maps to 500 `INTERNAL`. Not covered by the coder's suite,
   which only exercises RPC-level `{ error }` responses, not client
   construction failures.
4. **Failure case B**: the RPC call's promise *rejecting* (simulating a
   network failure) rather than resolving with `{ data: null, error }` is
   also caught and maps to 500 `INTERNAL`. Also not covered by the coder's
   suite.
5. **Null pass-through**: `roleNote`, `responseDeadline`, and
   `serviceWeek.title` all pass through as `null` unchanged rather than being
   coerced or dropped, confirming the mapping function's null-safety for
   every nullable field in `PublicInvitationLookup`.

## Spec edge cases re-verified as covered (by the coder's own test file, independently read and confirmed correct)

1. Happy path (pending) — 200, full camelCase body, `getAnonSupabaseClient`
   called with correct RPC args. Confirmed.
2. Expired (still-pending, RPC-computed `status: "expired"`) — 200, not an
   error code. Confirmed.
3. Already responded (`accepted`/`denied`/`withdrawn`, parameterized) — 200
   with the real status. Confirmed.
4. Unknown token (valid format, RPC `NOT_FOUND`) — 404
   `{ error: "Not found", code: "NOT_FOUND" }`. Confirmed.
5. Malformed token (wrong length; non-hex) — identical 404 body to case 4,
   RPC never called. Confirmed, and strengthened by this stage's byte-
   identical deep-equal test above.
6. Empty events (`events: []`) — 200, `events: []` in response. Confirmed.
7. Unexpected RPC error — 500 `INTERNAL`. Confirmed.

## Not independently verifiable in this environment

- The RPC SQL body itself (`get_invitation_by_token`) has no live-DB test
  harness in this repo, consistent with `accept_invitation`'s precedent and
  explicitly out of scope per spec ("do not add a live-DB test"). Correctness
  was checked by direct line-by-line comparison against the spec's SQL
  sample and the `accept_invitation` migration's established pattern
  (`SECURITY DEFINER`, `STABLE`, `search_path` hardening, `P0001` error
  code), not by execution.

## Failure cases

None. No test failures encountered in this run — original suite, and the
5 new supplemental tests, all pass. Lint and typecheck are both clean.
