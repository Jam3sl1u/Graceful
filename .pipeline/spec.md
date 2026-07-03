# Spec: Issue #23 — Disable PostgREST auto-API & lock down service role key

## OPEN QUESTIONS (read first)

**OQ-1 (NON-BLOCKING — dashboard action lives outside the repo).**
Two of the four acceptance criteria are Supabase-dashboard / secrets-management
actions that no code in this repo can perform:
- "PostgREST auto-API confirmed disabled in the Supabase project settings"
- "Service role key exists only in trusted migration scripts / CI secrets"

There is no linked/real Supabase project in this repo yet — `supabase/config.toml`
holds only `project_id = "graceful"` and `supabase/migrations/` is `.gitkeep`
(scaffolding stage). The coder CANNOT toggle a dashboard setting or provision a CI
secret. **This spec scopes the coder to the in-repo, verifiable deliverables:
documenting the standing rule and adding a repo-wide guard.** The dashboard toggle
and secret placement remain human/ops follow-ups tracked by this issue and re-checked
in #79. Do NOT invent a fake Supabase project or dashboard automation.

This is not a hard blocker: proceed with the in-repo work below.

---

## Current state (verified — do not redo this analysis)

- **Service-role key is already absent from user-callable code.** Repo-wide search
  for `SUPABASE_SERVICE_ROLE_KEY` / `service_role` finds it ONLY in:
  - `.env.example:7` (declaration, expected)
  - `lib/supabase/client.ts:6` (a warning comment telling future devs never to use it here)
  - docs/backlog/spec references
  No `createClient(..., SERVICE_ROLE_KEY)` call exists anywhere in `/app` or `/lib`.
  Acceptance criterion "does not appear in `/app` or any user-callable API route"
  is **already satisfied**; the coder's job is to add a guard that keeps it that way.
- **The architecture rules already exist in the PRD** — see
  `documentation/prd/graceful_requirements_v10.md` §19.3 (lines 693–696) and §25.1
  (lines 1383–1384). They are NOT yet surfaced as a contributor-facing standing rule.
- **There is no `/docs` directory.** The issue says "`/docs` or README." Use the
  README route (see Files below) — do not create a new top-level `/docs` tree.
- `supabase/config.toml` is a 4-line placeholder with no `[api]` block.

---

## Files to create / modify

### 1. `supabase/config.toml` (MODIFY)
Add an explicit `[api]` block that disables PostgREST for local `supabase start`,
so the "PostgREST disabled" intent is codified where the project config lives (the
production toggle is still a dashboard action per OQ-1). Append after the existing
`project_id` line:

```toml
# PostgREST auto-API is disabled by architecture rule (PRD §19.3, §25.1 / issue #23).
# All DB access goes through Next.js API routes, never Supabase's generated REST API.
# NOTE: this governs the local `supabase start` stack only. The hosted project's
# Data API must also be turned off in the Supabase dashboard (Settings > API) — see
# issue #23 acceptance criteria and re-verified in the Sprint 4 audit (#79).
[api]
enabled = false
```

Keep the existing header comments and `project_id` line intact.

### 2. `README.md` (MODIFY)
The README is currently 2 lines. Append a `## Architecture rules (standing)` section
documenting the two rules this issue is about, phrased for future contributors. Keep
it tight — copy the wording intent from PRD §19.3 lines 693–695. Must state:
- PostgREST (Supabase's auto-generated REST API) is disabled; all data access goes
  through the app's own Next.js API routes.
- The Supabase **service role key bypasses RLS** and must NEVER appear in any
  user-callable API route (`app/**`) or client/lib code (`lib/**`). It belongs only
  in trusted migration/seed scripts and CI secrets.
- Reference: PRD §15.1 (§25.1 in v10 doc), §19.3.
- Note that this rule is enforced by the check in `scripts/check-service-role.mjs`
  (item 3) and re-verified in the Sprint 4 security audit (#79).

### 3. `scripts/check-service-role.mjs` (CREATE)
A repo-wide guard that fails (exit code 1) if the service-role key is referenced in
user-callable code. This makes the "confirmed via repo-wide search" criterion
executable and repeatable rather than a one-time manual pass.

Behavior:
- Recursively scan `app/` and `lib/` for the strings `SUPABASE_SERVICE_ROLE_KEY`
  and `service_role` (case-insensitive on the latter).
- **Allowlist:** `lib/supabase/client.ts` is permitted to mention the key **only
  inside comments** (it currently warns against using it). Simplest correct rule:
  allow the match on any line that is a comment (line trimmed starts with `//` or
  `*`), fail on any non-comment occurrence anywhere in `app/`+`lib/`. Do not
  hard-exclude the whole file, or the guard becomes toothless if real code is added.
- On violation: print each offending `path:line` and the matched text, then
  `process.exit(1)`.
- On clean: print a one-line OK message and exit 0.
- No external dependencies — use Node's built-in `fs`/`path` only (ESM `.mjs`,
  matching repo convention; confirm by checking whether other `scripts/*.mjs` /
  package.json `"type"` exist and follow it). Read files as UTF-8; skip non-source
  extensions (only scan `.ts`, `.tsx`, `.js`, `.mjs`).

Signature (no exports needed; it's a CLI script):
```
node scripts/check-service-role.mjs   # exit 0 = clean, exit 1 = violation
```

### 4. `package.json` (MODIFY)
Add a script entry so the guard is discoverable and CI-runnable:
```json
"check:service-role": "node scripts/check-service-role.mjs"
```
Place it alongside existing scripts. Do NOT wire it into a git hook or CI workflow
in this issue (out of scope — no CI config is asked for). If a `lint`/`check`
aggregate script already exists, you MAY chain it in, but only if that does not
change existing behavior; otherwise leave standalone.

---

## Edge cases the implementation must handle

- **`check-service-role.mjs` must pass against the current repo as-is.** The only
  current match is the comment block in `lib/supabase/client.ts` — the comment
  allowlist must let that through with exit 0. Verify this before finishing.
- The scanner must not crash on directories with no matching files, on empty files,
  or on binary/non-source files (skip by extension).
- Case sensitivity: `SUPABASE_SERVICE_ROLE_KEY` is all-caps (env var);
  `service_role` may appear lower/upper — match case-insensitively for the latter.
- Do not match on substrings that are legitimately unrelated (there are none
  currently; the two literal patterns above are specific enough — do not broaden to
  bare `service` or `role`).
- README/config edits must be additive; do not delete or reword existing content.

---

## Patterns to follow

- **Config style:** mirror the existing comment-first style already in
  `supabase/config.toml` and `supabase/README.md` (leading `#` explanatory comments
  citing PRD sections and issue numbers).
- **Doc citation style:** the codebase consistently cites PRD sections inline
  (e.g. `lib/supabase/client.ts:7` cites "PRD §19.3", `app/api/health/route.ts:5`
  cites "PRD §19.2"). Match that convention.
- **Script style:** if any `scripts/*.mjs` already exists, copy its shebang/ESM/
  exit-code conventions. If `scripts/` does not yet exist, create it; keep the file
  dependency-free (Node built-ins only), consistent with the repo having no test/
  tooling deps wired for this.

---

## Out of scope (do NOT touch)

- Rate limiting (#76), CSP/HTTPS (#78), CI pipeline wiring, git hooks.
- Implementing `getSupabaseClient` or any RLS work (#22) — leave
  `lib/supabase/client.ts` logic unchanged (the guard reads it, does not edit it).
- Creating a real Supabase project, running migrations, or any dashboard automation.
