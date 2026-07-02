# Spec: Issue #21 — [Sprint 0] Migrate schema — Cluster 6 (Auth & Audit)

## OPEN QUESTIONS

None blocking. Two decisions were made for you (see notes inline); both are
low-risk and reversible. Proceed as specified.

- **Migration filename timestamp.** The `supabase/migrations/` directory is
  currently empty (only `.gitkeep`), so no prior-cluster migration files
  (#7–#11 / #16) exist in this repo yet. Cluster 6 is the *last* cluster, so
  its migration must sort after all others. Use the exact filename given in
  §2. If a real Supabase CLI timestamp convention is later adopted, renaming
  is trivial.
- **FK targets `users` and `church_groups` may not exist in the repo yet.**
  This issue is *blocked by #16* (Cluster 1), which creates those tables. Write
  the FK references as specified; if the migration cannot run because Cluster 1
  is absent, that is expected and out of scope for #21. Do not create `users`
  or `church_groups` here.

---

## 1. Summary

Create ONE new, reversible SQL migration adding two tables from PRD §20.8
(Cluster 6 — Auth & Audit): `google_calendar_tokens` and `audit_logs`.

Scope is **schema only**:
- Tables, columns, PKs, FKs, unique constraints, defaults per PRD §20.8.
- Append-only enforcement on `audit_logs` via `REVOKE UPDATE, DELETE` (BR-13).
- A matching down/rollback migration.

**Out of scope for this issue — do NOT add:**
- RLS policies (that is issue #13; not this issue).
- Encryption/decryption logic (columns store ciphertext only — #61 / audit writer).
- Any TypeScript types, API routes, seed data, or PostgREST config.
- The `users` / `church_groups` tables themselves (from #16).

---

## 2. Files to create

The repo uses plain SQL migrations under `supabase/migrations/` (see
`supabase/README.md`, which states "one migration file per schema cluster").
There is no established up/down file convention yet because the directory is
empty. Follow the Supabase CLI convention: a single `.sql` file whose leading
`YYYYMMDDHHMMSS` timestamp orders it, containing the forward migration, with a
rollback provided as a companion `.down.sql` file so the migration is
demonstrably reversible.

Create BOTH of these files:

1. **`supabase/migrations/20260702000006_cluster6_auth_audit.sql`** — forward migration.
2. **`supabase/migrations/20260702000006_cluster6_auth_audit.down.sql`** — rollback.

(The `000006` suffix reflects Cluster 6 and keeps it ordered last among the six
cluster migrations.)

Do not modify `supabase/config.toml`, `supabase/seed.sql`, or
`supabase/README.md`.

---

## 3. Forward migration — exact contents

Wrap the whole forward migration in a single transaction (`BEGIN; ... COMMIT;`).

### 3.1 `google_calendar_tokens` (PRD §20.8)

One row per user; `user_id` is a UNIQUE FK. Columns store ciphertext produced by
the application layer (AES-256) — the DB just stores text.

| Column | Type | Null | Constraint / Default |
| --- | --- | --- | --- |
| id | uuid | NOT NULL | PK, default `gen_random_uuid()` |
| user_id | uuid | NOT NULL | UNIQUE, FK → `users(id)` ON DELETE CASCADE |
| access_token_encrypted | text | NOT NULL | ciphertext (never logged plaintext) |
| refresh_token_encrypted | text | NOT NULL | ciphertext |
| token_expiry | timestamptz | NOT NULL | |
| calendar_id | varchar(200) | NOT NULL | specific calendar to write to |
| scope | text | NOT NULL | always `calendar.events` (write-only) |
| created_at | timestamptz | NOT NULL | default `now()` |
| updated_at | timestamptz | NOT NULL | default `now()` |

Notes:
- `user_id` UNIQUE enforces the one-token-per-user (1:1) relationship from §20.9.
- No CHECK on `scope` value — PRD documents the intended value but does not
  require a DB constraint; keep it a plain `text` column.

### 3.2 `audit_logs` (PRD §20.8) — append-only (BR-13)

| Column | Type | Null | Constraint / Default |
| --- | --- | --- | --- |
| id | uuid | NOT NULL | PK, default `gen_random_uuid()` |
| church_group_id | uuid | NOT NULL | FK → `church_groups(id)` ON DELETE CASCADE |
| user_id | uuid | NULL | FK → `users(id)` ON DELETE SET NULL — NULL for system-triggered actions |
| action | varchar(100) | NOT NULL | dot-notation, e.g. `invitation.sent`, `role.changed` |
| entity_type | varchar(50) | NOT NULL | |
| entity_id | uuid | NOT NULL | |
| metadata | jsonb | NOT NULL | default `'{}'::jsonb` (e.g. old_value → new_value) |
| created_at | timestamptz | NOT NULL | default `now()`, immutable |

Notes:
- `user_id` is nullable (per §20.8 "Null for system-triggered actions"); use
  `ON DELETE SET NULL` so deleting a user preserves the immutable log row.
- `church_group_id` FK matches the app-wide RLS pattern (every table except
  `church_groups` carries it) but this issue adds NO RLS policy.

### 3.3 Append-only enforcement (BR-13) — required

Immediately after creating `audit_logs`, enforce append-only at the DB layer.
No application role may UPDATE or DELETE audit rows. INSERT and SELECT remain
allowed.

Emit:

```sql
REVOKE UPDATE, DELETE ON TABLE audit_logs FROM PUBLIC;
```

Then, defensively, also revoke from the Supabase-standard application roles so
the grant cannot be inherited:

```sql
REVOKE UPDATE, DELETE ON TABLE audit_logs FROM authenticated, anon;
```

Guard the `authenticated, anon` revoke so the migration does not fail if those
roles are absent in a bare local Postgres (they exist in Supabase). Use a
`DO $$ ... $$` block that checks `pg_roles` for each role, or wrap in
`IF EXISTS`-style role checks. Keep the `FROM PUBLIC` revoke unconditional.

Do NOT revoke SELECT or INSERT.

### 3.4 Suggested indexes (add these)

- Index on `audit_logs(church_group_id, created_at DESC)` — supports the
  audit read endpoint (#29) and RLS scoping.
- `user_id` on `google_calendar_tokens` is already UNIQUE (implicit index).

---

## 4. Rollback migration — exact contents (`.down.sql`)

Must fully reverse §3, in dependency-safe order, wrapped in `BEGIN; ... COMMIT;`:

```sql
DROP TABLE IF EXISTS audit_logs;
DROP TABLE IF EXISTS google_calendar_tokens;
```

Dropping the tables removes their grants/indexes automatically; no separate
`GRANT` restore is needed. Do not drop any enum or the `pgcrypto` extension.

---

## 5. Edge cases the implementation MUST handle

1. **Reversibility.** The `.down.sql` must cleanly drop both tables with no
   leftover objects. Use `DROP TABLE IF EXISTS`.
2. **BR-13 append-only.** After the migration, an UPDATE or DELETE against
   `audit_logs` by an application role (`authenticated`/`anon`/PUBLIC) must be
   denied by Postgres privileges. INSERT and SELECT must still work.
3. **Nullable `user_id` on `audit_logs`.** System-triggered rows insert with
   `user_id = NULL`; the FK must permit this and use `ON DELETE SET NULL`.
4. **`gen_random_uuid()` availability.** It requires the `pgcrypto` extension.
   Add `CREATE EXTENSION IF NOT EXISTS pgcrypto;` at the top of the forward
   migration (idempotent; harmless if an earlier cluster already created it).
5. **Missing Supabase roles locally.** The `authenticated`/`anon` revoke must
   not hard-fail on a plain Postgres instance that lacks those roles (see §3.3).
6. **Re-run safety is NOT required** for `CREATE TABLE` (a migration runs once),
   but keep `CREATE EXTENSION IF NOT EXISTS` and the role-guarded revokes so a
   partial local run can be cleaned up and retried.

---

## 6. Patterns to follow

- **Column types / nullability / defaults:** copy exactly from
  `documentation/prd/graceful_requirements_v10.md` §20.8 (lines 1025–1050).
  All PKs are `uuid`, all timestamps `timestamptz` (PRD §20 intro, line 700).
- **`church_group_id` FK convention:** every table except `church_groups`
  carries it (PRD §20 intro / §14 line 622). `audit_logs` follows this.
- **BR-13 immutability:** PRD line 190 and §20.8 line 1040.
- **Minimal OAuth scope / ciphertext-only columns:** PRD §25.5 (line 1422) and
  the issue's Implementation Notes — do not add encryption logic here.

There is no existing migration file to copy structural style from (directory is
empty). Use standard Postgres DDL as described above.

---

## 7. Acceptance-criteria mapping

- AC1 `google_calendar_tokens` created → §3.1.
- AC2 `audit_logs` created → §3.2.
- AC3 No UPDATE/DELETE grant on `audit_logs` (BR-13) → §3.3.
- AC4 Migration is reversible → §2 (companion `.down.sql`) + §4.
