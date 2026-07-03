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
| `20260703000001_users_self_read_rls.sql` | #15 (bootstrap slice of #22) | Enables RLS on `users`; `users_select_own` policy (`clerk_id = jwt sub`) |

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

Independently verified on fresh Postgres 16 (Docker): all seven migration files apply in lex order with zero errors, producing 19 tables and 8 enums. Cross-cluster inserts (organization → instruments → scheduling → songs → availability → audit) succeed.

**Intentional gaps (per-issue scope, not bugs):**

- `setlist_songs.song_id` has **no FK to `songs`** yet — Cluster 3 (#18) created the column before `songs` existed; Cluster 4 (#19) deliberately did not alter Cluster 3's migration. Referential integrity is application-layer until a follow-up migration adds the constraint.
- RLS is a **bootstrap slice only** on `users` — full `church_group_id`-scoped policies land in #22.
- `seed.sql` is a placeholder — seed data is Sprint 1+.

## Apply locally

```bash
# Requires Supabase CLI linked to your project
supabase db push
```

For auth lookup (#15) to work after push, also configure in dashboards:

1. **Clerk** — JWT template named `supabase` (Supabase preset).
2. **Supabase** — Authentication → Third-party auth → enable Clerk with your Clerk Frontend API domain.

## Roadmap (Phase 1 Sprint 0 backlog)

- `#22`: RLS policies on every table, scoped by `church_group_id` (bootstrap `users_select_own` is a slice)
- `#14`: confirm PostgREST auto-API is disabled; service-role key never used in user-callable code
- Deferred FK: `setlist_songs.song_id` → `songs.id` (after clusters 3+4 land)
