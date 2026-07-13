# Spec — Issue #46: Conflict detection on availability change

Surface a conflict to admins/set_leaders **the moment** a confirmed member becomes
unavailable for a date they have an accepted invitation on. Two trigger points feed
**one** shared implementation (BR-15): the explicit "mark unavailable" PUT (#34) and
the delete-to-unset DELETE (#35).

## No OPEN QUESTIONS

Two decisions were resolved from existing repo state/convention rather than escalated —
the Coder must NOT re-litigate them:

1. **SMS + email are not dispatched in this issue.** AC2 says "SMS + email", but the
   dispatch primitives throw `not implemented — see Sprint 4` (`lib/pingram/client.ts`
   `sendSms`, `lib/resend/client.ts` `sendEmail`). Every shipped notify path in this repo
   does the same thing: create the **in-app** notification now and leave a `TODO` for the
   Sprint 4 SMS/email fan-out (see `app/api/invitations/handler.ts` `createInvitation`
   `// TODO(#67/#68)` and `denyInvitation`, and the accept RPC which notifies in-app only).
   Follow that convention exactly: implement the in-app notification + a TODO comment
   referencing `#58` (SMS) / `#59` (email). Do NOT import or call `sendSms`/`sendEmail`.
2. **Recipients = every `admin`/`set_leader` in the church group, excluding the triggering
   user.** The `conflicts` table and its RLS are leader/admin-scoped, and the goal is to
   surface to "the Set Leader"; notifying all leaders/admins is the robust choice.

## What already exists (do NOT rebuild)

- The shared trigger primitive is already built and already satisfies AC1 (record created)
  and AC4 (links `invitation_id`):
  - `lib/scheduling/conflict-detection.ts` → `recordAvailabilityConflict(supabase, date, reason)`
    calls the `record_availability_conflict` RPC; `reason: ConflictTriggerReason =
    "availability_deleted" | "marked_unavailable"`.
  - `supabase/migrations/20260711000001_availability_conflict_rpc.sql` — the SECURITY
    DEFINER RPC that, for the caller's own user+group (derived from the JWT), inserts one
    `conflicts` row (`church_group_id, invitation_id, triggered_by, trigger_reason`) per
    accepted invitation to a service on `p_date`; returns `true` iff ≥1 was recorded.
  - `record_availability_conflict` is already typed in `lib/supabase/types.ts` `Functions`
    (`Args: { p_date, p_trigger_reason }`, `Returns: boolean`). **Its signature/return type
    do not change in this issue, so `types.ts` needs no edit.**
- The **#35 DELETE trigger point is already wired**: `app/api/availability/handler.ts`
  `deleteAvailability` calls `recordAvailabilityConflict(..., "availability_deleted")`.
- The `scheduling_conflict` value already exists in the `notification_type` enum
  (`supabase/migrations/20260702000005_cluster_5_partial.sql`) — **no new enum value needed.**

So exactly two gaps remain: (A) the **#34 PUT trigger point is not wired**, and (B) the RPC
records the conflict but **sends no notification**.

## Files to create / modify

### 1. `app/api/availability/handler.ts` (MODIFY — wire the #34 trigger point)

In `setAvailability`, **after** the upsert succeeds (after the `if (error) return fail(...)`
INTERNAL check, before building the response), fire conflict detection for every date the
member set to **unavailable**. Marking a date available must NOT trigger anything.

- Iterate the `byDate` map (already built above) and collect dates where `isAvailable === false`.
- For each such date, `await recordAvailabilityConflict(supabase, date, "marked_unavailable")`.
  `supabase` is the RLS-scoped client already created in this function. Use the exact literal
  `"marked_unavailable"` (it is the second `ConflictTriggerReason` value).
- Track whether any call returned `true`.
- `recordAvailabilityConflict` throws `ApiException(INTERNAL, 500)` on RPC error; the existing
  `try/catch` at the end of the function already maps that to a 500 — do not add new handling,
  just let it propagate (mirrors how `deleteAvailability` relies on the same catch).
- Extend the PUT success response to report it. Change the return to include a new field
  alongside `availability`:

  ```ts
  return ok({ availability, conflictTriggered });
  ```

  where `conflictTriggered: boolean` is `true` iff at least one `recordAvailabilityConflict`
  call returned `true`. (Mirrors `DeleteAvailabilityResult.conflictTriggered` on the DELETE path.)

Order matters: the upsert writes the `is_available: false` row (and its `note`) BEFORE the RPC
runs, so the RPC can read that note for the notification (see file 2). Keep this ordering.

Do NOT change GET, DELETE, validation, expansion, or the dedupe logic.

### 2. `supabase/migrations/20260713000001_conflict_notification.sql` (CREATE)

A new migration that `CREATE OR REPLACE`s `public.record_availability_conflict` (append-only
migration convention — see how `20260711000001_service_week_notification_types.sql` and
`20260712000002_invitation_withdrawn_notification_type.sql` extend prior objects in fresh
migrations; do NOT edit the original `20260711000001_availability_conflict_rpc.sql`).

Keep the **exact same signature** `(p_date date, p_trigger_reason text) RETURNS boolean`,
`LANGUAGE plpgsql SECURITY DEFINER VOLATILE SET search_path = ''`, and the same
JWT-derivation / UNAUTHENTICATED guard and accepted-invitation loop. The only behavioral
change: inside the per-invitation loop, after each `INSERT INTO public.conflicts (...)`, also
insert the admin notification(s). Copy the notify pattern from `accept_invitation`
(`supabase/migrations/20260712000001_accept_invitation_rpc.sql`, lines ~103–123).

Required additions inside the RPC:

- Capture the newly inserted conflict id: change the conflicts insert to
  `INSERT INTO public.conflicts (...) VALUES (...) RETURNING id INTO v_conflict_id;`
  (declare `v_conflict_id uuid;`).
- Look up the triggering member's name once (before or inside the loop):
  `SELECT name INTO v_member_name FROM public.users WHERE id = v_user_id;`
  (declare `v_member_name text;`).
- Read the reason from the member's own availability row for the date (present on the
  `marked_unavailable` path; NULL on the `availability_deleted` path because the row was
  already deleted before the RPC runs — that is correct, "reason if provided"):
  `SELECT note INTO v_reason FROM public.availability WHERE user_id = v_user_id AND date = p_date;`
  (declare `v_reason text;`).
- Build a service label from the joined service week (the loop already joins
  `service_weeks sw`): also select `sw.title` and `sw.service_date` into the loop record so a
  human-readable label is available. Prefer `sw.title`; fall back to `'the service on ' ||
  sw.service_date`.
- For each conflict, `FOR v_recipient IN SELECT id FROM public.users WHERE church_group_id =
  v_group_id AND role IN ('admin','set_leader') AND id <> v_user_id LOOP ... END LOOP`,
  inserting one notification per recipient:
  ```sql
  INSERT INTO public.notifications
    (church_group_id, user_id, type, title, body, link_entity_type, link_entity_id)
  VALUES
    (v_group_id, v_recipient.id, 'scheduling_conflict', 'Scheduling conflict',
     v_member_name || ' can no longer make ' || <service label>
       || CASE WHEN v_reason IS NOT NULL THEN ' — reason: ' || v_reason ELSE '' END,
     'conflict', v_conflict_id);
  ```
  `title` must be ≤ 200 chars (`notifications.title varchar(200)`); the constant above is fine.
- Add a `-- TODO(#58/#59): dispatch SMS + email to these recipients (Sprint 4).` comment where
  the notifications are inserted, matching the repo's deferred-dispatch convention.
- Keep `RETURN v_triggered;` and `GRANT EXECUTE ON FUNCTION public.record_availability_conflict(date, text) TO authenticated;`.
- Include a header comment (issue #46, why notifications belong in the SECURITY DEFINER RPC:
  `notifications_insert_leader_admin` is leader/admin-only, so a plain member marking
  unavailable cannot insert notifications under plain RLS — same reason the conflicts insert
  lives here) and a commented `-- ============ DOWN ============` /
  `-- DROP FUNCTION IF EXISTS public.record_availability_conflict(date, text);` section,
  matching the sibling migrations.

### 3. `tests/unit/app/api/availability-route.test.ts` (MODIFY — cover the #34 wiring)

Add tests to the existing `describe("PUT /api/availability")` block. The PUT mock helper
`makeSupabaseClientForPut` returns an object with `from`/`upsert`/`select` but **no `rpc`** —
extend it (or add a variant) so the mocked client also exposes
`rpc: jest.fn().mockResolvedValue({ data: <bool>, error: null })`, since `setAvailability`
now calls `supabase.rpc("record_availability_conflict", ...)` on unavailable dates. Follow the
existing `makeSupabaseClientForDelete` shape for the `rpc` mock. Cover:

- Setting a date `isAvailable: false` calls `rpc` with exactly
  `("record_availability_conflict", { p_date: <date>, p_trigger_reason: "marked_unavailable" })`,
  and the 200 body includes `conflictTriggered: true` when the RPC returns `{ data: true }`.
- Setting a date `isAvailable: true` (or omitted → default true) does NOT call `rpc`, and the
  body reports `conflictTriggered: false`.
- A range/multi-date PUT mixing available and unavailable dates calls `rpc` once per
  **unavailable** date only.
- When the RPC returns `{ data: null, error: {...} }`, PUT returns 500 `INTERNAL`
  (propagated via the existing catch).
- Existing PUT tests that assert `body.data` equality must be updated to include the new
  `conflictTriggered` field (or assert on `body.data.availability` specifically).

### 4. `tests/unit/lib/scheduling/conflict-detection.test.ts` (MODIFY — minor)

`recordAvailabilityConflict` is unchanged, but add one case asserting it forwards the
`"marked_unavailable"` reason verbatim to the RPC (the existing cases only exercise
`"availability_deleted"`). No behavior change beyond coverage.

## Edge cases the implementation MUST handle

1. **Marking available (or default true) is never a conflict** — no `rpc` call for those dates.
2. **Multi-date PUT** — one `record_availability_conflict` call per unavailable date; a range
   set unavailable fires per expanded date.
3. **No accepted invitation on the date** — RPC returns `false`, no conflict row, no
   notification; PUT still succeeds with `conflictTriggered: false`.
4. **Reason present vs absent** — `marked_unavailable` carries the member's `note` into the
   notification body; `availability_deleted` has no note (row already gone) → notification omits
   the reason clause. Never error on a NULL note.
5. **Multiple accepted invitations on one date** — the RPC loop records a conflict + notifies
   per invitation (existing loop; unchanged control flow).
6. **RPC/DB error** — surfaces as 500 `INTERNAL` on both PUT and DELETE; never a silent no-op.
7. **Triggering user is themselves a leader/admin** — excluded from recipients (`id <> v_user_id`),
   no self-notification.
8. **Both trigger paths converge on the same RPC** (AC3) — DELETE (`availability_deleted`,
   already wired) and PUT (`marked_unavailable`, new) both get identical conflict + notification
   behavior because the logic lives only in the RPC + `recordAvailabilityConflict`.

## Explicitly OUT OF SCOPE (do not implement)

- SMS/email dispatch (Sprint 4 #58/#59) — in-app notification + TODO only (see Decision 1).
- Conflict **resolution** (#47) and the resolution UI (#50): `GET /api/conflicts`,
  `POST /api/conflicts/[id]/resolve`, and `app/(app)/conflicts/page.tsx` stay stubs.
- AI replacement suggestions (Phase 4).
- Any new `notification_type` enum value (`scheduling_conflict` already exists).
- Widening `lib/supabase/types.ts` (the RPC signature/return are unchanged).
- Changing GET / team availability, or adding an admin-sets-another-member availability path.

## Verification before finishing (Coding stage)

Run `bun run lint`, `bun run typecheck`, and `bun run test` (Jest). The RPC has no live-DB
test harness in this repo (like `accept_invitation` / `record_availability_conflict`, it is
exercised only through mocked-client route tests) — verify RPC-body correctness by review plus
the route/unit tests that mock its return values; do not add a live-DB test.
