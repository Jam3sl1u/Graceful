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
- `bun run test:e2e` — Playwright E2E tests

## Project Structure

- `app/` — Next.js App Router routes, layouts, and API route handlers (`app/api/*`)
- `components/` — shared React UI components
- `lib/` — server-side clients and integrations (Supabase, Clerk, etc.)
- `schemas/` — Zod validation schemas
- `types/` — shared TypeScript types
- `supabase/` — Supabase project config and migrations
- `tests/` — Jest and Playwright tests
