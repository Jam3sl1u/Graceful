# Spec: Issue #20 — [Sprint 0] Migrate schema — Cluster 5 partial (availability, notification_preferences, notifications)

## OPEN QUESTIONS

None that block implementation. One PRD gap is resolved below with a concrete,
PRD-derived decision the Coder should follow as-is:

- **`notification_type` enum is referenced but never defined in the PRD.**
  `notifications.type` is typed `notification_type` (PRD §20.7), but that enum is
  NOT in the 9-enum list (§20.2) — it is a 10th, undefined enum. Rather than block
  the pipeline, this migration **creates a `notification_type` enum** with values
  derived directly from the notification catalog in PRD §14. See section 3.2 for the
  exact value list. If a human later disagrees with the value set, only the enum
  definition changes — the table structure is unaffected.

Everything else is fully specified by PRD §20.2 and §20.7.

---

## 1. Summary

Create **one new, reversible migration** adding the Phase-1 subset of Cluster 5:
the `availability`, `notification_preferences`, and `notifications` tables, plus the
enums those tables require. The `supabase/migrations/` directory is currently empty
(only `.gitkeep`) — there are **no prior migrations to copy from and no existing
enums/tables in the repo**. This migration is written to be self-contained and idempotent-safe on its own enum creation, but it **assumes the referenced tables
`church_groups` and `users` already exist** (created by the blocking issue #16 /
Cluster 1 migration).

Scope is strictly the three tables above and only the enums they need. Do NOT create
`chat_rooms`, `chat_messages`, or `chat_mentions` (Phase 2, explicitly out of scope).

---

## 2. Verified current repo state (do not redo this investigation)

- `supabase/migrations/` contains only `.gitkeep` — **no migrations exist yet**.
- `supabase/seed.sql` is a placeholder comment only.
- `supabase/config.toml` is a minimal placeholder (`project_id = "graceful"`).
- No SQL enum or table definitions exist anywhere in the repo.
- Cluster 1 (`church_groups`, `users`, `member_profiles`) is issue #16 and is the
  declared blocker. Its migration is NOT present in this checkout. FKs in this
  migration reference `church_groups(id)` and `users(id)` and will fail to apply if
  #16 has not run first — that ordering is expected and acceptable (the up/down
  migration itself must still be internally correct and reversible).

Conventions to adopt (there is no in-repo precedent, so establish these cleanly):
- Supabase-style timestamped filename, plain SQL, UUID v4 PKs, `timestamptz` for all
  timestamps, `church_group_id` FK for RLS-scopability (matches PRD §20 preamble).
- RLS policies are **out of scope** for this issue — they are issue #13. Do NOT add
  `ENABLE ROW LEVEL SECURITY` or policies here.

---

## 3. Files to create

### 3.1 CREATE the migration file

Path (use exactly this name):
`/Users/jamesliu/Documents/Graceful/supabase/migrations/0005_cluster5_partial.sql`

Rationale for `0005`: Cluster 5 is sprint-backlog item after Clusters 1–4. A
zero-padded ordinal prefix keeps lexical = apply order. If the team's tooling
requires the `<timestamp>_name.sql` Supabase convention instead, the Coder may use a
UTC timestamp prefix (e.g. `20260702000000_cluster5_partial.sql`) — pick ONE and be
consistent; the ordinal form above is preferred for readability. The `.gitkeep` file
may remain.

The file must contain, in order: an **Up** section (enums → tables → indexes) and a
**Down** section that fully reverses it. Because Supabase applies raw SQL forward
only, put the reverse SQL in a clearly delimited `-- ==== DOWN ====` comment block AND
also ensure the forward SQL is written so it can be cleanly reversed. Concretely:

- Provide the reverse statements as an executable trailing block guarded by comment
  markers `-- migrate:down` … end-of-file, and the forward block under
  `-- migrate:up`. (This dbmate/`supabase`-compatible convention makes the migration
  reversible per the acceptance criterion.)

If the Coder confirms the repo uses the Supabase CLI's own up-only convention with a
paired `..._down.sql` is NOT in use (it is not — nothing exists), the single-file
`-- migrate:up` / `-- migrate:down` split is the required format.

### 3.2 Enums to create (Up)

Create only the enums the three in-scope tables use. Guard each with existence checks
so re-running against a DB where Cluster 1 already created an overlapping enum does
not error. Use this pattern for every enum:

```sql
DO $$ BEGIN
  CREATE TYPE chat_pref AS ENUM ('all', 'mentions');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
```

Enums required by THIS migration:

1. **`chat_pref`** — values `('all', 'mentions')`. (PRD §20.2.) Used by
   `notification_preferences.chat_preference`, default `'mentions'`.
   Created here per the issue's implementation note even though chat ships Phase 2.

2. **`notification_type`** — RESOLVED per OPEN QUESTIONS. Create with exactly these
   values, derived from PRD §14's notification catalog:
   ```
   ('set_invitation',
    'invitation_reminder',
    'invitation_accepted',
    'invitation_denied',
    'practice_reminder',
    'setlist_released',
    'scheduling_conflict',
    'chat_mention',
    'devotion_shared',
    'new_church_document',
    'google_calendar_event')
   ```
   Use snake_case values matching the rows in §14 (in listed order).

Do NOT create `vocal_capability` here. The Phase-1 sprint backlog line for this item
mentions it, but `vocal_capability` belongs to `member_profiles` (Cluster 1, PRD
§20.3) and is **out of scope for the three tables in this issue's acceptance
criteria**. None of `availability`, `notification_preferences`, or `notifications`
uses it. Creating it here would duplicate Cluster 1's enum. Skip it.

### 3.3 Table: `availability`

Per PRD §20.5 (the canonical column definition; the issue lists a subset). Columns:

| Column | Type | Constraints |
| --- | --- | --- |
| `id` | uuid | PK, default `gen_random_uuid()` |
| `user_id` | uuid | NOT NULL, FK → `users(id)` ON DELETE CASCADE |
| `church_group_id` | uuid | NOT NULL, FK → `church_groups(id)` ON DELETE CASCADE |
| `date` | date | NOT NULL |
| `is_available` | boolean | NOT NULL, default `true` |
| `note` | text | NULL |
| `created_at` | timestamptz | NOT NULL, default `now()` |

Constraints / indexes:
- **UNIQUE `(user_id, date)`** — PRD §20.5 states "One per user per calendar date".
  This is required so upsert-by-date works (API `PUT /api/availability`, issue #34).
- Index on `(church_group_id, date)` — supports the team availability grid query
  (`GET /api/availability/team`, PRD §19).

### 3.4 Table: `notification_preferences`

Per PRD §20.7. One row per user. Columns:

| Column | Type | Constraints |
| --- | --- | --- |
| `id` | uuid | PK, default `gen_random_uuid()` |
| `user_id` | uuid | NOT NULL, **UNIQUE**, FK → `users(id)` ON DELETE CASCADE |
| `invitation_sms` | boolean | NOT NULL, default `true` |
| `invitation_email` | boolean | NOT NULL, default `true` |
| `invitation_inapp` | boolean | NOT NULL, default `true` |
| `reminder_sms` | boolean | NOT NULL, default `true` |
| `reminder_email` | boolean | NOT NULL, default `false` |
| `reminder_hours_before` | integer | NOT NULL, default `24` |
| `setlist_sms` | boolean | NOT NULL, default `true` |
| `setlist_email` | boolean | NOT NULL, default `true` |
| `chat_preference` | chat_pref | NOT NULL, default `'mentions'` |
| `gcal_sync_enabled` | boolean | NOT NULL, default `false` |

Notes:
- `reminder_email` default is **`false`** (PRD §20.7: "Defaults true / false" for
  `reminder_sms / reminder_email`). Do not flip these.
- **Do NOT** encode BR-14 ("at least one invitation channel must stay active") as a DB
  CHECK constraint. BR-14 is enforced at the API layer (PRD §19, `PUT
  /api/notifications/preferences` "Rejects disabling all 3 invitation channels").
  Adding it as a DB constraint is out of scope and not requested by this issue.

### 3.5 Table: `notifications`

Per PRD §20.7. The always-on in-app inbox. Columns:

| Column | Type | Constraints |
| --- | --- | --- |
| `id` | uuid | PK, default `gen_random_uuid()` |
| `church_group_id` | uuid | NOT NULL, FK → `church_groups(id)` ON DELETE CASCADE |
| `user_id` | uuid | NOT NULL, FK → `users(id)` ON DELETE CASCADE |
| `type` | notification_type | NOT NULL |
| `title` | varchar(200) | NOT NULL |
| `body` | text | NULL |
| `link_entity_type` | varchar(50) | NULL |
| `link_entity_id` | uuid | NULL |
| `is_read` | boolean | NOT NULL, default `false` |
| `created_at` | timestamptz | NOT NULL, default `now()` |

Indexes:
- Index on `(user_id, is_read)` — powers the unread-count badge
  (`GET /api/notifications/unread-count`) and the inbox list filtered by read state.
- Index on `(user_id, created_at DESC)` — powers the paginated inbox feed
  (`GET /api/notifications`, newest first).

`link_entity_type` / `link_entity_id` are a loose (non-FK) polymorphic deep-link
pair (e.g. `'invitation'` + that invitation's id). Do NOT add a foreign key on
`link_entity_id` — it is intentionally polymorphic.

---

## 4. Reversibility (acceptance criterion "Migration is reversible")

The `-- migrate:down` block must drop objects in reverse dependency order:

1. `DROP TABLE IF EXISTS notifications;`
2. `DROP TABLE IF EXISTS notification_preferences;`
3. `DROP TABLE IF EXISTS availability;`
4. `DROP TYPE IF EXISTS notification_type;`
5. `DROP TYPE IF EXISTS chat_pref;`

Indexes drop automatically with their tables — no separate DROP INDEX needed.
Do NOT drop `users` or `church_groups` in the down migration (owned by #16).

Edge case: because `chat_pref` and `notification_type` are created with
`DO $$ … duplicate_object … $$` guards, the down migration's `DROP TYPE IF EXISTS`
is safe even if another migration also references the type — but note that if a
future Cluster 5 Phase-2 migration reuses `chat_pref`, dropping it here on rollback is
correct for THIS migration's own scope. That is acceptable for Sprint 0.

---

## 5. Edge cases the implementation must handle

- **Apply order dependency:** FKs reference `users` and `church_groups`. If #16 has
  not been applied, `CREATE TABLE` will fail with a missing-relation error. This is
  expected; do not add `IF NOT EXISTS` fallbacks that would silently mask a missing
  Cluster 1. The migration is correct; the environment ordering is the caller's job.
- **Enum re-creation:** the `DO $$ … EXCEPTION WHEN duplicate_object $$` guard must
  wrap every `CREATE TYPE` so applying alongside/after another migration that already
  defined the same enum does not abort.
- **`gen_random_uuid()`** requires the `pgcrypto` extension (built into Supabase/
  Postgres 13+; available by default on Supabase). Do NOT add
  `CREATE EXTENSION` here unless the Coder confirms it is missing — Supabase enables
  it. If a truly clean local Postgres is targeted, prefer `gen_random_uuid()` over
  `uuid_generate_v4()` (no extension needed on PG13+).
- **One-row-per-user tables:** the UNIQUE constraint on
  `notification_preferences.user_id` and on `availability (user_id, date)` are the
  only uniqueness guarantees required. Do not add others.
- **`note` and `body` are nullable** — do not make them NOT NULL.

---

## 6. Out of scope (do NOT do)

- No `chat_rooms`, `chat_messages`, `chat_mentions` (Phase 2).
- No RLS policies or `ENABLE ROW LEVEL SECURITY` (issue #13).
- No seed data (`seed.sql` stays as-is).
- No API routes, no TypeScript types, no Zod schemas — schema migration only.
- No `vocal_capability` enum (Cluster 1 / #16 owns it).
- No BR-14 CHECK constraint (API-layer concern).
- No changes to `supabase/config.toml` or `supabase/README.md`.

---

## 7. Verification

- `supabase/migrations/0005_cluster5_partial.sql` exists with a `-- migrate:up` and a
  `-- migrate:down` section.
- Up section creates exactly: enums `chat_pref`, `notification_type`; tables
  `availability`, `notification_preferences`, `notifications`; the indexes in §3.
- Down section drops exactly those objects in reverse order and nothing else.
- Every column, default, nullability, and unique constraint matches §3.3–3.5.
- No table, enum, or policy outside this issue's scope is present.
