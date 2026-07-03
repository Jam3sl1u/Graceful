# Graceful
Planning Center capabilities with internal ML features

## Architecture rules (standing)

- **PostgREST is disabled.** Supabase's auto-generated REST API is turned off;
  all data access goes through the app's own Next.js API routes, which enforce
  business logic before touching the database.
- **The Supabase service role key bypasses RLS** and must NEVER appear in any
  user-callable API route (`app/**`) or client/lib code (`lib/**`). It belongs
  only in trusted migration/seed scripts and CI secrets.
- Reference: PRD §15.1 (§25.1 in v10 doc), §19.3.
- Enforced by `scripts/check-service-role.mjs` (run via `bun run
  check:service-role`) and re-verified in the Sprint 4 security audit (#79).
