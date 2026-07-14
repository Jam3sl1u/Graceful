# Changes — Issue #47: Conflict resolution flow (3 paths, manual-only)

## Summary

Wired up the two previously-stubbed (`notImplemented` 501) conflict endpoints:

- `GET /api/conflicts` — lists OPEN conflicts (`resolved_at IS NULL`) for the
  caller's church group, joined in-memory with member/service-week data.
  set_leader/admin only.
- `POST /api/conflicts/:id/resolve` — resolves one conflict via `withdraw`,
  `member_reconfirmed`, or `admin_dismissed`. set_leader/admin only.

This is manual-only, per spec — no AI replacement suggestion path was added,
and `replacement_suggestion_user_id` is never touched.

## Files changed

- **`types/domain.ts`** — Fixed `ResolutionType` to match the DB enum exactly:
  `"replaced" | "withdrawn" | "member_reconfirmed" | "admin_dismissed"`
  (previously `"withdraw" | "member_reconfirmed" | "admin_dismissed"`, which
  didn't match the DB and would have made writing `'withdrawn'` a TS error).
  `ResolutionType` has no other referrers besides `lib/supabase/types.ts`, so
  this is a safe, isolated fix.

- **`schemas/conflicts.ts`** — Replaced the empty placeholder `conflictsSchema`
  (confirmed via grep to have no importers) with `resolveConflictSchema`
  (zod), validating the request body's `resolution` field against the three
  manual API-facing values (`withdraw` / `member_reconfirmed` /
  `admin_dismissed` — note this is a distinct, narrower vocabulary from the
  DB's `resolution_type` enum; the handler maps `"withdraw"` → DB value
  `"withdrawn"`).

- **`lib/supabase/types.ts`** — Added `events` and `event_attendees` table
  entries (`EventsRow`, `EventAttendeesRow`, and their `Database["public"]
  ["Tables"]` entries) matching the columns already defined in migration
  `20260702000003_cluster_3_scheduling_core.sql`. These tables exist in the DB
  but were not yet represented in this hand-rolled type file (no prior
  handler needed them); the withdraw path here is the first to query them
  (`events` to find a service week's events, `event_attendees` to delete a
  withdrawn member's attendance rows), so this addition was required for
  `bun run typecheck` to pass. No other table's types were touched.

- **`app/api/conflicts/handler.ts`** (new) — `getOpenConflicts` and
  `resolveConflict`, mirroring the auth/error-handling style of
  `app/api/invitations/handler.ts` and the multi-query in-memory-join style
  of `app/api/church-group/members/handler.ts`:
  - `getOpenConflicts`: `requireAuth` + `requireRole(["admin","set_leader"])`,
    queries `conflicts` scoped to the caller's group with `resolved_at IS
    NULL`, then joins `invitations` → `users`/`service_weeks` by id sets
    (guarding empty id-set queries). Missing joined rows fall back to safe
    defaults (`memberName: ""`, empty ids, `invitationStatus: "withdrawn"`)
    rather than dropping the conflict. Returns `{ conflicts: OpenConflict[] }`
    (exported type).
  - `resolveConflict(req, id, lookup?)`: loads and 404s a missing/wrong-group
    conflict, 409s an already-resolved one (idempotency guard with no side
    effects), validates the body against `resolveConflictSchema` (400 on
    failure), then branches:
    - `withdraw`: loads the invitation (404 if missing), flips its status to
      `withdrawn`, deletes the member's `event_attendees` rows across the
      service week's events (via an `events` lookup by `service_week_id`,
      skipped entirely when the week has no events — idempotent no-op),
      leaves a `// TODO(#62): delete member's Google Calendar events for this
      week` comment (no GCal per-attendee sync exists yet — see spec's NOTE),
      and inserts an `invitation_withdrawn` notification (same shape as
      `withdrawInvitation` from #43).
    - `member_reconfirmed` / `admin_dismissed`: no `invitations`/
      `event_attendees` writes at all.
    - All branches then mark the conflict resolved LAST
      (`resolution_type` + `resolved_at`), so a mid-operation failure leaves
      the conflict open and retryable, and write an audit log
      (`conflict.resolved`). Returns `{ conflict: { id, resolutionType,
      resolvedAt } }`.
  - Every DB `.error` path returns 500 INTERNAL; the whole body is wrapped in
    the standard `try/catch` → `ApiException`/`INTERNAL 500` fallback.

- **`app/api/conflicts/route.ts`** (modified) — replaced the `notImplemented`
  stub; `GET` now delegates to `getOpenConflicts`.

- **`app/api/conflicts/[id]/resolve/route.ts`** (modified) — replaced the
  `notImplemented` stub; `POST` now awaits the `{ id }` param and delegates to
  `resolveConflict`, mirroring `app/api/invitations/[id]/route.ts`'s param
  handling.

- **`.pipeline/spec.md`** — carried over as written by the Planning stage for
  this issue (overwrites the prior #46 spec, per the pipeline contract).

## Not touched (out of scope, per spec)

- No new SQL migration or RPC — all writes here are permitted to
  set_leader/admin directly under existing RLS (`conflicts_update_leader_admin`,
  invitations UPDATE, `event_attendees_delete_tenant`, notifications INSERT).
- No Google Calendar integration — `TODO(#62)` comment only.
- No AI replacement-suggestion endpoint (Phase 4) — the "manual replacement
  always available" AC is satisfied by the withdraw path reopening the slot;
  a replacement is invited through the existing `POST /api/invitations` flow.

## Verification run

- `bun run typecheck` — passes (no errors).
- `bun run lint` — passes (no errors/warnings).
- `bun run test` — 32 suites / 388 tests, all passing (no regressions; no
  conflicts-specific tests exist yet — this issue's spec designates writing
  them to the Testing stage, modeled on
  `tests/unit/app/api/invitations-withdraw-route.test.ts`).

## Testing-stage focus

- The existing chainable Supabase mock in
  `tests/unit/app/api/invitations-withdraw-route.test.ts` (`makeChain`) does
  not yet support `.is(...)` (used by `getOpenConflicts`'s `resolved_at IS
  NULL` filter) or a `.delete()` chain (used by the withdraw path's
  `event_attendees` cleanup) — the Testing stage will need to extend the
  mock/fixture helpers for those.
- Edge cases named in the spec worth exercising explicitly: unknown/
  wrong-group conflict id → 404; already-resolved conflict → 409 with no side
  effects; invalid/missing `resolution` → 400; member/unauthenticated caller →
  403/401 on both GET and resolve; withdraw with zero events for the week
  (no-op delete, still succeeds); withdraw on an invitation already
  `withdrawn`/`denied` (no 409 — only the conflict's own `resolved_at`
  guards); `member_reconfirmed`/`admin_dismissed` must not write
  `invitations`/`event_attendees` at all; GET with no open conflicts → `{
  conflicts: [] }`.
