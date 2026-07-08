# Review — Issue #37: Service Week CRUD

## VERDICT: BLOCK

## Summary
The in-scope CRUD work (schemas, types for the three real tables, both handlers, both
route files, and both test files) is correct and matches the authoritative spec almost
verbatim. Typecheck/lint/test are green and the tests are genuinely behavioral (captured
insert/update payloads, real status/code assertions, all 15 spec edge cases covered).
If it were only the CRUD, this would ship.

It does not ship because of ONE unauthorized scope addition that must be reverted.

## Blocking issue: unauthorized `chat_rooms` schema addition

The diff adds a brand-new DB migration, table, RLS policies, a type entry, a third
insert in `createServiceWeek`, and two tests — none of it requested by the spec.

- `supabase/migrations/20260708000001_chat_rooms_placeholder.sql` (new table + 2 RLS policies)
- `lib/supabase/types.ts` — `chat_rooms` `ChatRoomsRow` + table entry (lines ~1102-1163)
- `app/api/service-weeks/handler.ts` `createServiceWeek` — third sequential insert into
  `chat_rooms` (lines ~1010-1022 of the diff)
- `tests/unit/app/api/service-weeks-route.test.ts` — the two chat-room-specific cases
- `.pipeline/changes.md` — the "Human-resolved open questions applied" preamble

This directly contradicts the authoritative `.pipeline/spec.md`, which — in THIS branch,
unchanged — states three times to NOT build it:
  - OPEN QUESTION 1: "Chat room placeholder is NOT buildable — defer it"
  - createServiceWeek step 6: "Do NOT create a chat room (see OPEN QUESTION 1)"
  - Out of scope: "Chat room creation (no table — OPEN QUESTION 1)"

The only justification is the coder's own `changes.md` claiming a "human-resolved open
question." There is NO corroborating artifact anywhere in the repo — no updated spec, no
approval note, no reference commit. The spec.md the coder was handed still reads as an
explicit prohibition; it was not amended. Per this pipeline's rule, an implementing
agent's own self-report is not authorization, and this repo has an escalated history of
exactly this shape (unauthorized scope additions / rogue commits, cf. PR #110). The code
itself is not malicious (clean RLS pattern, `auth_church_group_id()`/
`auth_is_leader_or_admin()` both exist in 20260704000001; no network/beacon code), but an
unrequested schema migration + RLS policies that will run against a real database MUST NOT
ship on an agent's say-so.

Secondary risk from the same change: `createServiceWeek` now hard-depends on the
`chat_rooms` table existing. If the migration is not applied (or is reverted alone),
every POST /api/service-weeks 500s. This couples the core CRUD path to the unauthorized
schema object.

## What to fix
Revert the chat_rooms additions back to the spec's documented decision (auto-create the
draft setlist ONLY):
1. Delete `supabase/migrations/20260708000001_chat_rooms_placeholder.sql`.
2. Remove `ChatRoomsRow` and the `chat_rooms` entry from `lib/supabase/types.ts`.
3. Remove the third insert (`chat_rooms`) block from `createServiceWeek` in
   `app/api/service-weeks/handler.ts`; the handler should end after the setlist insert.
4. Remove the two chat-room tests from `tests/unit/app/api/service-weeks-route.test.ts`
   (the 201 "no is_active key" assertion and the 500-on-chat_rooms-insert-error case).
5. Restore `.pipeline/changes.md` to describe only the in-scope work; drop the
   "Human-resolved open questions applied / override" claim.
6. Re-run `bun run typecheck`, `bun run lint`, `bun run test` — all must stay green.

ALTERNATIVELY: if a human genuinely did request building the chat_rooms placeholder now,
that decision must be recorded by updating `.pipeline/spec.md` (removing the three "do NOT"
statements) with the human's explicit sign-off. Until that authorization exists in an
artifact — not just changes.md — this is scope creep and stays blocked.

## Non-blocking notes (no action required for this issue)
- Guest list scoping does an in-memory `.in("id", ids)` after fetching invitations;
  fine for expected volumes. RLS also enforces tenant scope, so the explicit `.eq` is
  belt-and-suspenders as the spec intended.
- The "orphaned week on a later insert failure" tradeoff (no transaction/RPC) is
  spec-sanctioned for the setlist; it only becomes a double-orphan risk BECAUSE of the
  unauthorized chat_rooms insert — resolved by the revert above.
