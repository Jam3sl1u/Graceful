# supabase/

PostgreSQL schema for Graceful Phase 1. Migrations are applied in **lexicographic order** by the `YYYYMMDDHHMMSS_` filename prefix (`supabase db push` or Dashboard SQL editor).

## Migrations

| File | Issue | Contents |
| ---- | ----- | -------- |
| `20260702000001_cluster_1_organization.sql` | #16 | `church_groups`, `users`, `member_profiles`; `user_role`, `vocal_capability` enums |
| `20260702000002_cluster_2_instruments.sql` | #17 | `instruments`, `member_instruments` |
| `20260702000003_cluster_3_scheduling_core.sql` | #18 | `service_weeks`, `setlists`, `setlist_songs`, `events`, `invitations`, `event_attendees`, `conflicts`; `invitation_status`, `event_type`, `resolution_type`, `setlist_status` enums |
| `20260702000004_cluster_4_partial_songs.sql` | #19 | `songs`, `song_documents` (partial Cluster 4 — `documents` and `transcription_jobs` are Phase 2/3) |
| `20260702000005_cluster_5_partial.sql` | #20 | `availability`, `notification_preferences`, `notifications`; `chat_pref`, `notification_type` enums (partial Cluster 5 — chat tables are Phase 2) |
| `20260702000006_cluster6_auth_audit.sql` | #12 | `google_calendar_tokens`, `audit_logs` (append-only; `REVOKE UPDATE, DELETE` on `audit_logs`) |
| `20260703000001_users_self_read_rls.sql` | #15 (bootstrap slice of #22) | Enables RLS on `users`; `users_select_own` policy (`clerk_id = jwt sub`) — superseded by #22 |
| `20260704000001_rls_policies.sql` | #22 | Auth helper functions (`auth_church_group_id`, `auth_user_role`, `auth_user_id`, `auth_is_leader_or_admin`); RLS enabled on all 18 tables (excl. `church_groups`); full tiered policies |

Each migration file (except Cluster 6's companion down file) contains an `-- ============ UP ============` block applied by `supabase db push` and a commented `-- ============ DOWN ============` block for manual reversals. `20260702000006_cluster6_auth_audit.down.sql` is a standalone rollback script for Cluster 6 only.

## Schema inventory (19 tables, 8 enums)

**Tables by cluster**

| Cluster | Tables |
| ------- | ------ |
| 1 — Organization | `church_groups`, `users`, `member_profiles` |
| 2 — Instruments | `instruments`, `member_instruments` |
| 3 — Scheduling | `service_weeks`, `setlists`, `setlist_songs`, `events`, `invitations`, `event_attendees`, `conflicts` |
| 4 — Music (partial) | `songs`, `song_documents` |
| 5 — Communication (partial) | `availability`, `notification_preferences`, `notifications` |
| 6 — Auth & Audit | `google_calendar_tokens`, `audit_logs` |

**Enums:** `user_role`, `vocal_capability`, `invitation_status`, `event_type`, `resolution_type`, `setlist_status`, `chat_pref`, `notification_type`

**FK dependency chain:** `church_groups` → `users` → (`member_profiles`, scheduling, songs, availability, tokens, audit). Cluster 2 joins through `member_profiles`. Cluster 3 `setlist_songs` → `setlists`; Cluster 4 `song_documents` → `songs`.

## Verified integration notes

The paragraph below describes the original seven cluster migrations only.
Later files in `supabase/migrations/` add row-level security on
`church_groups`, the `setlist_songs.song_id` foreign key, guest invitations,
Google Calendar helpers, and the reminder schedulers. `lib/supabase/types.ts`
lists the tables the application client knows about.

Independently verified on fresh Postgres 16 (Docker): all seven migration files apply in lex order with zero errors, producing 19 tables and 8 enums. Cross-cluster inserts (organization → instruments → scheduling → songs → availability → audit) succeed.

**Gaps in those original clusters, since closed:**

- `setlist_songs.song_id` had no foreign key to `songs`, because Cluster 3 created the column before `songs` existed and Cluster 4 left the constraint for a later migration. `20260714000001_setlist_songs_song_id_fkey.sql` adds `setlist_songs_song_id_fkey`.
- `church_groups` had no row-level security. `20260704000002_church_groups_rls.sql` lets an authenticated user select their own group. There is still no authenticated insert, update, or delete policy on that table. Creation and join run through `SECURITY DEFINER` functions.

## Apply locally

```bash
# Requires Supabase CLI linked to your project
supabase db push
```

For auth lookup (#15) to work after push, also configure in dashboards:

1. **Clerk** — JWT template named `supabase` (Supabase preset).
2. **Supabase** — Authentication → Third-party auth → enable Clerk with your Clerk Frontend API domain.

## RLS Integration Tests (#33)

Run against a live Supabase instance (local or test project):

```bash
# 1. Start or link to a Supabase instance
supabase start        # local dev
# or: supabase link --project-ref <your-test-project-ref>

# 2. Apply all migrations
supabase db push

# 3. Apply test seed data (two isolated church groups)
psql "$SUPABASE_TEST_URL" -f supabase/seed-rls-test.sql

# 4. Run RLS tests
SUPABASE_TEST_URL=...
SUPABASE_TEST_ANON_KEY=...
SUPABASE_TEST_SERVICE_ROLE_KEY=...
SUPABASE_JWT_SECRET=...
bun run test:rls
```

Tests are skipped automatically when `SUPABASE_TEST_URL` or `SUPABASE_JWT_SECRET` are unset.

`tables/cross-tenant-bypass.test.ts` is the canonical four-verb (SELECT / INSERT
/ UPDATE / DELETE) cross-tenant matrix required by issue #33's acceptance
criteria — extend it (and add a Church B seed row) whenever a new table is
added in later sprints, rather than starting a new file.

In CI the `rls-integration` job runs only when the `SUPABASE_TEST_URL` secret is non-empty (`.github/workflows/ci.yml`). It does not read a `RLS_TESTS_ENABLED` variable. If that secret is absent, GitHub reports the job as skipped, which counts as passing and does not block merge. Making `rls-integration` a required status check, and provisioning the secrets, is a repo-settings change outside this repo's code.

## Roadmap (Phase 1 Sprint 0 backlog)

- `#14`: local `supabase/config.toml` sets `[api] enabled = false`. The hosted Data API is a dashboard setting. Server handlers still call the Supabase client, which uses that API. `scripts/check-service-role.mjs` rejects a service-role reference in `app/` and `lib/`.
- `#23`: select-own RLS on `church_groups` landed in `20260704000002_church_groups_rls.sql`. Writes stay on the create and join functions.
- `setlist_songs.song_id` foreign key landed in `20260714000001_setlist_songs_song_id_fkey.sql`.
- Clerk custom claims (#5/#6): the RLS helpers read `church_group_id` and `role` from the JWT when those claims exist, and fall back to `users`. `lib/clerk/server.ts` does not write the claims yet.
