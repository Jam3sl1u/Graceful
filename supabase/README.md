# supabase/

Migrations deferred — see Phase 1 Sprint 0 issues #7-14
(`documentation/phase-1/graceful_phase1_sprint_backlog.md`):

- #7-12: one migration file per schema cluster (24 tables, 9 enums — PRD §20)
- #13: RLS policies on every table, scoped by `church_group_id`
- #14: confirm PostgREST auto-API is disabled, service-role key never used
  in user-callable code

`migrations/` is currently empty (`.gitkeep` only) and `seed.sql` is a
placeholder — this scaffolding pass only establishes where migrations will
live, not their content.
