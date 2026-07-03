# Changes for Issue #13 — [Sprint 0] Set up staging environment

## Scope

Per the spec's OPEN QUESTIONS note, three of the four acceptance criteria
(separate Supabase project, test/sandbox API keys, automatic Vercel deploy
from `main`) are external dashboard provisioning actions and out of scope for
the Coder. Only the "staging config documented in README or /docs" criterion
produces a repo artifact — that documentation is what was implemented here.

## What changed

- **`documentation/staging-environment.md`** (new) — single source of truth
  for the staging setup. Covers all six required sections: Purpose,
  Environments overview (dev/staging/production table), Vercel setup
  (step-by-step + the explicit environment-variable naming convention —
  Vercel's native per-Environment scoping with identical variable names
  across environments, values only differ; no `STAGING_`-prefixed names),
  Test/sandbox keys (Clerk/Pingram/Resend, with "test mode if available,
  otherwise dedicated staging key" phrasing where a sandbox tier isn't
  confirmed), Supabase (separate project, schema parity via
  `supabase/migrations/`, migrate staging before production), and a
  Verification checklist that maps 1:1 to the issue's four acceptance
  criteria. Cites PRD §25.7 (Environment isolation), §26.2 (E2E tests target
  staging), and §26.5 (CI/CD Pipeline / staging deploy gate); references
  issue #83 (production deploy gate) as a forward pointer only. (Note: the
  spec suggested citing "§16/§25/§26.5"; verified against the actual PRD text
  and used the precise subsections that contain the relevant content —
  §25.7, not a bare §16 which is the unrelated Audio-to-Sheet-Music pipeline
  section.)
- **`README.md`** — added a short "Environments" section (4 lines) linking to
  `documentation/staging-environment.md`. No other content changed.
- **`.env.example`** — added a top-of-file comment block (above `# App`)
  stating these are environment-agnostic placeholders, that staging/production
  need distinct values set per-environment in Vercel (never committed here),
  and pointing to the new doc. No variables were added, renamed, or had
  values changed.

## Explicitly not touched

- No `vercel.json`, Terraform/Pulumi, or other IaC files.
- No changes to `.github/workflows/ci.yml` or any new deploy workflow.
- No Playwright/E2E setup.
- No production environment setup.
- No new/renamed env vars, no real secrets or URLs (placeholders only).

## Verification

- `bun run lint` — passes (no errors).
- `bun run typecheck` — passes (no errors).
- Changes are documentation/comment-only; no application code touched, so
  `bun test` behavior is unaffected.

## What the Tester should focus on

- Confirm `documentation/staging-environment.md` covers all six §2a sections
  from the spec and that the Verification checklist's four items map 1:1 to
  the GitHub issue's four acceptance criteria.
- Confirm the Vercel environment-variable naming convention is stated
  unambiguously (identical names, per-Environment values, no prefixing) since
  this was called out as an edge case the doc must nail.
- Confirm no secrets/real values were introduced anywhere, and that
  `.env.example`'s existing variable list is untouched other than the new
  header comment.
- Confirm `README.md`'s new section links correctly and doesn't bloat the
  stub.
