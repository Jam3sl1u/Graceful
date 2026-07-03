# supabase/

## Migrations

Migrations are applied in lexicographic order by the `YYYYMMDDHHMMSS_` prefix.

| File | Contents |
| ---- | -------- |
| `20260702000001_cluster_1_organization.sql` | Cluster 1 — `church_groups`, `users`, `member_profiles` tables; `user_role` and `vocal_capability` enums (issue #16) |
| `20260702000002_cluster_2_instruments.sql` | Cluster 2 — `instruments`, `member_instruments` tables; FK to `church_groups`, `users`, `member_profiles` (issue #17) |
| `20260702000003_cluster_3_scheduling_core.sql` | Cluster 3 — `service_weeks`, `setlists`, `setlist_songs`, `events`, `invitations`, `event_attendees`, `conflicts` tables; `invitation_status`, `event_type`, `resolution_type`, `setlist_status` enums. FK to `church_groups`, `users` (issue #18). `setlist_songs.song_id` FK deferred until Cluster 4. |
| `20260703000001_users_self_read_rls.sql` | Bootstrap RLS slice (#15 auth lookup): enables RLS on `users`, adds `users_select_own` SELECT policy scoped to `clerk_id = jwt sub`. Full RLS (#22) not yet applied. |

Each file contains an `-- ============ UP ============` block (applied by `supabase db push`) and
a commented `-- ============ DOWN ============` block for manual reversals.

## Roadmap (from Phase 1 Sprint 0 backlog)

- `#7-12`: one migration file per schema cluster (24 tables, 9 enums — PRD §20)
- `#22`: RLS policies on every table, scoped by `church_group_id` (the bootstrap policy above is a slice)
- `#14`: confirm PostgREST auto-API is disabled, service-role key never used in user-callable code

`seed.sql` is a placeholder — seed data is out of scope until Sprint 1.
