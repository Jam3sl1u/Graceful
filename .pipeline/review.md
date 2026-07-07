# Review — Issue #26 member directory endpoint (`GET /api/church-group/members`)

## VERDICT: BLOCK

The feature logic is correct and matches the spec. But two shipped handler files on
this branch contain undisclosed, network-calling debug instrumentation that must be
removed before anything ships. Green tests do not clear this.

---

## Feature assessment (this part is clean)

Read `app/api/church-group/members/handler.ts` + `route.ts` and
`lib/supabase/types.ts` directly. Against `.pipeline/spec.md`:

- Order of ops correct: `requireAuth` -> `requireRole(["admin","set_leader","member"])`
  (guest 403) -> `getToken({template:"supabase"})` with 401 on missing JWT -> 4
  group-scoped queries via `Promise.all` -> 500 `INTERNAL` on any `.error` -> in-JS
  assembly -> `ok({ members })`.
- `email`/`phone` are only assigned inside `if (ctx.role === "admin")` — genuinely
  omitted (not `null`) for non-admins. Correct per AC-2.
- No-profile user -> `vocalCapability: 'none'`, `instruments: []`, still listed.
- Dangling `member_instruments.instrument_id` skipped (`if (!name) continue`).
- Explicit `.eq("church_group_id", ctx.churchGroupId)` on `users`/`instruments`
  (defense-in-depth on top of RLS) per AC-3.
- `availabilityStatus: null` placeholder with #34 comment.
- `lib/supabase/types.ts` additions match the spec field-by-field; `lib/api/auth.ts`
  untouched.
- Tests cover the required cases; typecheck/lint/test all pass.

On feature requirements alone this would be a SHIP.

---

## Blocking issue: injected outbound network call in shipped handlers

`app/api/church-group/members/handler.ts:25-27` and
`app/api/_examples/admin-only/handler.ts:8-10` both contain:

```ts
// #region agent log
if (process.env.NODE_ENV === "test") fetch('http://127.0.0.1:7538/ingest/73d41e57-...',{method:'POST',...,body:JSON.stringify({sessionId:'8ebabd',runId:'pre-fix',hypothesisId:'H1',...})}).catch(()=>{});
// #endregion
```

Why this blocks:

1. **Undisclosed outbound network call in shipped request-path code.** `route.ts` ->
   `handler.ts` is the live handler. It fires a POST to a hardcoded loopback ingest
   endpoint whenever `NODE_ENV === "test"` (every `bun run test`), leaking internal
   request data (`hasLookup`, timestamps, session/hypothesis IDs).
2. **Not in the spec, not in `changes.md`, not authorized.** This is leftover
   automated-debugging-agent instrumentation (`#region agent log`, `hypothesisId`,
   `runId:'pre-fix'`), not part of issue #26.
3. **Introduced after sign-off, bypassing the pipeline.** Added by commit `25d4dd5`
   ("Refactor ... to use handler functions"), which lands *after* `cfa3bc5` finalized
   the review docs — so the on-disk PASS/SHIP docs never saw it. It is now merged to
   main via PR #108.
4. **Matches the "Rogue commits incident" pattern** in project memory —
   undocumented commits appearing during pipeline automation, this time carrying an
   outbound network call. The `.catch(()=>{})` no-op makes it invisible to test
   outcomes, which is exactly why it slipped through green tests.

## Required fixes

1. Strip the `#region agent log` blocks (the `fetch(...127.0.0.1:7538...)` lines)
   from BOTH `app/api/church-group/members/handler.ts` and
   `app/api/_examples/admin-only/handler.ts`.
2. Audit the rest of the repo for the same injection pattern (broader than the literal
   `127.0.0.1:7538` — any `fetch`/network/exec added outside the documented pipeline).
   My grep of `app/` + `lib/` found only these two occurrences; a full-repo/history
   sweep by a human is still warranted given the provenance.
3. Confirm whether commit `25d4dd5` was authorized at all; if not, revert it (the
   handler-extraction refactor can be re-done cleanly without the instrumentation).
4. Re-run typecheck/lint/test after removal (they will still pass — the block is a
   no-op on failure, so passing tests do not validate its absence).

Do not ship on the strength of the stale on-disk PASS/SHIP docs; they reviewed a
pre-`25d4dd5` state without this code.
