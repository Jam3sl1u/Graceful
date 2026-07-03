# Spec: Issue #13 — [Sprint 0] Set up staging environment

## OPEN QUESTIONS

None that block the in-repo work. **But read this first — it defines scope:**

Three of the four acceptance criteria (separate Supabase project, test/sandbox
API keys, automatic Vercel deploy from `main`) are **provisioning actions
performed in external dashboards** (Supabase, Vercel, Clerk, Pingram, Resend).
They cannot be done by editing files in this repo and are **out of scope for the
Coder**. The one criterion that produces a repo artifact is:

> Staging config documented in README or `/docs`

**The Coder's entire job for this issue is to write that documentation** (plus a
small, matching addition to `.env.example` header comment — see §3). The doc
must describe the setup precisely enough that a human can execute the dashboard
steps and verify them. Do NOT invent scripts, CI jobs, or Terraform — none were
requested and there is no IaC pattern in this repo.

Do NOT commit any real secrets, keys, project IDs, or URLs. Placeholders only
(the repo convention in `.env.example`).

---

## 1. Current repo state (verified)

- No `/docs` directory exists. Documentation lives under `documentation/`
  (`documentation/phase-1/`, `documentation/prd/`).
- `README.md` is a 2-line stub (title + one sentence).
- `.env.example` exists at repo root with all service env vars as empty
  placeholders, grouped by section header comments (App, Supabase, Clerk,
  Pingram, Resend, Google, R2, Upstash, QStash, Modal, Spotify). It is currently
  **environment-agnostic** — no dev/staging/prod namespacing.
- `.github/workflows/ci.yml` runs on `pull_request` only (typecheck, lint, test,
  audit). It does **not** deploy — Vercel handles deploys via its Git
  integration, not GitHub Actions. Do NOT add a deploy job to CI.
- No `vercel.json` exists. Vercel config is dashboard-managed. Do NOT create one
  unless the doc step below genuinely requires it — it does not.
- PRD §25 (Environment isolation) and §26.5 (CI/CD Pipeline) are the governing
  requirements. Key facts to mirror in the doc:
  - Three environments: development (local), staging, production.
  - Staging mirrors production: same Vercel config, **separate** Supabase
    project (identical schema), **separate** R2 bucket, Pingram test
    environment, Clerk test mode.
  - Staging always deploys from `main` after merge.
  - Production secrets are never used in dev or staging.

---

## 2. Files to create / modify

### 2a. CREATE: `documentation/staging-environment.md`

This is the single source of truth for the staging setup. Follow the tone and
Markdown structure of existing docs in `documentation/` (heading levels, tables
where enumerating config). Sections required:

1. **Purpose** — one paragraph: staging mirrors production so Phase 1 changes are
   validated end-to-end before shipping; it is the future target for Playwright
   E2E (§26.2) and the production deploy gate (#83). Cite PRD §16 / §25 / §26.5.

2. **Environments overview** — a table of the three environments
   (development / staging / production) with columns: purpose, host, branch,
   Supabase project, API-key mode. Fill development and staging concretely;
   mark production as "set up later — same pattern (issue out of scope here)".

3. **Vercel setup** — step-by-step for a human operator:
   - Staging is a Vercel deployment target that auto-deploys from the `main`
     branch. (Production, when set up, will map to git tags / a `production`
     branch or promotion — note as future, do not specify.)
   - Environment variables must be namespaced per environment using Vercel's
     built-in **Environment** scoping (Production / Preview / Development), OR an
     explicit naming convention if the operator prefers. State the chosen
     convention explicitly so it is unambiguous — see §4 Edge Cases.
   - List every env var group from `.env.example` and note which need a
     **distinct staging value** vs. which can be shared. Distinct-per-env
     (staging-specific): Supabase (URL, anon key, service role), Clerk keys +
     webhook secret, Pingram key + webhook secret, Resend key + webhook secret,
     R2 bucket/credentials, `NEXT_PUBLIC_APP_URL`, `TOKEN_ENCRYPTION_KEY`,
     Upstash/QStash, Modal, Google OAuth redirect URI + client. Keep this a
     table mirroring the `.env.example` sections.

4. **Test / sandbox keys** — for each of Clerk, Pingram, Resend: state to use
   test/sandbox mode where the provider offers it (Clerk test instance, Pingram
   test environment, Resend test API key / sandbox domain). Where a provider has
   no sandbox tier, note "use a dedicated staging key on the same account, never
   the production key." Do not assert a provider has a sandbox you cannot
   confirm — phrase as "use test mode if available, otherwise a separate key."

5. **Supabase** — separate Supabase project for staging, schema kept identical to
   production via the migrations under `supabase/migrations/` (currently empty —
   reference `supabase/README.md`). Note migrations run against staging before
   production (§26.5 Migration safety).

6. **Verification checklist** — a checkbox list a human can walk to confirm all
   four acceptance criteria are met (staging Supabase project exists and is
   distinct; test keys in use; push to `main` triggers a staging deploy; this doc
   exists and is linked from README).

### 2b. MODIFY: `README.md`

Add a short "Environments" section (2–4 lines) that links to
`documentation/staging-environment.md`. This satisfies the "documented in README
**or** /docs" criterion via README linkage. Do not bloat the README stub with the
full content — link only.

### 2c. MODIFY: `.env.example`

Add a top-of-file comment block (above the existing `# App` section) explaining
that these are environment-agnostic placeholders and that **staging and
production must each get their own distinct values**, set per-environment in
Vercel (never committed here). Reference `documentation/staging-environment.md`.
Do NOT add new variables, do NOT duplicate the var list per-environment, do NOT
change any existing variable names or values.

---

## 3. Explicitly OUT OF SCOPE (do not do)

- Creating the actual Supabase/Vercel/Clerk/etc. projects or keys (external).
- Any `vercel.json`, Terraform, Pulumi, or other IaC file.
- Any change to `.github/workflows/ci.yml` or a new deploy workflow.
- Staging smoke tests / Playwright E2E setup (explicitly Sprint 4, #83, #82).
- Production environment setup (issue's Out of Scope).
- Adding or renaming environment variables.

---

## 4. Edge cases / decisions the Coder must nail

- **Namespacing convention (issue Implementation Note: "clearly namespaced in
  Vercel").** The doc must state ONE unambiguous convention. Recommended: use
  Vercel's native per-Environment scoping (Preview→staging via `main`,
  Production→prod later) with identical variable *names* across environments and
  different *values* — do NOT prefix var names like `STAGING_SUPABASE_URL`,
  because the app code reads plain names (e.g. `NEXT_PUBLIC_SUPABASE_URL`).
  Document this reasoning so no one later prefixes names.
- **README says "or /docs" — this repo uses `documentation/`, not `/docs`.**
  Put the doc under `documentation/` (existing convention) and link from README.
  Do not create a new top-level `/docs` directory.
- **No secrets in source (PRD §15).** Every value in the doc and `.env.example`
  must be a placeholder or a `<describe-what-goes-here>` token.
- **Providers without sandbox tiers.** Do not fabricate a sandbox mode; use the
  "test mode if available, otherwise a separate dedicated staging key" phrasing.
- The `main` branch is the staging deploy trigger — be explicit that merging to
  `main` deploys staging (matches §26.5 and current repo's single-branch flow).

---

## 5. Definition of done

- `documentation/staging-environment.md` exists and covers all six sections in §2a.
- `README.md` links to it under an Environments heading.
- `.env.example` has the top comment block; no vars added/renamed.
- No secrets, no external side effects, no CI or IaC changes.
- Verification checklist in the doc maps 1:1 to the issue's four acceptance
  criteria.
