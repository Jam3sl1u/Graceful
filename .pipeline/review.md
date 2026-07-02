# Review: Issue #20 — [Sprint 0] Migrate schema — Cluster 5 partial

VERDICT: SHIP

## What was verified (independently, not trusted from prior summaries)

Ran `git diff main...HEAD` firsthand. The change set is exactly one new file,
`supabase/migrations/0005_cluster5_partial.sql` (94 lines), and nothing else in
the code tree. The only other modified files are the expected `.pipeline/*`
pipeline artifacts. Confirmed the on-disk file matches HEAD (`git diff HEAD` on
the migration is empty) and that the file is present in this worktree checkout.

## Column-by-column check against the PRD source of truth

Verified against `documentation/prd/graceful_requirements_v10.md` directly, not
just against spec.md:

- **availability** (PRD §20.5, line 792): id/user_id/church_group_id/date/
  is_available(default true)/note(nullable)/created_at — all match. Migration
  adds the required UNIQUE(user_id, date) ("one per user per calendar date") and
  index on (church_group_id, date). Correct.
- **notification_preferences** (PRD §20.7, lines 998-1009): every column,
  default, and nullability matches exactly — including the easy-to-flip
  `reminder_email` default `false` (all other booleans `true`),
  `reminder_hours_before` default 24, `chat_preference chat_pref` default
  `'mentions'`, `gcal_sync_enabled` default false, and UNIQUE on user_id.
- **notifications** (PRD §20.7, lines 1011-1023): all columns match, including
  `title varchar(200)`, nullable `body`, the polymorphic
  `link_entity_type varchar(50)` / `link_entity_id uuid` pair with NO FK on
  link_entity_id (intentional, correct). Both required indexes present:
  (user_id, is_read) and (user_id, created_at DESC).
- **chat_pref** enum: values ('all','mentions') match PRD §20.2 (line 727).

## Enum resolution — reviewed and accepted

`notification_type` is genuinely absent from PRD §20.2's 9-enum list (confirmed
firsthand). The spec resolved this documented gap by defining an 11-value enum
here. The literal values do not appear verbatim in the PRD, so they are a
reasonable synthesis of the app's notification-generating events — but the blast
radius is isolated: if a human disagrees, only the enum definition changes, not
the table structure. Acceptable for Sprint 0 and correctly flagged in the spec's
OPEN QUESTIONS.

## Reversibility & guards

- `-- migrate:up` / `-- migrate:down` single-file split matches the chosen
  convention (no prior migrations exist to conflict with).
- Down block drops in correct reverse-dependency order: notifications →
  notification_preferences → availability → notification_type → chat_pref, with
  IF EXISTS guards. Does not touch users/church_groups (owned by #16). Correct.
- Both CREATE TYPE statements are wrapped in
  `DO $$ ... EXCEPTION WHEN duplicate_object $$` guards; tables are deliberately
  NOT guarded with IF NOT EXISTS, so a missing Cluster 1 (#16) hard-fails rather
  than silently masking — matches spec §5 intent.

## Out-of-scope confirmation

No chat_rooms/chat_messages/chat_mentions (Phase 2), no RLS / ENABLE ROW LEVEL
SECURITY (issue #13), no vocal_capability enum (Cluster 1 / #16), no BR-14 CHECK
constraint (API layer), no seed data, no config.toml changes. The out-of-scope
names appear only in the header comment noting they are excluded.

## Critical assessment

The tester's verification was appropriately SQL-level (there is no JS/TS behavior
to unit-test) and included the right checks: a real Postgres round-trip up/down,
idempotency of the down block, the enum duplicate_object guard, and the
intentional missing-relation failure case. I re-derived the substantive claims
against the PRD rather than trusting the summaries; every material assertion
holds. No security, performance, or correctness concerns.

Note for the caller: this migration cannot apply until issue #16 (Cluster 1)
creates users/church_groups — that is expected ordering, not a defect in this
migration. Ship it.
