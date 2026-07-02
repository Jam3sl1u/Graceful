# Spec: Issue #21 — [Sprint 0] Migrate schema — Cluster 6 (Auth & Audit)

## OPEN QUESTIONS

1. **Dependency #16 (Cluster 1: `users`, `church_groups`) is not yet in the
   repo.** `supabase/migrations/` contains only `.gitkeep` — there are zero
   migration files, so the `users` and `church_groups` tables this migration's
   foreign keys reference **do not exist yet**. The migration as written below
   will NOT apply cleanly against the current database until Cluster 1 lands.
   This is the issue's own declared "Blocked by #16."
   **Decision needed:** proceed and land the migration file now (it becomes
   valid once #16 merges, and its timestamp must sort *after* Cluster 1's), OR
   wait for #16. This spec assumes **proceed and author the file now** — write
   the SQL correctly against the documented `users(id)` / `church_groups(id)`
   shape so it applies the moment Cluster 1 exists. The Coder should NOT stub
   out `users`/`church_groups` themselves (that is #16's scope) and should NOT
   drop the FKs to work around the missing tables.

2. **DB application role name.** BR-13 requires "no UPDATE/DELETE grant on
   `audit_logs` for any application role." Issue #14 governs the service-role /
   PostgREST posture but no concrete non-superuser application role has been
   defined in any migration yet. This spec enforces append-only in a
   role-agnostic, forward-safe way (see §4.3): a `BEFORE UPDATE OR DELETE`
   trigger that raises an exception, plus a `REVOKE` targeting the standard
   Supabase roles. If a different app role name is later chosen, the trigger
   still holds the line. Confirm no dedicated app role exists that needs an
   explicit `REVOKE`; if one does, add it to the list in §4.3.

---

## 1. Summary

Add the **first ever migration files** to this repo for Cluster 6: two tables,
`google_calendar_tokens` and `audit_logs`. Scope is **schema only**.

Hard scope boundaries pulled from the backlog and this issue:
- **RLS policies are OUT of scope** — they are issue #13 ("RLS policies on every
  Phase 1 table"). Do NOT add `CREATE POLICY` / `ALTER TABLE ... ENABLE ROW
  LEVEL SECURITY` for `church_group_id` scoping here. (The only DB-layer
  enforcement in *this* issue is the `audit_logs` append-only constraint, which
  is a distinct requirement — BR-13 — not an RLS policy.)
- **Encryption/decryption is OUT of scope** — issues #61 and #29. The
  `*_encrypted` columns are plain `text` that store ciphertext; the DB does no
  crypto.
- **Cluster 1 tables (`users`, `church_groups`) are OUT of scope** — issue #16.

The migration must be **reversible** (a `down` counterpart).

---

## 2. Verified current repo state (do not redo)

- `supabase/migrations/` is **empty** except `.gitkeep`. This is the first
  migration. There is no existing SQL file to copy a style from.
- `supabase/config.toml` is a **placeholder** (`project_id = "graceful"` only);
  Supabase CLI has not been `init`ed. Do NOT run `supabase init` or rewrite
  config.toml — out of scope.
- `supabase/seed.sql` is a placeholder comment — do NOT touch.
- No DB roles, no enums, no prior tables are defined in-repo.
- Data model source of truth: `documentation/prd/graceful_requirements_v10.md`
  §20.8 (lines 1025–1050). BR-13 is at line 190. The dot-notation `action`
  requirement is line 1047.

---

## 3. Files to create

Because no migration exists yet and there is no established file convention in
this repo, follow the **Supabase timestamped migration convention** (Supabase
applies files in `supabase/migrations/` in lexical filename order). Create a
paired up/down using the `.up.sql` / `.down.sql` suffix so "reversible" is
explicit and self-documenting.

Use a timestamp that sorts **after** any Cluster 1–5 migrations (which will use
lower/earlier timestamps once authored). Cluster 6 is the last cluster (#12 in
the backlog), so a late timestamp is correct. Use format
`YYYYMMDDHHMMSS_<slug>`.

Create exactly these two files:

- `/Users/jamesliu/Documents/Graceful/supabase/migrations/20260702000012_cluster6_auth_audit.up.sql`
- `/Users/jamesliu/Documents/Graceful/supabase/migrations/20260702000012_cluster6_auth_audit.down.sql`

(The `000012` mirrors the backlog cluster number to keep intent obvious. If the
Coder finds a Cluster 1–5 migration already present with a conflicting or later
timestamp, bump this one so it still sorts last — but keep the `.up`/`.down`
pairing and the slug.)

Do NOT modify `config.toml`, `seed.sql`, `README.md`, or `.gitkeep`.

---

## 4. `up` migration contents

Wrap the whole thing conceptually as idempotent-friendly DDL. Use
`gen_random_uuid()` for PK defaults (built into Postgres 13+ / Supabase; no
`uuid-ossp` extension needed — do NOT add `CREATE EXTENSION`).

### 4.1 `google_calendar_tokens`

Per PRD §20.8 (lines 1029–1038). One-to-one with `users` (line 1055), so
`user_id` is **UNIQUE**.

Columns and constraints:
- `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`
- `user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE`
- `access_token_encrypted text NOT NULL` — ciphertext only; never plaintext.
- `refresh_token_encrypted text NOT NULL`
- `token_expiry timestamptz NOT NULL`
- `calendar_id varchar(200) NOT NULL`
- `scope text NOT NULL` — default expectation is `calendar.events` per PRD, but
  do NOT hardcode a DB default (app supplies it). No enum.
- `created_at timestamptz NOT NULL DEFAULT now()`
- `updated_at timestamptz NOT NULL DEFAULT now()`

Notes:
- `ON DELETE CASCADE` on `user_id`: when a user is deleted their stored OAuth
  credential must not linger (security). This is the correct FK behavior for a
  1:1 owned credential record.
- Add an index on `user_id`? The UNIQUE constraint already creates one — do NOT
  add a redundant index.
- `updated_at`: this table is mutable (tokens refresh), so keep an
  `updated_at`. See §4.4 for the shared touch trigger.

### 4.2 `audit_logs`

Per PRD §20.8 (lines 1042–1050). Append-only (BR-13).

Columns and constraints:
- `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`
- `church_group_id uuid NOT NULL REFERENCES church_groups(id) ON DELETE CASCADE`
- `user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL` — **nullable**
  (system-triggered actions have no user, line 1046). On user deletion, keep the
  audit row but null the actor (the trail must survive; do NOT cascade-delete
  audit history).
- `action varchar(100) NOT NULL` — dot-notation strings (`invitation.sent`,
  `role.changed`, `setlist.published`). No enum, no CHECK constraint on format
  (the vocabulary is open and owned by the app layer / issue #29). Do NOT invent
  a fixed enum.
- `entity_type varchar(50) NULL`
- `entity_id uuid NULL`
- `metadata jsonb NULL` — arbitrary structured detail (e.g.
  `{"old_value": "member", "new_value": "set_leader"}`).
- `created_at timestamptz NOT NULL DEFAULT now()` — immutable.

Notes:
- **No `updated_at`** on `audit_logs` — the row is immutable by definition, an
  update column would be a contradiction.
- Add an index to support the future read endpoint (#20/#29) which is
  church-group-scoped and time-ordered:
  `CREATE INDEX ON audit_logs (church_group_id, created_at DESC);`
  Do not add other indexes speculatively.

### 4.3 Append-only enforcement for `audit_logs` (BR-13) — REQUIRED

This is an explicit acceptance criterion and the one piece of DB-layer
enforcement in this issue. Implement **both** layers so it holds regardless of
which role or key touches the table:

1. **REVOKE grants** for UPDATE and DELETE from the standard Supabase roles:
   ```sql
   REVOKE UPDATE, DELETE ON TABLE audit_logs FROM anon, authenticated;
   ```
   If the Coder confirms (per OPEN QUESTION 2) a dedicated application DB role
   exists, add it to this REVOKE list. Do NOT revoke from `postgres` /
   superuser (that would block the migration's own down-script and legitimate
   admin ops) — the trigger below is what stops even a privileged accidental
   mutation.

2. **Guard trigger** — a `BEFORE UPDATE OR DELETE` trigger that raises an
   exception, so append-only is enforced even against roles that bypass grants
   (e.g. the service role, which ignores table GRANTs):
   ```sql
   CREATE OR REPLACE FUNCTION audit_logs_block_mutation()
   RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     RAISE EXCEPTION 'audit_logs is append-only (BR-13): % not permitted', TG_OP;
   END;
   $$;

   CREATE TRIGGER audit_logs_no_update_delete
     BEFORE UPDATE OR DELETE ON audit_logs
     FOR EACH ROW EXECUTE FUNCTION audit_logs_block_mutation();
   ```
   INSERT and SELECT remain allowed (append + read). TRUNCATE is a separate
   statement-level operation; optionally also add a
   `BEFORE TRUNCATE ... FOR EACH STATEMENT` trigger calling the same function to
   fully seal the table. Include it — it's cheap and closes the obvious hole.

### 4.4 `updated_at` touch trigger (for `google_calendar_tokens`)

`google_calendar_tokens` needs `updated_at` maintained on UPDATE. Since this is
the first migration, define the shared helper here (later clusters can reuse
it — do NOT assume it already exists):
```sql
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER google_calendar_tokens_set_updated_at
  BEFORE UPDATE ON google_calendar_tokens
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```
Use `CREATE OR REPLACE FUNCTION` for `set_updated_at` so a future Cluster
migration re-declaring it is harmless. If the Coder discovers this helper is
already defined by an earlier-applied migration, keep the `CREATE OR REPLACE`
(idempotent) but you may drop the redundant declaration — either is fine.

---

## 5. `down` migration contents (reversibility — REQUIRED)

Drop in reverse dependency order. The down script must fully reverse the up
script and leave no orphaned functions/triggers **that this migration
introduced**. Exact teardown:

```sql
DROP TRIGGER IF EXISTS audit_logs_no_update_delete ON audit_logs;
DROP TRIGGER IF EXISTS audit_logs_no_truncate ON audit_logs;   -- if the TRUNCATE guard was added
DROP TRIGGER IF EXISTS google_calendar_tokens_set_updated_at ON google_calendar_tokens;

DROP TABLE IF EXISTS audit_logs;
DROP TABLE IF EXISTS google_calendar_tokens;

DROP FUNCTION IF EXISTS audit_logs_block_mutation();
-- Only drop set_updated_at() here if THIS migration created it and no earlier
-- migration owns it. Since Cluster 6 is currently the ONLY migration, drop it.
-- If a Cluster 1–5 migration already defines set_updated_at(), do NOT drop it
-- in this down script (leave it for whichever migration owns it).
DROP FUNCTION IF EXISTS set_updated_at();
```

Guidance: because the guard trigger blocks DELETE but `DROP TABLE` is DDL (not a
row DELETE), `DROP TABLE` is unaffected by the trigger — the down script works.

---

## 6. Edge cases the implementation must handle

- **Missing FK targets today.** As noted in OPEN QUESTION 1, `users` /
  `church_groups` don't exist in-repo yet. Write the FKs correctly; do not stub
  the referenced tables. The migration is expected to apply only after Cluster 1.
- **Service role bypasses GRANTs.** The REVOKE alone does not stop the Supabase
  service role — that's exactly why the guard trigger (§4.3) is mandatory, not
  optional.
- **System-triggered audit rows.** `audit_logs.user_id` must be nullable and
  insertable as NULL. Do not add a NOT NULL or a CHECK that forbids null.
- **User deletion divergence:** `google_calendar_tokens` cascades on user delete
  (credential must die with the user); `audit_logs` does NOT cascade — it nulls
  `user_id` (trail must survive). Do not make these behave the same.
- **`action` format is open.** No enum/CHECK — future actions must not require a
  schema migration to add.
- **Idempotent function declarations** via `CREATE OR REPLACE` so later clusters
  redeclaring `set_updated_at()` don't error.

---

## 7. Out of scope (do NOT do)

- No RLS policies / `ENABLE ROW LEVEL SECURITY` / `church_group_id` scoping —
  that's issue #13.
- No encryption/decryption logic, no crypto extensions — issues #61 / #29.
- No `users` / `church_groups` table definitions — issue #16.
- No `supabase init`, no `config.toml` rewrite, no `seed.sql` edits.
- No application/TypeScript code, no query helpers, no types. Schema only.
- No CHECK constraint on `scope` or `action` values.

---

## 8. Verification the Coder should be able to describe

Since Cluster 1 is absent, a live `up` apply may fail on the FK targets — that
is expected and is the #16 dependency, not a defect in this file. The Coder
should ensure:
1. The two files exist at the paths in §3 with valid, self-consistent SQL.
2. `down` exactly reverses `up` (tables, triggers, functions created here are
   all dropped; nothing this migration didn't create is dropped, per the
   `set_updated_at` caveat).
3. `audit_logs` has: nullable `user_id`, `metadata jsonb`, the
   `(church_group_id, created_at DESC)` index, the append-only trigger, and the
   UPDATE/DELETE REVOKE.
4. `google_calendar_tokens` has: UNIQUE `user_id`, both `*_encrypted text NOT
   NULL` columns, and the `updated_at` touch trigger.
