# Review — Issue #54: Draft setlist creation (BR-01 zero-song valid state)

## VERDICT: SHIP

## What I verified (independently, not just from the summaries)

- Ran `git diff main...HEAD`: production change is exactly two files —
  `app/api/service-weeks/[id]/setlist/handler.ts` (new) and `route.ts`
  (stubs -> real handlers). No migration, no `createServiceWeek` change, no
  scope creep. Matches the spec.
- `bun run lint` — clean. `bun run typecheck` — clean.
- `bun run test` on both setlist suites — 23/23 pass (coder 16 + tester
  supplement 7).
- Cross-checked the spec's factual claims against source, not trusted:
  - `setlists` table: `service_week_id uuid not null unique`, `status
    setlist_status not null default 'draft'` — confirmed in
    `20260702000003_cluster_3_scheduling_core.sql`.
  - RLS `setlists_select_published_members` (members/guests see published
    only; leaders/admins see all) and insert/update/delete restricted to
    leader/admin — confirmed in `20260704000001_rls_policies.sql`.
  - Handler faithfully mirrors the existing `getServiceWeek` pattern
    (auth -> JWT -> tenant-scoped query -> guest invitation check -> 404 never
    403 for hidden/absent rows).

## Correctness assessment

- getSetlist: correct. RLS filters drafts for members/guests, handler maps
  null -> 404 (no existence leak). Guest invitation gate mirrors
  `getServiceWeek` and returns 404, not 403, when absent. Both query legs are
  scoped by `church_group_id`.
- createSetlist: correct. `requireRole(["admin","set_leader"])` throws 403
  before Supabase is constructed (test-asserted). Tenant-scoped
  `service_weeks` existence check runs before any setlist touch (404
  short-circuit test-asserted). Get-or-create returns existing draft as 200,
  new insert as 201; insert payload omits `status` (DB default), asserted via
  a real `hasOwnProperty` check. No `req.json()` read (asserted with a
  throwing json()).
- Tests are meaningful, not superficial: the tester supplement specifically
  addresses that the coder's `makeChain.eq()` is a no-op passthrough that
  ignores its arguments, and re-checks tenant scoping by recording actual
  `.eq()` args (including an OTHER_CHURCH_GROUP_ID case) plus call ordering and
  a true two-call double-POST idempotency drive. This is exactly the kind of
  independent verification the contract asks for.

## Non-blocking observations (for the human, no action required for #54)

- Get-or-create is check-then-insert. A truly concurrent double-POST could
  have both callers pass the existence check and race the unique constraint;
  the loser's insert errors -> 500 (not 200). The spec explicitly sanctions
  this ("also covers a unique-constraint race"), and in practice the setlist
  is auto-created at week creation so this path is a rarely-hit safety net.
  Acceptable for #54; a future hardening could catch the unique-violation and
  re-read to return 200.
- `createServiceWeek` auto-create and this `createSetlist` both omit `status`
  and rely on the DB default — consistent, but coupled to that default. Noted
  by the tester; out of scope for #54.
- The tester supplement file
  (`tests/unit/app/api/service-weeks-setlist-route-tester-supplement.test.ts`)
  is currently untracked; orchestration must commit it alongside the artifacts
  so the coverage is durable. Not a code defect.

Green tests here reflect genuinely correct behavior. Ship it.
