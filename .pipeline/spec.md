# Spec — Issue #142: Provision Google OAuth credentials & Cloudflare R2 bucket

## Scope note (read first — not a blocking OPEN QUESTION)

This issue is a **provisioning / ops task**, not a code-implementation task.
The Acceptance Criteria describe actions taken in external dashboards (Google
Cloud Console, Cloudflare, Vercel, GitHub Actions secrets) using real accounts
and secrets. No AI/code stage can create an OAuth client, mint an R2 API token,
or set a Vercel env var — those are human actions, and per the issue's own
Implementation Notes ("Store actual secrets in Vercel/GitHub Actions secrets,
never in the repo") they must never land in this repo.

Two facts confirmed by reading the current tree that narrow scope further:

1. The files the issue describes as "throwing stubs" are **already fully
   implemented** and consume the exact env-var names in question:
   - `lib/google-calendar/oauth.ts` — reads `GOOGLE_CLIENT_ID`,
     `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`; hard-codes the write-only
     scope `https://www.googleapis.com/auth/calendar.events`.
   - `lib/google-calendar/token-crypto.ts` — reads `TOKEN_ENCRYPTION_KEY`,
     `Buffer.from(raw, "base64")`, and **throws unless it decodes to exactly
     32 bytes** (AES-256-GCM).
   - `lib/r2/client.ts` — reads `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`,
     `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`; `region: "auto"`,
     `forcePathStyle: true`; pre-signed URLs expire at `30 * 60` seconds.
   (`lib/r2/client.ts` uses all R2 vars except `R2_ACCOUNT_ID`, which is only
   needed to construct `R2_ENDPOINT`.)
   Do **not** modify these files — implementing them is #58/#61/#62, and
   they're already done.
2. `.env.example` already has all ten variables as empty placeholders and a
   header forbidding real values in the repo. Do **not** put values there.

**Therefore the concrete in-repo deliverable for this issue is a
human-operator provisioning runbook** (mirroring `documentation/
staging-environment.md` and its "Human setup after merge" pattern), plus the
small wiring to link it. This is exactly how #10 and the cron issue were
handled: the repo documents the steps + a verification checklist; the human
executes the dashboard actions. This satisfies the issue's real goal — "a
teammate picking up #58/#61/#62 can pull env vars and exercise the real
flow without provisioning anything themselves" — by making the provisioning
reproducible and the wiring authoritative.

No blocking ambiguity — proceed.

## Files to create

### 1. `documentation/google-oauth-r2-provisioning.md` (NEW)

A provisioning runbook for the human operator. Follow the structure, tone,
and formatting conventions of `documentation/staging-environment.md`
(numbered `##` sections, Markdown tables, a final `## Verification checklist`
of `- [ ]` items). Copy that file's environment-isolation framing (PRD §25.7:
staging and production get **distinct** credentials; production credentials
are never used in staging) and its Vercel env-var convention (native
per-Environment scoping — Preview = staging, Production = production — same
variable name across environments, only values differ; never name-prefix).

Required content, section by section:

1. **Purpose** — one paragraph: provisions the real Google OAuth client and
   Cloudflare R2 bucket that `lib/google-calendar/*` and `lib/r2/client.ts`
   consume, so #58/#61/#62 can be exercised end-to-end, not just unit-tested.
   Note the code is already implemented; this issue only supplies its
   credentials. Reference PRD §11.2, §12.4, §18.

2. **Prerequisites** — the Google Cloud Console project with the Calendar API
   enabled and the Cloudflare R2 account already exist (issue #10, the
   blocker). This runbook does not create either account.

3. **Google OAuth 2.0 client** — steps for the operator:
   - In the existing GCP project, create an **OAuth 2.0 Client ID** of type
     **Web application**.
   - Scope: `https://www.googleapis.com/auth/calendar.events` only
     (write-only per PRD §12.4 / §25.5 — the app never reads a member's
     calendar). State this matches `lib/google-calendar/oauth.ts`'s
     `CALENDAR_EVENTS_SCOPE`.
   - **Authorized redirect URI** must equal
     `<NEXT_PUBLIC_APP_URL>/api/google-calendar/callback` — the path is
     fixed by the route file `app/api/google-calendar/callback/route.ts`
     (GET handler). Register one authorized redirect URI per environment:
     - local dev: `http://localhost:3000/api/google-calendar/callback`
     - staging: `https://<staging-vercel-host>/api/google-calendar/callback`
     - production: `https://<prod-host>/api/google-calendar/callback`
     Use a **dedicated OAuth client per environment** (staging vs production),
     per §25.7 and `staging-environment.md` §3's Google Calendar row.
   - The resulting Client ID → `GOOGLE_CLIENT_ID`, client secret →
     `GOOGLE_CLIENT_SECRET`, the environment's redirect URI →
     `GOOGLE_REDIRECT_URI` (each environment's value points at its own host).

4. **Token encryption key** — `TOKEN_ENCRYPTION_KEY` must be a **32-byte
   random value, base64-encoded** (decoded length exactly 32 bytes, or
   `token-crypto.ts` throws). Give the exact generation command
   `openssl rand -base64 32` and note it must be **base64, not hex**, and
   that staging and production each get their **own distinct** key (a shared
   key would let one environment decrypt the other's tokens). Never commit or
   log it.

5. **Cloudflare R2 bucket** — steps for the operator:
   - Create a **private** R2 bucket (no public access / no public
     bucket URL / no custom domain) in the existing account. The app only
     ever serves objects through pre-signed URLs (`lib/r2/client.ts`,
     30-minute expiry), so direct public reads must stay disabled.
   - Create an **R2 API token scoped to only that bucket** (Object
     Read & Write on that single bucket — not account-wide).
   - Map the outputs:
     - `R2_ACCOUNT_ID` — the Cloudflare account ID.
     - `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` — the API token's
       S3-compatible access key id / secret.
     - `R2_BUCKET_NAME` — the bucket name.
     - `R2_ENDPOINT` — `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`
       (the S3 API endpoint; `lib/r2/client.ts` uses `region: "auto"` +
       `forcePathStyle: true`, so give the account-level endpoint, no bucket
       in the host).
   - Use a **separate bucket + separate token per environment** (staging vs
     production), per §25.7 and `staging-environment.md` §3's R2 row.

6. **Where to set the values** — a table mapping each of the ten variables to
   its destinations:
   - Local: `.env.local` (git-ignored; never `.env.example`).
   - Vercel: **Preview** environment for staging, **Production** for
     production, same variable names, distinct values (link to
     `staging-environment.md` §3).
   - Only add a variable to GitHub Actions secrets if a CI/E2E workflow
     actually reads it; state that none of #58/#61/#62's server-side vars are
     consumed by a GitHub Actions workflow today, so GitHub secrets are not
     required for this issue (contrast the cron/E2E vars in
     `staging-environment.md` §6–§7 which are). Keep this accurate — do not
     invent a workflow that reads these.

7. **Free-tier / cost note** — per PRD §18: Google Calendar API 10M
   requests/day free; Cloudflare R2 10GB storage / 10M writes / 100M reads
   free with zero egress. This provisioning stays entirely within free tier.

8. **Verification checklist** — `- [ ]` items that restate the issue's
   Acceptance Criteria in verifiable form, e.g.:
   - [ ] OAuth Web client exists in the #10 GCP project with only the
         `calendar.events` scope and a redirect URI matching
         `/api/google-calendar/callback` for each environment.
   - [ ] `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI`
         set in Vercel Preview + Production and in local `.env.local`.
   - [ ] `TOKEN_ENCRYPTION_KEY` is a base64 value decoding to exactly 32
         bytes, distinct per environment, set the same three places.
   - [ ] A private R2 bucket exists (no public access) with a bucket-scoped
         API token; all five `R2_*` vars set the same three places, distinct
         per environment.
   - [ ] `R2_ENDPOINT` is `https://<account-id>.r2.cloudflarestorage.com`.
   - [ ] A teammate can pull the env vars and run the real OAuth/R2 flow
         without provisioning anything themselves.
   - [ ] This document exists at
         `documentation/google-oauth-r2-provisioning.md` and is linked from
         `README.md`.

## Files to modify

### 2. `README.md`

In the `## Environments` section (currently lines 5–9), add one sentence
linking the new runbook, in the same style as the existing
`staging-environment.md` link. Example wording:
"For provisioning the Google OAuth client and Cloudflare R2 bucket that
Sprint 3 (#58/#61/#62) depends on, see
[`documentation/google-oauth-r2-provisioning.md`](documentation/google-oauth-r2-provisioning.md)."
Do not restructure the section.

### 3. `documentation/staging-environment.md`

Add a cross-reference so the two docs stay consistent. In §3's table, the
"Google Calendar" and "Cloudflare R2" rows already say "use a dedicated OAuth
client / separate staging bucket." Append a short pointer (in-cell or as a
sentence under the table) to
`documentation/google-oauth-r2-provisioning.md` for the step-by-step. Keep
the edit minimal — a reference only, do not duplicate the runbook content and
do not renumber or rewrite existing sections.

### 4. `.env.example` (comment-only edit — no values)

Do **not** add any real values. Only enrich the two existing comment headers
so the format requirements are discoverable at the point of use:
- Above the `# Google Calendar (OAuth sync)` block: add a comment that
  `GOOGLE_REDIRECT_URI` = `<NEXT_PUBLIC_APP_URL>/api/google-calendar/callback`
  and `TOKEN_ENCRYPTION_KEY` = base64 of 32 random bytes
  (`openssl rand -base64 32`); point to
  `documentation/google-oauth-r2-provisioning.md`.
- Above the `#Cloudflare R2 (file storage)` block: add a comment that
  `R2_ENDPOINT` = `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com` and
  point to the same runbook.
Keep both additions to a couple of comment lines each; preserve the existing
placeholder lines exactly (still empty).

## Edge cases / must-get-right details

- `TOKEN_ENCRYPTION_KEY` is **base64, exactly 32 decoded bytes** — hex or a
  wrong-length value makes `token-crypto.ts` throw at runtime. The runbook
  must say base64 and give `openssl rand -base64 32`.
- Redirect URI path is **exactly** `/api/google-calendar/callback` (fixed by
  the route file). A trailing slash or different path breaks the OAuth
  exchange in `lib/google-calendar/oauth.ts` / the callback handler.
- Scope is **only** `calendar.events` (write-only). Do not add read scopes.
- R2 bucket must be **private** — no public bucket URL / custom domain; the
  app relies exclusively on pre-signed URLs.
- `R2_ENDPOINT` is the **account-level** S3 endpoint (bucket not in the
  host), because `forcePathStyle: true`.
- Staging and production get **distinct** OAuth clients, encryption keys, R2
  buckets, and tokens — never shared (PRD §25.7).
- **No real secret value may appear in any committed file**, including
  `.env.example`, the runbook, README, or commit messages.

## Patterns to copy

- Runbook structure, tone, tables, isolation framing, and
  `## Verification checklist` format: `documentation/staging-environment.md`
  (esp. §3 env-var convention, §6 "Human setup after merge", §8 checklist).
- README link style: existing `## Environments` link to
  `staging-environment.md` (README.md lines 7–9).

## Explicitly out of scope (do not touch)

- `lib/google-calendar/oauth.ts`, `token-crypto.ts`, `sync.ts`,
  `lib/r2/client.ts`, and the `app/api/google-calendar/*` handlers — already
  implemented; implementing/altering them is #58/#61/#62.
- iCal `.ics` export (#63).
- Any actual credential creation or env-var setting (human dashboard action,
  never committed).
