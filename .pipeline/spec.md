# Spec — Issue #208: [Phase 2 / Sprint 5] Schema — chat tables + RLS (P2-01)

## OPEN QUESTIONS

None blocking. The operator decision D2 (2026-11-16) is applied as settled.

Non-blocking notes for the reviewer/human. Each one is decided below; do not stop for them:

- **N1 — Missing source doc.** `documentation/phase-2/graceful_phase2_sprint_backlog.md` (cited by the issue) does **not exist** in this checkout. This spec comes from the issue body, PRD v10 (§10, §15.1, §20.7, §22.11, §25.1) and the actual repo state. If row P2-01 in that file says something the issue body does not, this spec will not reflect it.
- **N2 — Planner decisions not dictated by the issue/PRD** (listed in "Decisions" below): `church_group_id` on `chat_messages`, who may create/update rooms, who may soft-delete messages, archive applies to message UPDATE too, and no DELETE policy on any chat table. A later migration can relax any of them.
- **N3 — Pre-existing failure, not introduced here.** `tests/integration/rls/tables/phase1-token-bypass.test.ts` block A, test "PHASE1_TABLES exactly matches every table created in supabase/migrations/*.sql", **already fails on `main`**. Migrations create 21 tables (`app_secrets` and `practice_reminder_sends` from #69 are not in its 19-entry list). It runs under `bun run test:rls` even without secrets. This issue does **not** touch that file. Record it in `changes.md` as pre-existing.

## Scope

In scope: one new migration (three tables, one enum, one helper function, RLS), hand-updated `lib/supabase/types.ts` + `types/domain.ts`, RLS test seed/coverage extension, a new chat RLS integration test file, and one static unit test.

Out of scope, do not build: any API route or handler, room auto-creation/activation on first accept, archive-after-service automation, `chat_mention` notification dispatch, pin UI, YouVersion/devotion import (P2-22), any edit to an applied migration, and `supabase/README.md`.

Applying the migration to staging/production is a **human step**. Say so in `changes.md` so it carries into the PR body.

## Decisions (D2 is the operator's; the rest are the planner's)

- **D2 (operator):** A user is a member of a week's chat room iff the room is in the caller's church group **and** one of these holds:
  - the caller's role is `admin` or `set_leader`, or
  - the caller has an `invitations` row for that room's `service_week_id` with `status = 'accepted'`. This covers members and guests alike.
  - Pending, denied and withdrawn invitees are **not** members.
- `chat_messages` gets a `church_group_id` column. PRD §25.1 explicitly lists "chat messages" as needing one; §20.7's column table omits it. It must equal the parent room's `church_group_id`, enforced in the INSERT/UPDATE `WITH CHECK`.
- `chat_mentions` has **no** `church_group_id`. It is scoped through its parent message, the same way `event_attendees` is scoped through `events`.
- Rooms: INSERT and UPDATE are allowed for admin/set_leader in their own group. Members and guests get neither. There is no DELETE policy. Rooms disappear only by FK cascade from `service_weeks`/`church_groups`, and RI cascades bypass RLS.
- Messages: INSERT is allowed for room members, as themselves, into non-archived rooms. UPDATE is allowed for the author only (this is the soft-delete path), and only while the room is not archived (PRD §20.7: archived means "readable, not writable"). There is no DELETE policy (PRD: soft-delete only). There is no leader/admin moderation policy.
- Mentions: INSERT is allowed only for the parent message's author, while the room is not archived, and only if the mentioned user is in the same church group. There is no UPDATE or DELETE policy.
- `kind` is a new Postgres enum `chat_message_kind ('text', 'devotion')`, default `'text'`. This follows the repo's enum pattern from `20260702000003_cluster_3_scheduling_core.sql`.
- RLS does **not** hide `is_deleted = true` rows. Redacting deleted content is the API layer's job in a later issue. Do not add an `is_deleted` filter to SELECT policies, because that would break the author's own soft-delete UPDATE.

## Files

### 1. CREATE `supabase/migrations/20261116000001_chat_tables_rls.sql`

Header comment block: issue #208 / P2-01, PRD §15.1/§20.7/§22.11/§25.1, D2 rule, and a note that it depends on clusters 1, 3 and 5 plus `20260704000001_rls_policies.sql` (`auth_*` helpers). Then `-- ============ UP ============`, then a fully commented `-- ============ DOWN ============` block.

Patterns to copy:
- Table DDL: `supabase/migrations/20260702000005_cluster_5_partial.sql` and `20260702000003_cluster_3_scheduling_core.sql` (`gen_random_uuid()` PKs, `timestamptz not null default now()`, `on delete cascade`).
- Helper function and policies: `supabase/migrations/20260704000001_rls_policies.sql`. Use `public.`-qualified names, `TO authenticated`, policy naming `<table>_<verb>_<scope>`, and `SECURITY DEFINER` + `SET search_path = ''` + `STABLE` + `LANGUAGE sql`.
- DOWN block style: same file, commented, reverse dependency order.

Do not write the literal phrase `create table` in any SQL comment. The coverage-pin regex in `phase1-token-bypass.test.ts` scans every migration for it.

UP contents, in this order:

1. `CREATE TYPE public.chat_message_kind AS ENUM ('text', 'devotion');`
2. Table `public.chat_rooms`:
   - `id uuid primary key default gen_random_uuid()`
   - `church_group_id uuid not null references church_groups(id) on delete cascade`
   - `service_week_id uuid not null unique references service_weeks(id) on delete cascade`
   - `is_archived boolean not null default false`
   - `pinned_message_id uuid` (nullable; FK added in step 4)
   - `created_at timestamptz not null default now()`
3. Table `public.chat_messages`:
   - `id uuid primary key default gen_random_uuid()`
   - `chat_room_id uuid not null references chat_rooms(id) on delete cascade`
   - `church_group_id uuid not null references church_groups(id) on delete cascade`
   - `user_id uuid not null references users(id) on delete cascade` (sender)
   - `content text not null`, with a named constraint `chat_messages_content_length_check CHECK (char_length(content) <= 2000)`. This is defence in depth; the API layer is primary. Use `char_length` (characters), not `octet_length`.
   - `kind public.chat_message_kind not null default 'text'`
   - `metadata jsonb` (nullable, no default; reserved for P2-22)
   - `is_deleted boolean not null default false`
   - `created_at timestamptz not null default now()`
4. `ALTER TABLE public.chat_rooms ADD CONSTRAINT chat_rooms_pinned_message_id_fkey FOREIGN KEY (pinned_message_id) REFERENCES public.chat_messages(id) ON DELETE SET NULL;`. This is a circular reference, so it has to be added after both tables exist.
5. Table `public.chat_mentions`:
   - `id uuid primary key default gen_random_uuid()`
   - `message_id uuid not null references chat_messages(id) on delete cascade`
   - `mentioned_user_id uuid not null references users(id) on delete cascade`
   - `unique (message_id, mentioned_user_id)`
6. Indexes:
   - `idx_chat_messages_chat_room_id_created_at ON chat_messages (chat_room_id, created_at desc)` (paginated history)
   - `idx_chat_mentions_mentioned_user_id ON chat_mentions (mentioned_user_id)`
7. Helper `public.is_chat_room_member(p_chat_room_id uuid) RETURNS boolean`, with `LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''`. Logic:
   - Return `COALESCE(<expr>, false)`, so the result is never NULL.
   - `<expr>` is `EXISTS` a `public.chat_rooms r` row with `r.id = p_chat_room_id AND r.church_group_id = public.auth_church_group_id()`, where also either:
     - `public.auth_is_leader_or_admin()`, or
     - `EXISTS (SELECT 1 FROM public.invitations i WHERE i.service_week_id = r.service_week_id AND i.church_group_id = r.church_group_id AND i.user_id = public.auth_user_id() AND i.status = 'accepted')`.
   - It must be `SECURITY DEFINER`. It reads `chat_rooms` and `invitations` from inside `chat_rooms`' own policy; under invoker rights that recurses or is filtered by `invitations_select_own`.
   - No explicit GRANT. This matches the `auth_*` helpers, which rely on the default PUBLIC EXECUTE.
   - Add a comment stating the D2 rule.
8. `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` on all three tables.
9. Policies. All are `TO authenticated`. `G` = `public.auth_church_group_id()`, `ME` = `public.auth_user_id()`, `LA` = `public.auth_is_leader_or_admin()`, `M(x)` = `public.is_chat_room_member(x)`.

   **chat_rooms**
   - `chat_rooms_select_member` (SELECT): `USING (church_group_id = G AND M(id))`. Archived rooms stay readable.
   - `chat_rooms_insert_leader_admin` (INSERT): `WITH CHECK (church_group_id = G AND LA AND EXISTS (SELECT 1 FROM public.service_weeks sw WHERE sw.id = service_week_id AND sw.church_group_id = G))`.
   - `chat_rooms_update_leader_admin` (UPDATE):
     - `USING (church_group_id = G AND LA)`
     - `WITH CHECK (church_group_id = G AND LA AND EXISTS (service week in G, as above) AND (pinned_message_id IS NULL OR EXISTS (SELECT 1 FROM public.chat_messages m WHERE m.id = pinned_message_id AND m.chat_room_id = chat_rooms.id)))`. The pinned message must belong to this same room.
   - No DELETE policy (add a comment saying so).

   **chat_messages**
   - `chat_messages_select_member` (SELECT): `USING (church_group_id = G AND M(chat_room_id))`.
   - `chat_messages_insert_member` (INSERT): `WITH CHECK (user_id = ME AND church_group_id = G AND M(chat_room_id) AND EXISTS (SELECT 1 FROM public.chat_rooms r WHERE r.id = chat_room_id AND r.church_group_id = chat_messages.church_group_id AND r.is_archived = false))`. This clause is how "INSERT refused when is_archived" is enforced.
   - `chat_messages_update_own` (UPDATE):
     - `USING (user_id = ME AND church_group_id = G AND M(chat_room_id) AND <room not archived>)`
     - `WITH CHECK (<same predicate, including room.church_group_id = chat_messages.church_group_id>)`
   - No DELETE policy (soft-delete only; add a comment).

   **chat_mentions**
   - `chat_mentions_select_member` (SELECT): `USING (EXISTS (SELECT 1 FROM public.chat_messages m WHERE m.id = chat_mentions.message_id AND m.church_group_id = G AND M(m.chat_room_id)))`.
   - `chat_mentions_insert_author` (INSERT):
     - `WITH CHECK (EXISTS (SELECT 1 FROM public.chat_messages m JOIN public.chat_rooms r ON r.id = m.chat_room_id WHERE m.id = message_id AND m.user_id = ME AND m.church_group_id = G AND r.is_archived = false AND M(m.chat_room_id))`
     - `AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = mentioned_user_id AND u.church_group_id = G))`
   - No UPDATE or DELETE policy.

DOWN block (all lines commented), in reverse order: drop every policy above, `DROP FUNCTION IF EXISTS public.is_chat_room_member(uuid);`, drop the two indexes, `DROP TABLE IF EXISTS public.chat_mentions;`, `ALTER TABLE public.chat_rooms DROP CONSTRAINT IF EXISTS chat_rooms_pinned_message_id_fkey;`, `DROP TABLE IF EXISTS public.chat_messages;`, `DROP TABLE IF EXISTS public.chat_rooms;`, `DROP TYPE IF EXISTS public.chat_message_kind;`.

### 2. MODIFY `types/domain.ts`

Add `export type ChatMessageKind = "text" | "devotion";` next to the other enum unions. Do **not** touch the existing (mismatched) `ChatPref`.

### 3. MODIFY `lib/supabase/types.ts`

This file is **hand-maintained** (see its header). Do **not** run `supabase gen types`, which would overwrite the whole file. "Regenerate" here means adding the new objects by hand, following the existing `*Row` + `Database.public.Tables` entry pattern (copy `NotificationsRow` / `notifications`).

- Import `ChatMessageKind` from `@/types/domain`.
- `ChatRoomsRow`: `{ id: string; church_group_id: string; service_week_id: string; is_archived: boolean; pinned_message_id: string | null; created_at: string; }`
- `ChatMessagesRow`: `{ id: string; chat_room_id: string; church_group_id: string; user_id: string; content: string; kind: ChatMessageKind; metadata: Record<string, unknown> | null; is_deleted: boolean; created_at: string; }`
- `ChatMentionsRow`: `{ id: string; message_id: string; mentioned_user_id: string; }`
- `Tables` entries `chat_rooms`, `chat_messages`, `chat_mentions`. Each has `Row`, `Insert` and `Update: Partial<Row>`, plus `Relationships: []`.
  - `chat_rooms` Insert: optional `id`, `created_at`, `is_archived`, `pinned_message_id`.
  - `chat_messages` Insert: optional `id`, `created_at`, `kind`, `metadata`, `is_deleted`.
  - `chat_mentions` Insert: optional `id`.
- `Functions.is_chat_room_member: { Args: { p_chat_room_id: string }; Returns: boolean }`.
- `Enums.chat_message_kind: ChatMessageKind`.
- Add a one-line `// Added for #208` comment, matching the existing per-issue comments.

### 4. MODIFY `supabase/seed-rls-test.sql` and `tests/integration/rls/setup.ts`

These extend the cross-tenant fixture, per `supabase/README.md`: "extend it (and add a Church B seed row) whenever a new table is added". Keep both files in sync. **Do not change any existing seed row or ID.**

- In both truncate/delete lists, add `chat_mentions`, `chat_messages`, `chat_rooms` at the **front** (reverse FK order).
- Add `IDS` groups:
  - `chatRooms: { B: "00000000-0000-4000-8013-000000000001" }`
  - `chatMessages: { B: "00000000-0000-4000-8014-000000000001" }`
  - `chatMentions: { B: "00000000-0000-4000-8015-000000000001" }`
- Seed rows, inserted after users/service_weeks:
  - Room B on `serviceWeeks.B1` / `churches.B`.
  - Message B in room B by `users.memberB`, content `'Church B message'`.
  - Mention B on message B mentioning `users.adminB`.

### 5. MODIFY `tests/integration/rls/tables/cross-tenant-bypass.test.ts`

Add `describe("chat_rooms")`, `describe("chat_messages")` and `describe("chat_mentions")` blocks, copying the existing four-verb shape. The attacker is `memberA`. For `chat_rooms` and `chat_messages`, also add `adminA` variants, as with `setlists`.

- **chat_rooms:**
  - SELECT `{ church_group_id: B }`.
  - INSERT `{ church_group_id: B, service_week_id: B1 }`. A unique-constraint error also counts as denied.
  - UPDATE `IDS.chatRooms.B` `{ is_archived: true }`.
  - DELETE `IDS.chatRooms.B`.
- **chat_messages:**
  - SELECT `{ church_group_id: B }`.
  - INSERT `{ chat_room_id: chatRooms.B, church_group_id: B, user_id: memberA, content: "Evil" }`.
  - UPDATE `{ content: "Hacked" }`.
  - DELETE.
- **chat_mentions:**
  - SELECT `{ id: chatMentions.B }`.
  - INSERT `{ message_id: chatMessages.B, mentioned_user_id: memberB }`.
  - UPDATE `{ mentioned_user_id: memberB }`.
  - DELETE.

Update the header comment's table count. Do **not** edit `phase1-token-bypass.test.ts` (see N3).

### 6. CREATE `tests/integration/rls/tables/chat.test.ts`

Copy the structure of `tests/integration/rls/tables/setlists.test.ts`: the `describeRls` skip gate, `seedViaServiceClient()` in `beforeAll`, and `getUserClient` / `getServiceClient`. In its own `beforeAll`, after seeding, use the service client to create private fixtures with IDs in a dedicated range (prefix `00000000-0000-4000-8016-`). In `afterAll`, delete its service weeks; the cascade removes the rest.

Fixtures:
- Week W1 and week W2 in Church A.
- Room R1 on W1 (`is_archived=false`) and room R2 on W2 (`is_archived=true`).
- Invitations, each with a unique `response_token`:
  - W1: memberA `accepted`, guestA `accepted`, memberA2 `pending`
  - W2: memberA `accepted`, memberA2 `denied`
- Message M1 in R1 by memberA, and message M2 in R2 by memberA (both seeded via the service client).

Required cases (each a separate `it`):
1. SELECT R1 / M1: allowed for memberA (accepted), guestA (accepted guest), leaderA and adminA (no invitation). Blocked for memberA2 (pending), memberB and adminB (other church).
2. SELECT R2 (archived): allowed for memberA. Blocked for memberA2 (denied).
3. INSERT message into R1 as memberA (`user_id = memberA`) is allowed. The same as memberA2 (pending) is denied.
4. INSERT into archived R2 is denied as memberA, and also as leaderA.
5. INSERT impersonation: memberA with `user_id = memberA2` is denied. memberA with `church_group_id = churches.B` is denied.
6. Content CHECK: as memberA into R1, exactly 2000 characters is allowed and 2001 characters errors. Also run the 2001-character insert via the **service client** and assert it errors, which proves the CHECK holds independently of RLS.
7. `kind: "devotion"` with `metadata: { ref: "x" }` is allowed. `kind: "bogus"` errors. When `kind` is omitted, the read-back has `kind === "text"` and `metadata === null`.
8. UPDATE: memberA sets `is_deleted: true` on own M1, and the service-client read-back is `true`. guestA and leaderA updating M1 are no-ops (`assertUpdateNoOp`). memberA updating own M2 in archived R2 is a no-op.
9. DELETE M1 as memberA is a no-op (`assertDeleteNoOp`).
10. Rooms:
    - memberA INSERT a room for a fresh Church A week is denied.
    - leaderA INSERT for a fresh Church A week is allowed.
    - leaderA INSERT with `church_group_id = A` but `service_week_id = B1` is denied.
    - A second room for W1 (service client) errors on the unique constraint.
    - memberA UPDATE R1 `{ is_archived: true }` is a no-op.
    - adminA DELETE R1 is a no-op.
11. Pin: leaderA UPDATE R1 `pinned_message_id = M1` succeeds. leaderA UPDATE R1 `pinned_message_id = M2` (another room's message) is rejected or a no-op, and the read-back still shows M1 or null.
12. Mentions:
    - memberA mentioning memberA2 on M1 is allowed.
    - memberA mentioning memberB (other church) is denied.
    - guestA inserting a mention on memberA's M1 is denied.
    - The duplicate `(M1, memberA2)` errors.
    - memberA mentioning on M2 (archived room) is denied.
    - memberA2 (pending) SELECT on M1's mentions returns zero rows.
13. `rpc("is_chat_room_member", { p_chat_room_id })`:
    - memberA on R1 is `true`.
    - memberA2 on R1 is `false`.
    - memberA on a random nonexistent uuid is exactly `false` (not null).
14. Cascade: with R1 pinning M1 and a mention present, deleting W1 via the service client succeeds, and R1, M1 and the mention are all gone.

Order the tests or re-seed private fixtures so that cases that mutate (8, 11, 14) do not break later ones. The simplest approach is to run 14 last, or give it its own week.

### 7. CREATE `tests/unit/supabase/chat-tables-migration.test.ts`

This is a static check that runs under `bun run test` without secrets. Copy the `readFileSync`/`ROOT` pattern from `tests/unit/documentation/google-oauth-r2-provisioning-tester-supplement.test.ts`. Read the migration file and assert, case-insensitively and tolerant of whitespace:

- It creates the three tables `chat_rooms`, `chat_messages`, `chat_mentions`.
- `chat_rooms.service_week_id` is `unique`.
- `char_length(content) <= 2000` is present.
- `chat_message_kind` has `'text'` and `'devotion'`.
- `metadata jsonb` is present without `not null`.
- RLS is enabled on all three tables.
- `is_chat_room_member` is defined `SECURITY DEFINER` with `search_path = ''` and checks `status = 'accepted'`.
- `is_archived = false` appears in the `chat_messages` INSERT policy.
- No `FOR DELETE` policy exists on any chat table.
- A `-- ============ DOWN ============` marker exists, and every non-blank line after it starts with `--`.
- Also assert that no file under `supabase/migrations/` other than the new one mentions `chat_rooms` outside comments. This proves applied migrations were not edited.

## Edge cases the implementation must handle

- Pending, denied or withdrawn invitee: not a member. A withdrawn invitation revokes access immediately, because RLS is evaluated per query. Their old messages stay visible to others.
- A user with several invitations for the same week is a member if **any** of them is `accepted`.
- Admin/set_leader: a member of every room in their own group with no invitation. Never a member of another group's rooms.
- Guest with an accepted invitation: a member of that week's room only.
- Removed member: their `clerk_id` is overwritten (`remove_church_group_member`), so `auth_user_id()` no longer resolves to them. No extra handling is needed.
- Unauthenticated or unknown room id: the helper returns `false`, never NULL.
- Archived room: SELECT works. Message INSERT, message UPDATE and mention INSERT are refused, for leaders/admins too.
- Leaders/admins can still UPDATE the room row itself (for example to un-archive or change the pin).
- Pin must reference a message in the same room. Hard-deleting the pinned message sets `pinned_message_id` to NULL.
- Deleting a service week cascades through room → messages → mentions even when the room pins one of its own messages (circular FK).
- Content of exactly 2000 characters passes and 2001 fails. Counting is in characters (`char_length`). The JS/Zod `.length` counts UTF-16 units, so the DB check is never stricter than the API.
- `metadata` NULL is the default and valid. `kind` defaults to `'text'`.
- Duplicate room per week and duplicate mention per (message, user) are rejected by unique constraints.

## Verification (coding stage)

- `bun run lint`, `bun run typecheck`, `bun run test` must pass.
- `bun run test:rls` needs `SUPABASE_TEST_URL`, `SUPABASE_TEST_ANON_KEY`, `SUPABASE_TEST_SERVICE_ROLE_KEY` and `SUPABASE_JWT_SECRET`. If they are absent, report every chat RLS case as **NOT RUN**, not as passing. Report N3's pre-existing coverage-pin failure separately from anything this issue introduced.
- If a local Postgres or Supabase is available, apply all migrations in lexicographic order and confirm the new file applies cleanly. If not, say so explicitly in `changes.md`.
- Never use npm/npx/yarn/pnpm.
