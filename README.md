# Graceful

Planning Center capabilities with internal ML features

## Getting Started

```bash
npm install
npm run dev
```

Open http://localhost:3000 to view the app.

## Scripts

- `npm run dev` — start the Next.js dev server
- `npm run build` — production build
- `npm run lint` — ESLint
- `npm run typecheck` — TypeScript check (no emit)
- `npm run format` — format all files with Prettier
- `npm run format:check` — verify formatting

## Project Structure

- `app/` — Next.js App Router routes, layouts, and API route handlers (`app/api/*`)
- `components/` — shared React UI components
- `lib/` — server-side clients and integrations (Supabase, Clerk, etc.)
- `schemas/` — Zod validation schemas
- `types/` — shared TypeScript types
- `supabase/` — Supabase project config and migrations
- `tests/` — Jest and Playwright tests
