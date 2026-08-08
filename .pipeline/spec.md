# Spec — Issue #79: [Sprint 4] Conduct manual OWASP Top 10 review

## OPEN QUESTIONS

**None blocking — do not stop the pipeline.**

Two items resolved by inspection rather than by asking a human (recorded here so
downstream stages don't re-raise them):

1. **`npm audit` → `bun audit`.** The issue's AC says `npm audit --audit-level=high`.
   Per `AGENTS.md`, translate to `bun audit --audit-level=high` and proceed. This is
   already wired into CI (`.github/workflows/ci.yml`, `checks` job, line 30).
2. **`pip-audit`.** The AC scopes it "if any Python tooling exists". Verified: the
   repo contains **zero** `.py` files and no `requirements*.txt`, `pyproject.toml`,
   `Pipfile`, or `setup.py` anywhere. `pip-audit` is therefore **N/A** and must be
   documented as N/A with that evidence — not run, not skipped silently.

One item needs a human *action* (not a decision) and must not block implementation:
the launch-gate check added here is a mechanical guard; a human still performs the
final Phase 1 launch sign-off (issue #83). Record it as an operator checklist item
in the new doc.

## Goal

Produce the documented manual OWASP Top 10 (2021) review that PRD §26.3
(`documentation/prd/graceful_requirements_v10.md`, "OWASP Top 10 checklist" row;
cited as §16.3 in the issue) requires before Phase 1 launch, covering **A01, A02,
A03, A05, A07**, plus a mechanical gate so an unresolved high-severity finding
blocks the launch rather than living only as prose.

This issue is a **review + documentation** issue. Do **not** refactor, do not
re-do the work of #76 (rate limiting), #77 (input validation), or #78
(infra security). See "Code changes" below for the one narrow exception.

## Current state (verified by reading the code — do not re-derive, but do re-verify claims you cite)

- `documentation/infrastructure-security.md` exists (#78) and explicitly lists
  "The broader OWASP security review (#79)" as out of its scope.
- #76 shipped `lib/api/rate-limit.ts` + wiring in `middleware.ts`.
- #77 shipped `lib/api/postgrest.ts` (`escapePostgrestFilterValue`), `schemas/**`
  Zod max-length caps, and param/query validation; tester-supplement tests for it
  live under `tests/unit/**/*-tester-supplement.test.ts`.
- Existing repeatable guard scripts: `scripts/check-service-role.mjs`,
  `scripts/check-git-secrets.mjs`, `scripts/check-workflows.mjs`, each exposed as a
  `check:*` script in `package.json` and (for the first two indirectly / the latter
  two) run in CI.
- There is **no** existing OWASP review document.

## Files to create

### 1. `documentation/owasp-top-10-review.md` (primary deliverable)

Follow the tone, structure, and level of detail of
`documentation/infrastructure-security.md` — numbered top-level sections, tables,
explicit "why this is safe" reasoning, and checklists for the human operator.

**Required section headings, verbatim** (the parser in item 2 depends on the five
category headings, so the `A0N` prefix and the `## ` level are load-bearing):

```
# OWASP Top 10 (2021) Manual Review — Phase 1 Pre-Launch

## 1. Scope, method, and launch-gate policy
## 2. Dependency scans
## 3. A01:2021 — Broken Access Control
## 4. A02:2021 — Cryptographic Failures
## 5. A03:2021 — Injection
## 6. A05:2021 — Security Misconfiguration
## 7. A07:2021 — Identification and Authentication Failures
## 8. Open findings summary
## 9. Re-run checklist
```

**Section 1** must state: which OWASP categories are in scope and that A04/A06/A08/
A09/A10 are out of scope for this issue (per the AC's named list); that third-party
penetration testing is explicitly out of scope; the commit SHA reviewed and the
date; and the **launch-gate policy** — a finding with severity `Critical` or `High`
that is not `Resolved`, or any finding at any severity still `Open`, blocks the
Phase 1 launch (issue #83), not merely this PR, and is enforced by
`bun run check:owasp`.

**Section 2** must record, in a table, the actual runs:

| Scan | Command | Date | Commit | Result |
| ---- | ------- | ---- | ------ | ------ |

- Row 1: `bun audit --audit-level=high` — **actually run it** and paste the real
  outcome and exit code. Do not fabricate. Note it also runs per-PR in CI.
- Row 2: `pip-audit` — `N/A`, with the evidence from OPEN QUESTIONS item 2.

If `bun audit --audit-level=high` reports any high-severity advisory, record it as
an **A05 finding with severity `High`**. Do not attempt a dependency upgrade in this
issue — the gate failing is the correct outcome and the pipeline should surface it.

**Sections 3–7** each use exactly this sub-structure:

```
### Scope reviewed
### Method
### Findings
### Conclusion
```

- **Scope reviewed** — a bullet list of the concrete files/dirs inspected
  (absolute-in-repo paths, e.g. `lib/api/auth.ts`, `supabase/migrations/*rls*.sql`).
- **Method** — how it was checked (code read, existing test suite consulted, grep,
  etc.), naming the test files relied on.
- **Findings** — a GitHub-flavored markdown table with **exactly these columns, in
  this order** (the parser depends on it):

  | ID | Severity | Status | Summary | Evidence | Resolution |
  | -- | -------- | ------ | ------- | -------- | ---------- |

  - `ID` — `A01-1`, `A01-2`, … prefixed with the section's category.
  - `Severity` — one of `Critical`, `High`, `Medium`, `Low`, `Info`.
  - `Status` — one of `Resolved`, `Accepted`, `Deferred`, `Open`.
  - `Evidence` — the file path(s)/line(s) or test file that substantiate it.
  - **A category with no issues must still emit exactly one row**: ID `A0N-0`,
    Severity `Info`, Status `Resolved`, with `Summary` = "No issues found" and
    `Resolution` explaining *why* — this satisfies the AC's "even 'no issues found,
    here's why'". Empty tables are a parser failure.
- **Conclusion** — one short paragraph.

**Section 8** — a single consolidated table (same six columns) listing every
non-`Resolved` finding across all five categories, or the literal line
`No open findings.` when there are none.

**Section 9** — operator checklist (`- [ ]` items) for re-running this review before
each subsequent phase launch: re-run `bun audit --audit-level=high`, re-run
`bun run check:owasp`, re-check any `Deferred` findings, and confirm the human
Phase 1 launch sign-off (#83).

#### Candidate items the review MUST explicitly address

Each of the following must appear in the relevant category — either dismissed in
the Conclusion/`A0N-0` row with reasoning, or recorded as its own finding row. This
list is the *floor*, not the ceiling; it is derived from an actual read of the repo.
Verify each claim yourself before writing it down.

**A01 — Broken Access Control**
- `requireAuth` / `requireRole` (`lib/api/auth.ts`) and that every non-public
  `app/api/**` route or handler goes through them.
- `middleware.ts` `isPublicRoute` matcher — justify each entry that is public.
- RLS policies (`supabase/migrations/20260704000001_rls_policies.sql`,
  `20260704000002_church_groups_rls.sql`, `20260703000001_users_self_read_rls.sql`)
  and the `tests/integration/rls/**` suite, especially
  `tables/cross-tenant-bypass.test.ts` and `tables/role-gated.test.ts`.
- `SECURITY DEFINER` RPCs (accept/deny invitation, church-group join/create, audit
  log write, member removal, invitation reminders, guest invitation flow) — these
  bypass RLS by design; confirm each performs its own authorization.
- Guest-role scoping: `lib/invitations/guest-access.ts`.
- IDOR on `[id]` route params — whether handlers scope by `church_group_id` or rely
  on RLS to do it.
- `scripts/check-service-role.mjs` guard + `lib/supabase/client.ts`
  (anon key only; `getAnonSupabaseClient` used only on the no-session paths).
- `app/api/_examples/admin-only/**` — an example route that ships to production.
- `tests/unit/app/api/auth-matrix.test.ts` as the existing 401/403 matrix evidence.

**A02 — Cryptographic Failures**
- `lib/google-calendar/token-crypto.ts` — AES-256-GCM, random 12-byte IV, auth tag
  verified on decrypt, 32-byte key length enforced.
- HSTS header in `next.config.ts`; Vercel's HTTP→HTTPS redirect (per
  `documentation/infrastructure-security.md` §2).
- R2 presigned URL expiry (`lib/r2/client.ts`, `SIGNED_URL_EXPIRY_SECONDS`).
- Invitation `response_token` generation/lookup
  (`supabase/migrations/20260712000002_get_invitation_by_token_rpc.sql`, the
  `respond/[token]` route) — entropy, expiry, single-use.
- `app/api/cron/invitation-reminders/route.ts` line 25: the `CRON_SECRET` bearer is
  compared with `!==`, i.e. **not** constant-time. Assess and record explicitly.
- Secrets handling: `.env.example` holds placeholders only;
  `scripts/check-git-secrets.mjs` scans full history.
- PRD §25.6's "chat messages encrypted at rest" is Phase 2 — note as out of scope.

**A03 — Injection**
- No raw SQL or template-string SQL built from user input anywhere in `app/` or
  `lib/` (all DB access goes through the Supabase PostgREST client or `.rpc()` with
  bound params) — state how you verified this (grep terms used).
- `escapePostgrestFilterValue` (`lib/api/postgrest.ts`) and its call site in the
  songs search handler; `tests/unit/app/api/songs-search-injection-tester-supplement.test.ts`.
- Zod coverage of bodies/query/params across `schemas/**`, including the max-length
  caps added by #77.
- XSS: React auto-escaping plus a grep for `dangerouslySetInnerHTML` (report the
  result of the grep).
- iCal injection / CRLF field escaping in `lib/ical/generate.ts`.
- SMS/email template construction (`lib/scheduling/reminder.ts`,
  `lib/resend/client.ts`, `lib/pingram/client.ts`).
- Open-redirect / `state` handling in `lib/google-calendar/oauth.ts` and
  `app/api/google-calendar/callback/**`.

**A05 — Security Misconfiguration**
- CSP directives (`lib/security/csp.ts`, applied in `middleware.ts`) and the HSTS
  header — cross-reference `documentation/infrastructure-security.md` §3 rather than
  restating the whole directive table.
- Error responses do not leak internals: `lib/api/errors.ts`, `lib/api/response.ts`
  (generic `"Internal error"` / `ErrorCode.INTERNAL`).
- Publicly reachable 501 stub routes: all four `app/api/webhooks/*/route.ts` and the
  four `app/api/notifications/**` stubs return `notImplemented(...)` and touch
  nothing.
- `app/api/_examples/**` shipping in the production bundle.
- Dependency posture: `.github/dependabot.yml`, `bun audit` in CI, the
  `overrides` block in `package.json`.
- `next.config.ts` — note that `poweredByHeader` is not disabled (Next emits
  `X-Powered-By` by default). Assess and record.
- `.env.example` contains placeholders only; no default/committed credentials.

**A07 — Identification and Authentication Failures**
- Clerk owns password policy, session management, and MFA (`@clerk/nextjs`);
  `middleware.ts` calls `auth.protect()` on every non-public route.
- Rate limiting (`lib/api/rate-limit.ts`): the `auth` tier and which paths map to it
  via `resolveTier`; the 429 + `Retry-After` shape.
- The store is **in-memory and per-instance** (`lib/api/rate-limit.ts` lines 26–33,
  123) — on serverless this is not a global count. Assess its anti-brute-force
  value and record.
- `getRequestIdentifier`'s documented trust assumption about `x-forwarded-for`.
- `CRON_SECRET` bearer auth on `app/api/cron/invitation-reminders/route.ts`.
- `lib/api/webhook-verify.ts`: all four verifiers throw "not implemented"; the
  routes that would call them are 501 stubs, so no unsigned payload is processed
  today. Record the pre-launch condition for #5/#58/#59 (PRD §25.7 requires
  signature verification before those webhooks go live).
- Invitation/guest token flows as an alternate authentication path
  (`app/api/invitations/respond/[token]/route.ts`,
  `app/api/invitations/guest/claim/route.ts`).

### 2. `scripts/check-owasp-review.mjs` (mechanical launch gate — satisfies AC4)

Copy the shape of `scripts/check-service-role.mjs`: `#!/usr/bin/env node`, ESM,
`node:fs`/`node:path`/`node:url` only, no dependencies, header comment naming the
issue and PRD section, `console.error` per violation, `process.exit(1)` on any
violation, a single `OK: …` line and `process.exit(0)` when clean.

Interface:

```
node scripts/check-owasp-review.mjs [pathToReviewDoc]
```

- `pathToReviewDoc` is optional; it exists so the Jest test can point the script at
  fixture files. Default:
  `<repo root>/documentation/owasp-top-10-review.md`, resolved from the script's own
  location via `fileURLToPath(import.meta.url)` exactly like `check-service-role.mjs`
  computes `REPO_ROOT`.

Constants to export-by-convention (module-level `const`s; the script is not
imported, so no `export` is required):

```js
const REQUIRED_CATEGORIES = ["A01", "A02", "A03", "A05", "A07"];
const SEVERITIES = ["Critical", "High", "Medium", "Low", "Info"];
const STATUSES = ["Resolved", "Accepted", "Deferred", "Open"];
const BLOCKING_SEVERITIES = ["Critical", "High"];
```

Behavior — exit 1 with a specific message for each of these:

1. The review doc does not exist or is empty.
2. Any of `REQUIRED_CATEGORIES` has no `## ` heading whose text contains
   `A01:2021` … `A07:2021` (match on the `A0N:2021` token, not the full title).
3. A required category section contains no findings table, or its table has zero
   data rows (header + separator only).
4. A findings table has an unexpected column count (must be 6 cells per data row
   after splitting on unescaped `|` and trimming the leading/trailing empties).
5. A row's `Severity` is not in `SEVERITIES`, or `Status` is not in `STATUSES`
   (case-sensitive — catches typos).
6. A row's `ID` does not start with the enclosing section's category prefix
   (e.g. an `A02-3` row inside the A01 section).
7. **The gate:** any row with `Severity` in `BLOCKING_SEVERITIES` and
   `Status !== "Resolved"`, or any row with `Status === "Open"` at any severity.
   The error message must name the finding ID, severity, status, and summary.

Clean output message: `OK: OWASP review complete — N findings, 0 blocking.`

Parsing notes:
- Section boundaries: a section runs from its `## ` heading to the next `## `
  heading (or EOF). `### ` sub-headings do **not** end a section.
- Only parse tables whose header row's first cell is exactly `ID` — this makes the
  scan-results table in section 2 and any other table invisible to the parser.
- Section 8's consolidated table lives outside the five category sections, so it is
  not parsed (avoids double-counting the same finding).

### 3. `tests/unit/scripts/check-owasp-review.test.ts`

Copy the integration-style pattern of `tests/unit/scripts/check-git-secrets.test.ts`:
resolve `SCRIPT_PATH` with `path.resolve(__dirname, "../../../scripts/check-owasp-review.mjs")`,
run it with `spawnSync("node", [SCRIPT_PATH, fixturePath], { encoding: "utf8" })`,
write fixtures into `fs.mkdtempSync(path.join(os.tmpdir(), "check-owasp-review-"))`,
and clean them up in `afterEach`.

Required cases (at minimum):
- A minimal well-formed doc with all five categories, each with a single
  `A0N-0 | Info | Resolved` row → exit 0, stdout contains `OK:`.
- The real `documentation/owasp-top-10-review.md` (no path arg, default resolution)
  → exit 0.
- A doc missing the A05 section → exit 1, stderr names `A05`.
- A `High` + `Deferred` row → exit 1, stderr names the finding ID.
- A `Low` + `Open` row → exit 1 (Open blocks at any severity).
- A row with `Severity` = `high` (wrong case) → exit 1.
- A category section whose findings table has zero data rows → exit 1.
- A nonexistent doc path → exit 1.

## Files to modify

### 4. `package.json`

Add to `scripts`, immediately after `"check:git-secrets"` (keep the existing
`check:*` grouping and ordering style):

```json
"check:owasp": "node scripts/check-owasp-review.mjs"
```

### 5. `.github/workflows/ci.yml`

In the `checks` job, add one step after the existing
`- run: bun run check:workflows` step (line 26):

```yaml
      - run: bun run check:owasp
```

Do not touch any other job.

### 6. `README.md`

Under `## Environments`, after the existing
`documentation/infrastructure-security.md` paragraph (lines 11–12), add a matching
two-line paragraph linking
[`documentation/owasp-top-10-review.md`](documentation/owasp-top-10-review.md)
described as the Phase 1 pre-launch OWASP Top 10 manual review. Match the existing
sentence style exactly.

## Code changes

**Default: none.** This is a review issue. The only permitted application-code
change is a *minimal* fix for a finding the review rates `Critical` or `High`, and
only when the fix is small and self-contained. In that case:

- Make the fix, add/extend the matching unit test, and record the finding as
  `Resolved` with the fix described in the `Resolution` column and the changed file
  named in `Evidence`.
- If a `Critical`/`High` finding cannot be fixed small and self-contained, record it
  as `Open`, let `bun run check:owasp` fail, and say so plainly in
  `.pipeline/changes.md`. A failing gate is the correct, intended outcome — do not
  downgrade a severity or flip a status to make the check pass.
- Medium/Low findings are recorded as `Accepted` (with reasoning) or `Deferred`
  (naming the follow-up work); do **not** fix them in this PR.

## Edge cases the implementation must handle

1. `bun audit --audit-level=high` returning a non-zero exit or advisories — record
   truthfully, escalate to an A05 `High` finding, do not upgrade dependencies here.
2. `pip-audit` — must be recorded as N/A **with evidence**, never silently omitted.
3. A category with genuinely no issues still needs the `A0N-0 / Info / Resolved`
   row; the parser rejects an empty table.
4. Markdown table cells must not contain a raw `|` (escape as `\|`) — pipes inside
   a `Summary`/`Evidence` cell would break both rendering and the parser.
5. The parser must not be confused by the section-2 scan table, the section-8
   consolidated table, or the doc's own prose mentioning `A01:2021` outside a
   heading.
6. `### ` sub-headings must not terminate a `## ` section during parsing.
7. Severity/Status matching is case-sensitive; a lowercase value is a violation, not
   a silent pass.
8. The default doc path must resolve from the script's own location, not `cwd`, so
   the check works from any directory and inside a worktree.
9. `prettier --check .` covers markdown — the new doc and any tables must be
   Prettier-clean (`bun run format:check` must pass).
10. The new script lives under `scripts/`, which is **not** in `next.config.ts`'s
    `eslint.dirs` list; `bun run lint` still runs `eslint .` at the repo root, so
    keep the file lint-clean in the same style as the other `scripts/*.mjs`.

## Patterns to follow (name the file, copy the style)

| What | Copy from |
| ---- | --------- |
| Documentation structure, tone, checklists, "run recorded for this issue" table | `documentation/infrastructure-security.md` |
| Guard-script structure, exit codes, `OK:` output, `REPO_ROOT` resolution | `scripts/check-service-role.mjs` |
| Subprocess-based test for a `scripts/*.mjs` guard, tmpdir fixtures, cleanup | `tests/unit/scripts/check-git-secrets.test.ts` |
| `check:*` script naming in `package.json` | existing `check:service-role` / `check:workflows` / `check:git-secrets` |
| CI step placement/format | `.github/workflows/ci.yml`, `checks` job |
| Doc link paragraph | `README.md` `## Environments` section |

## Verification before finishing

Run all of these and report the results in `.pipeline/changes.md`:

```
bun run lint
bun run typecheck
bun run test
bun run format:check
bun run check:owasp
bun audit --audit-level=high
```

## Out of scope (do not do)

- Third-party penetration testing (explicitly excluded by the issue).
- Re-doing #76 / #77 / #78 work, or tuning rate-limit numbers, Zod schemas, or CSP
  directives.
- Implementing the webhook signature verifiers (`lib/api/webhook-verify.ts`) — those
  belong to #5 / #58 / #59.
- Dependency upgrades.
- OWASP categories A04, A06, A08, A09, A10 (the AC names five; note the exclusion in
  section 1, do not review them).
- Any change to `.github/workflows/invitation-reminders-cron.yml`, `supabase/**`, or
  existing route handlers (subject to the narrow "Code changes" exception above).
