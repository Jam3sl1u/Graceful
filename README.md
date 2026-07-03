# Graceful

Planning Center capabilities with internal ML features

## Environments

Graceful runs in three environments: development, staging, and production.
See [`documentation/staging-environment.md`](documentation/staging-environment.md)
for how the staging environment is configured and verified.

## Prerequisites

Requires [Bun](https://bun.sh) (CI pins `1.2.x` via `oven-sh/setup-bun`).

## Getting Started

```bash
bun install
bun run dev
```

Open http://localhost:3000 to view the app.

## Scripts

- `bun run dev` — start the Next.js dev server
- `bun run build` — production build
- `bun run lint` — ESLint
- `bun run typecheck` — TypeScript check (no emit)
- `bun run format` — format all files with Prettier
- `bun run format:check` — verify formatting
- `bun run test` — Jest unit tests
- `bun run test:rls` — RLS integration tests (requires Supabase test env)
- `bun run test:e2e` — Playwright E2E tests
- `bun run check:service-role` — verify service role key not in `app/` or `lib/`

## Project Structure

- `app/` — Next.js App Router routes, layouts, and API route handlers (`app/api/*`)
- `components/` — shared React UI components
- `lib/` — server-side clients and integrations (Supabase, Clerk, etc.)
- `schemas/` — Zod validation schemas
- `types/` — shared TypeScript types
- `supabase/` — Supabase project config and migrations
- `tests/` — Jest and Playwright tests

## Architecture rules (standing)

- **PostgREST is disabled.** Supabase's auto-generated REST API is turned off;
  all data access goes through the app's own Next.js API routes, which enforce
  business logic before touching the database. The `church_groups` table has no
  RLS by design — PostgREST being disabled is its only database-layer guard.
- **The Supabase service role key bypasses RLS** and must NEVER appear in any
  user-callable API route (`app/**`) or client/lib code (`lib/**`). It belongs
  only in trusted migration/seed scripts and CI secrets.
- Reference: PRD §15.1 (§25.1 in v10 doc), §19.3.
- Enforced by `scripts/check-service-role.mjs` (run via `bun run
  check:service-role`) and re-verified in the Sprint 4 security audit (#79).
