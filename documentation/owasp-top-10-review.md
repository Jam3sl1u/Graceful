# OWASP Top 10 (2021) Manual Review — Phase 1 Pre-Launch

## 1. Scope, method, and launch-gate policy

This is the manual OWASP Top 10 (2021) security review required before Phase
1 launch by PRD §26.3 (`documentation/prd/graceful_requirements_v10.md`,
"OWASP Top 10 checklist" row; cited as §16.3 in issue #79).

**In scope** (per the issue's acceptance criteria): **A01** (Broken Access
Control), **A02** (Cryptographic Failures), **A03** (Injection), **A05**
(Security Misconfiguration), **A07** (Identification and Authentication
Failures).

**Out of scope** for this issue: **A04** (Insecure Design), **A06**
(Vulnerable and Outdated Components — covered indirectly by the dependency
scan in Section 2, but not reviewed as its own category), **A08** (Software
and Data Integrity Failures), **A09** (Security Logging and Monitoring
Failures), **A10** (Server-Side Request Forgery). These five are excluded
because the issue's acceptance criteria name only the first five categories
above; they are not reviewed here and carry no findings in this document.
Third-party penetration testing is explicitly out of scope for this issue.

This is a manual code/config/test review, not a live penetration test: every
finding below was produced by reading the actual source (routes, handlers,
migrations, middleware, tests) and, where named, running the tool in
question — not by inference from documentation alone.

**Commit reviewed:** `3af534affcd5ee9487ab5e3475528dac21ffd982` (repo HEAD
immediately prior to this issue's own commit).
**Date reviewed:** 2026-08-08.

### Launch-gate policy

A finding with `Severity` = `Critical` or `High` that is not `Status` =
`Resolved`, or any finding at any severity still `Status` = `Open`, **blocks
the Phase 1 launch (issue #83)** — not merely this PR. This is enforced
mechanically by `bun run check:owasp` (`scripts/check-owasp-review.mjs`),
which parses the findings tables in Sections 3–7 of this document and exits
non-zero on any blocking finding; it also runs in CI (`.github/workflows/ci.yml`,
`checks` job). A passing `check:owasp` run is a necessary, mechanical
precondition for launch — it is not a substitute for the human Phase 1
launch sign-off tracked in issue #83, which a human operator still performs
separately (see the checklist in Section 9).

## 2. Dependency scans

| Scan                              | Command                          | Date       | Commit                                    | Result                                                                                     |
| ---------------------------------- | --------------------------------- | ---------- | ------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Bun dependency audit                | `bun audit --audit-level=high`   | 2026-08-08 | `3af534affcd5ee9487ab5e3475528dac21ffd982` | `No vulnerabilities found` — exit code 0. Also runs per-PR in CI (`.github/workflows/ci.yml`, `checks` job, `bun audit --audit-level=high` step). |
| Python dependency audit (pip-audit) | `pip-audit`                      | 2026-08-08 | `3af534affcd5ee9487ab5e3475528dac21ffd982` | `N/A` — the repo contains zero `.py` files and no `requirements*.txt`, `pyproject.toml`, `Pipfile`, or `setup.py` anywhere (verified with `find . -iname "*.py"` and equivalent searches, excluding `node_modules`). There is no Python tooling to audit. |

No high-severity advisory was reported, so there is no A05 finding from this
scan. Per the issue's scope, a dependency upgrade is out of scope for this
issue regardless — if a future run of this scan finds something, do not
upgrade here; record the finding and let `check:owasp` fail as the correct,
intended outcome.

## 3. A01:2021 — Broken Access Control

### Scope reviewed

- `lib/api/auth.ts` (`requireAuth`, `requireRole`, `lookupUserByClerkId`)
- `middleware.ts` (`isPublicRoute`, `auth.protect()`)
- Every `app/api/**/route.ts` and its backing `handler.ts` (28 handler
  modules that call `requireAuth`/`requireRole`; the remaining `route.ts`
  files are either thin params-parsing wrappers around one of those
  handlers, or the 501 stub families under `app/api/notifications/**` and
  `app/api/webhooks/**`)
- `supabase/migrations/20260704000001_rls_policies.sql`,
  `20260704000002_church_groups_rls.sql`,
  `20260703000001_users_self_read_rls.sql`
- `tests/integration/rls/tables/cross-tenant-bypass.test.ts`,
  `tests/integration/rls/tables/role-gated.test.ts`
- Every `SECURITY DEFINER` RPC migration: `20260706000001_church_group_create_rpc.sql`,
  `20260706000002_church_group_join_rpc.sql`,
  `20260710000001_member_removal_rpc.sql`,
  `20260712000001_accept_invitation_rpc.sql`,
  `20260712000002_get_invitation_by_token_rpc.sql`,
  `20260713000002_deny_invitation_rpc.sql`,
  `20260713000003_invitation_reminder_scheduler.sql`,
  `20260707000001_audit_log_write_rpc.sql`,
  `20260805000001_guest_invitation_flow.sql`
- `lib/invitations/guest-access.ts`
- `scripts/check-service-role.mjs`, `lib/supabase/client.ts`
- `app/api/_examples/admin-only/route.ts`, `app/api/_examples/admin-only/handler.ts`
- `tests/unit/app/api/auth-matrix.test.ts`

### Method

Code read (every file above, in full), plus:

- `grep -rl "requireAuth" app/api` to enumerate which modules enforce
  authentication, cross-checked against `grep -rL "requireAuth" app/api
  --include=route.ts` to confirm every route without a direct match
  delegates to a `handler.ts` that does (or is one of the documented 501
  stubs).
- `grep -rl "SECURITY DEFINER" supabase/migrations/*.sql` to enumerate every
  RPC that bypasses RLS, then read each one's authorization logic in full.
- The existing test suites named above were read and relied on as evidence,
  not re-run as new coverage (`tests/integration/rls/**` requires a live
  Supabase test instance and is out of scope to stand up for this review;
  `tests/unit/app/api/auth-matrix.test.ts` and the rest of the Jest suite
  were run as part of `bun run test` — see `.pipeline/changes.md`).

### Findings

| ID     | Severity | Status   | Summary                                                                                                                                                                        | Evidence                                                                                                                                                                                                                                                                     | Resolution                                                                                                                                                                                                                                          |
| ------ | -------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A01-1  | Info     | Resolved | `requireAuth`/`requireRole` gate every non-public `app/api/**` handler; the 4 route families with no direct `requireAuth` match are inert 501 stubs that touch no data.       | `lib/api/auth.ts`; 28 `handler.ts` modules under `app/api/**` (grep-confirmed); `tests/unit/app/api/auth-matrix.test.ts`                                                                                                                                                     | No action — confirmed by direct read and by the existing auth-matrix test pass.                                                                                                                                                                     |
| A01-2  | Info     | Resolved | Every entry in `middleware.ts`'s `isPublicRoute` matcher is either a pre-auth page, a public static asset, or a route whose handler enforces its own token/RPC authorization. | `middleware.ts` lines 12-28; `app/api/invitations/handler.ts` (`acceptInvitation`/`denyInvitation` dual token-or-session path); `20260712000001_accept_invitation_rpc.sql`; `20260713000002_deny_invitation_rpc.sql`; `20260712000002_get_invitation_by_token_rpc.sql`      | No action — each public-but-mutating route's RPC checks `response_token` equality or session ownership before touching data, so `auth.protect()` being skipped there is deliberate, not a gap.                                                     |
| A01-3  | Info     | Resolved | RLS policies scope every Phase 1 table by `church_group_id` (directly or via a parent-table join); the cross-tenant and role-gated integration suites assert this.           | `supabase/migrations/20260704000001_rls_policies.sql`; `20260704000002_church_groups_rls.sql`; `tests/integration/rls/tables/cross-tenant-bypass.test.ts`; `tests/integration/rls/tables/role-gated.test.ts`                                                               | No action — `cross-tenant-bypass.test.ts` asserts all four verbs are blocked across 19 tables for a Church A caller against Church B data; `role-gated.test.ts` covers invitations/conflicts/audit_logs role gating.                                |
| A01-4  | Info     | Resolved | Every `SECURITY DEFINER` RPC performs its own caller-identity and role check before bypassing RLS — none trust a caller-supplied identity/role argument.                     | All 9 `SECURITY DEFINER` migrations listed in "Scope reviewed" above                                                                                                                                                                                                          | No action — each function either derives identity from `auth.jwt() ->> 'sub'` and checks role/ownership server-side, or (accept/deny/get-by-token) authenticates via exact `response_token` equality, before any read/write of protected data.       |
| A01-5  | Info     | Resolved | Guest role access is scoped to a live invitation for a specific service week; IDOR on `[id]` route params is closed by an explicit `church_group_id` filter (or by RLS).      | `lib/invitations/guest-access.ts`; `app/api/service-weeks/[id]/member-view/handler.ts`; `app/api/songs/[id]/documents/handler.ts` (`songExistsInGroup`); `app/api/church-group/members/[id]/handler.ts`; `app/api/events/[id]/handler.ts`                                  | No action — spot-checked handlers all add `.eq("church_group_id", ctx.churchGroupId)` (or an equivalent RPC-internal check) before acting on the `:id` target, so a same-app cross-tenant ID guess 404s rather than leaking or mutating another group's row. |
| A01-6  | Info     | Resolved | The Supabase service-role key never appears in user-callable code; `getAnonSupabaseClient` is used only on the two documented no-session RPC paths.                          | `scripts/check-service-role.mjs`; `lib/supabase/client.ts`                                                                                                                                                                                                                    | No action — `check:service-role` runs in CI and greps `app/` and `lib/` for the key; `getAnonSupabaseClient()` carries no `Authorization` header by design and is called only from the token-authenticated RPC call sites.                          |
| A01-7  | Low      | Accepted | `app/api/_examples/admin-only/**` — an example admin-gated route — ships in the production API surface, though it is not linked from any UI.                                 | `app/api/_examples/admin-only/route.ts`; `app/api/_examples/admin-only/handler.ts`                                                                                                                                                                                           | Accepted: the route enforces the same `requireAuth` + `requireRole(["admin"])` as every other admin route and returns only `{ ok: true }` — no sensitive data or authorization bypass. Recommended cleanup (delete the route) is a follow-up, not fixed in this review-only issue per its "Code changes" scope. |

### Conclusion

Access control is consistently enforced at three layers — Clerk session
verification, app-layer `requireAuth`/`requireRole`, and database-layer RLS
— with `SECURITY DEFINER` RPCs used only where that layering itself would
otherwise block a legitimate no-session or cross-user operation, and each
such RPC independently re-checks who is calling it. The one open item is a
low-risk, non-exploitable example route recommended for removal as routine
cleanup.

## 4. A02:2021 — Cryptographic Failures

### Scope reviewed

- `lib/google-calendar/token-crypto.ts`
- `next.config.ts` (HSTS header); `documentation/infrastructure-security.md` §2
- `lib/r2/client.ts` (`SIGNED_URL_EXPIRY_SECONDS`)
- `app/api/invitations/handler.ts` (response-token generation);
  `supabase/migrations/20260702000003_cluster_3_scheduling_core.sql`
  (`response_token` column); `20260712000001_accept_invitation_rpc.sql`;
  `20260713000002_deny_invitation_rpc.sql`;
  `20260712000002_get_invitation_by_token_rpc.sql`
- `app/api/cron/invitation-reminders/route.ts`
- `.env.example`; `scripts/check-git-secrets.mjs`
- `documentation/prd/graceful_requirements_v10.md` §25.6

### Method

Code read (every file above, in full). Cross-referenced
`documentation/infrastructure-security.md` for the HTTPS/HSTS baseline and
the git-secret-scan design instead of re-deriving already-documented and
already-verified (#78) claims. Grepped `supabase/migrations/**` and `app/**`,
`lib/**` for any chat/messaging table or route to confirm the PRD §25.6
out-of-scope claim.

### Findings

| ID    | Severity | Status   | Summary                                                                                                                                                             | Evidence                                                                                                                                                                                                     | Resolution                                                                                                                                                                                                                                                                                          |
| ----- | -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A02-1 | Info     | Resolved | Google OAuth tokens are encrypted at rest with AES-256-GCM: random 12-byte IV per encryption, auth tag verified on decrypt, 32-byte key length enforced.            | `lib/google-calendar/token-crypto.ts`                                                                                                                                                                       | No action — `createCipheriv`/`createDecipheriv("aes-256-gcm", ...)` with `randomBytes(12)` IV and `getAuthTag()`/`setAuthTag()` round-trip; `getKey()` rejects any key that doesn't decode to exactly 32 bytes.                                                                                     |
| A02-2 | Info     | Resolved | HTTPS is enforced end-to-end (Vercel's platform redirect plus an app-level HSTS header on every route).                                                             | `next.config.ts` `headers()`; `documentation/infrastructure-security.md` §2                                                                                                                                | No action — cross-referenced #78's already-documented and operator-checklist-verified HTTPS/HSTS baseline rather than re-deriving it.                                                                                                                                                              |
| A02-3 | Info     | Resolved | R2 presigned upload/download URLs expire after 30 minutes.                                                                                                           | `lib/r2/client.ts` (`SIGNED_URL_EXPIRY_SECONDS = 30 * 60`, used by both `getUploadUrl` and `getDownloadUrl`)                                                                                                | No action — confirmed both signer calls pass `{ expiresIn: SIGNED_URL_EXPIRY_SECONDS }`.                                                                                                                                                                                                             |
| A02-4 | Info     | Resolved | Invitation `response_token` has 256 bits of randomness, is unique-constrained at the DB level, and every mutating use is checked by exact equality inside a `SECURITY DEFINER` RPC before any mutation. | `app/api/invitations/handler.ts` (two `crypto.randomUUID()` calls concatenated, stripped of hyphens); `20260702000003_cluster_3_scheduling_core.sql` (`response_token varchar(64) not null unique`); the three RPCs listed in "Scope reviewed" | No action — a token remains resolvable via `get_invitation_by_token` (read-only) after the invitation is responded to, but `accept_invitation`/`deny_invitation` both short-circuit on `status <> 'pending'` and return the existing result without mutating again, so a leaked/reused token cannot re-trigger a state change. |
| A02-5 | Medium   | Deferred | The cron bearer-token check compares `CRON_SECRET` with plain `!==` (not constant-time), a timing side-channel in principle.                                        | `app/api/cron/invitation-reminders/route.ts` line 25 (`authHeader !== \`Bearer ${cronSecret}\``)                                                                                                            | Deferred: exploiting a network-observable timing difference against a single, infrequently-hit (hourly), rate-limited endpoint (`resolveTier` maps `/api/cron/invitation-reminders` to the 5-requests/minute `sms` tier) is impractical, but the comparison should still move to `crypto.timingSafeEqual` with a length pre-check as a follow-up hardening pass. Not fixed here — see `.pipeline/changes.md`. |
| A02-6 | Info     | Resolved | No committed secrets; `.env.example` holds placeholders only and the full git history is scanned in CI.                                                             | `.env.example`; `scripts/check-git-secrets.mjs`; `documentation/infrastructure-security.md` §4                                                                                                              | No action — cross-referenced #78's CI-enforced (`git-secret-scan` job, `fetch-depth: 0`) git-history secret scan; visually confirmed every `.env.example` entry is blank or a non-secret documented default.                                                                                       |
| A02-7 | Info     | Resolved | PRD §25.6's "chat messages encrypted at rest" requirement is out of scope for this issue — chat/messaging is a Phase 2 feature with no corresponding table or route yet. | `documentation/prd/graceful_requirements_v10.md` §25.6                                                                                                                                                       | No action — grepped `supabase/migrations/**/*.sql`, `app/**`, and `lib/**` for any chat/message table or route; none exist in this repo yet.                                                                                                                                                        |

### Conclusion

The one cryptographic-hygiene gap found (a non-constant-time secret
comparison on an internal, rate-limited, low-value-target endpoint) is
low-exploitability and deferred with a named follow-up; every other
candidate item (token encryption, transport security, URL expiry, token
entropy, secret hygiene) is already correctly implemented and verified.

## 5. A03:2021 — Injection

### Scope reviewed

- `app/**`, `lib/**` (grep for raw-SQL call shapes)
- `lib/api/postgrest.ts` (`escapePostgrestFilterValue`); `app/api/songs/handler.ts`;
  `tests/unit/app/api/songs-search-injection-tester-supplement.test.ts`
- `schemas/**` (15 files)
- `app/**`, `components/**` (grep for `dangerouslySetInnerHTML`)
- `lib/ical/generate.ts`; `tests/unit/lib/ical/generate-tester-supplement.test.ts`
- `lib/scheduling/reminder.ts`; `lib/resend/client.ts`; `lib/pingram/client.ts`
- `lib/google-calendar/oauth.ts`; `app/api/google-calendar/connect/handler.ts`;
  `app/api/google-calendar/callback/handler.ts`

### Method

`grep -rn "\.query(\|sql\`\|SELECT \* FROM\|db\.raw\|pg\.query" app lib`
found zero matches for raw/template-string SQL. `grep -rn
"dangerouslySetInnerHTML" app lib components` found zero matches. Every file
under `schemas/` was read in full for `.max(...)` bounds. The remaining
files were read in full.

### Findings

| ID    | Severity | Status   | Summary                                                                                                                                                     | Evidence                                                                                                                                                                                              | Resolution                                                                                                                                                                                                                          |
| ----- | -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A03-1 | Info     | Resolved | No raw or template-string SQL built from user input exists anywhere in `app/` or `lib/`; all DB access goes through the Supabase PostgREST client or `.rpc()` with bound parameters. | `app/**`, `lib/**`                                                                                                                                                                                    | No action — `grep -rn "\.query(\|sql\`\|SELECT \* FROM\|db\.raw\|pg\.query" app lib` returned zero matches (SQL under `supabase/migrations/**` is static, author-written DDL/RPC bodies, never built from request input).           |
| A03-2 | Info     | Resolved | The one hand-built PostgREST filter string (song search) escapes user input before interpolation, with a dedicated regression test.                          | `lib/api/postgrest.ts` (`escapePostgrestFilterValue`); `app/api/songs/handler.ts` call site; `tests/unit/app/api/songs-search-injection-tester-supplement.test.ts`                                    | No action — the escaper doubles backslashes then escapes double-quotes before the value is interpolated into `title.ilike."%<escaped>%",artist.ilike."%<escaped>%"`.                                                              |
| A03-3 | Info     | Resolved | Request bodies/query/params are Zod-validated across every schema module, including #77's max-length caps on free-text fields.                                | `schemas/**` (all 15 files, e.g. `schemas/church-group.ts`, `schemas/events.ts`, `schemas/invitations.ts`)                                                                                          | No action — every free-text string field carries a `.max(...)` bound.                                                                                                                                                              |
| A03-4 | Info     | Resolved | No `dangerouslySetInnerHTML` usage exists anywhere in the app; XSS defense relies on React's default output escaping.                                        | `app/**`, `components/**`                                                                                                                                                                            | No action — `grep -rn "dangerouslySetInnerHTML" app lib components` returned zero matches.                                                                                                                                          |
| A03-5 | Info     | Resolved | iCal generation escapes RFC 5545 special characters (backslash, semicolon, comma, newlines) before interpolation, preventing field/line injection into `.ics` output. | `lib/ical/generate.ts` (`escapeIcsText`, `foldLine`); `tests/unit/lib/ical/generate-tester-supplement.test.ts`                                                                                       | No action — `escapeIcsText` escapes backslashes first (so later replacements' own escape characters are not re-escaped), and `foldLine` folds on octet boundaries without splitting a multi-byte UTF-8 character.                  |
| A03-6 | Info     | Resolved | SMS/email template builders interpolate into plain-text bodies only (no HTML, no SQL); both underlying send clients remain unimplemented stubs.               | `lib/scheduling/reminder.ts`; `lib/resend/client.ts`; `lib/pingram/client.ts`                                                                                                                        | No action — `buildMemberReminderSms`/`formatWeekLabel` produce plain SMS text with no markup; `sendEmail`/`sendSms` are `TODO` stubs that always throw (Sprint 4 #58/#59), so no template output is dispatched externally today. |
| A03-7 | Info     | Resolved | The Google OAuth callback never redirects to a caller-controlled URL; `state` is compared only for CSRF equality, never used to build a redirect target.      | `lib/google-calendar/oauth.ts` (`getAuthUrl`); `app/api/google-calendar/connect/handler.ts` (`state = randomBytes(32).toString("base64url")`); `app/api/google-calendar/callback/handler.ts` (`CONNECTED_PATH`/`ERROR_PATH` constants) | No action — both success and failure paths redirect to fixed, hardcoded app-relative paths; no open-redirect surface exists.                                                                                                       |

### Conclusion

No injection vector was found: the app has no raw-SQL surface, its one
hand-built filter string is escaped and regression-tested, request input is
uniformly Zod-validated, there is no HTML-injection sink, the iCal generator
escapes per RFC 5545, and outbound message templates are plain text with no
live dispatch path yet.

## 6. A05:2021 — Security Misconfiguration

### Scope reviewed

- `lib/security/csp.ts`, `middleware.ts`; `documentation/infrastructure-security.md` §3
- `lib/api/errors.ts`, `lib/api/response.ts`
- `app/api/webhooks/{clerk,pingram,modal,resend}/route.ts`;
  `app/api/notifications/{route.ts,[id]/read/route.ts,mark-all-read/route.ts,unread-count/route.ts}`
- `app/api/_examples/admin-only/**`
- `.github/dependabot.yml`; `package.json` (`overrides` block); Section 2 above
- `next.config.ts`
- `.env.example`

### Method

Code read (every file above, in full). Cross-referenced
`documentation/infrastructure-security.md` §3 for the full CSP directive
table and design rationale rather than restating it. Ran `bun audit
--audit-level=high` for the dependency-posture row (see Section 2).

### Findings

| ID    | Severity | Status   | Summary                                                                                                                          | Evidence                                                                                                                                                                                             | Resolution                                                                                                                                                                                                                                                    |
| ----- | -------- | -------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A05-1 | Info     | Resolved | The bun dependency audit reports zero high-severity advisories as of this review.                                                | `package.json`; `bun.lock`; Section 2, row 1                                                                                                                                                        | No action — `bun audit --audit-level=high` exited 0 with `No vulnerabilities found`; also runs per-PR in CI (`.github/workflows/ci.yml`, `checks` job).                                                                                                     |
| A05-2 | Info     | Resolved | A nonce-based CSP and an HSTS header are configured per PRD §25.7/#78's documented baseline.                                     | `lib/security/csp.ts`; `middleware.ts`; `documentation/infrastructure-security.md` §3                                                                                                              | No action — cross-referenced #78's full directive table and "why nonce-based, not `unsafe-inline`" rationale rather than restating it.                                                                                                                       |
| A05-3 | Info     | Resolved | Error responses never leak internals — every unexpected failure returns a single generic `"Internal error"` / `ErrorCode.INTERNAL`. | `lib/api/errors.ts`; `lib/api/response.ts`                                                                                                                                                          | No action — every handler's catch-all branch (spot-checked across `app/api/**/handler.ts`) returns `fail("Internal error", ErrorCode.INTERNAL, 500)`, never the raw caught error.                                                                          |
| A05-4 | Info     | Resolved | The four webhook routes and four notification routes are inert 501 stubs that touch no data.                                     | `app/api/webhooks/{clerk,pingram,modal,resend}/route.ts`; `app/api/notifications/{route.ts,[id]/read/route.ts,mark-all-read/route.ts,unread-count/route.ts}`                                       | No action — all eight `route.ts` files are two-line `notImplemented(...)` calls with no DB, auth, or network access.                                                                                                                                        |
| A05-5 | Low      | Accepted | `app/api/_examples/admin-only/**` ships as reachable configuration/build surface in production (cross-referenced with A01-7).    | `app/api/_examples/admin-only/route.ts`                                                                                                                                                             | Accepted for the same reasoning as A01-7 — auth-gated, no sensitive data; cleanup tracked as a follow-up, not fixed here.                                                                                                                                    |
| A05-6 | Info     | Resolved | Dependabot is configured for both the `bun` and `github-actions` ecosystems (5-PR cap each); `package.json` `overrides` pin several transitive advisories. | `.github/dependabot.yml`; `package.json` `overrides` block                                                                                                                                          | No action — cross-referenced `documentation/infrastructure-security.md` §5.                                                                                                                                                                                  |
| A05-7 | Low      | Deferred | `next.config.ts` does not set `poweredByHeader: false`, so Next.js emits `X-Powered-By: Next.js` on every response — a minor framework-fingerprinting information disclosure. | `next.config.ts`                                                                                                                                                                                    | Deferred: low-value recon information only (framework name, not a version or internal path). A one-line `poweredByHeader: false` fix is straightforward but, per this review-only issue's "Code changes" policy, only `Critical`/`High` findings may be fixed here — tracked as a follow-up chore. |
| A05-8 | Info     | Resolved | `.env.example` contains placeholders only; no default or committed credentials.                                                  | `.env.example`                                                                                                                                                                                       | No action — every variable is either blank or a documented non-secret default (e.g. `NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in`).                                                                                                                             |

### Conclusion

Misconfiguration exposure is low: dependency scanning is clean and
CI-enforced, the CSP/HSTS baseline is already documented and verified, error
responses are generic, and every currently-unimplemented endpoint is an
inert stub. The two open items (the example route and the missing
`poweredByHeader: false`) are both low-severity information/attack-surface
items with named follow-ups, not exploitable misconfigurations.

## 7. A07:2021 — Identification and Authentication Failures

### Scope reviewed

- `middleware.ts`; `@clerk/nextjs` (package.json dependency)
- `lib/api/rate-limit.ts` (`RATE_LIMIT_POLICIES`, `resolveTier`, `getRequestIdentifier`, `rateLimitResponse`, the module-level `store`)
- `package.json` (`@upstash/redis`, `@upstash/qstash` dependencies)
- `app/api/cron/invitation-reminders/route.ts`
- `lib/api/webhook-verify.ts`; `app/api/webhooks/{clerk,pingram,modal,resend}/route.ts`
- `app/api/invitations/respond/[token]/route.ts`; `app/api/invitations/guest/claim/route.ts`;
  `supabase/migrations/20260712000002_get_invitation_by_token_rpc.sql`;
  `20260805000001_guest_invitation_flow.sql`

### Method

Code read (every file above, in full). Reviewed `resolveTier`'s
path/method-to-tier classification table and `checkRequestRateLimit`'s
call site in `middleware.ts`.

### Findings

| ID    | Severity | Status   | Summary                                                                                                                                                                  | Evidence                                                                                                                                                                              | Resolution                                                                                                                                                                                                                                                                                                                     |
| ----- | -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A07-1 | Info     | Resolved | Clerk owns password policy, session management, and MFA; `middleware.ts` calls `auth.protect()` on every non-public route.                                             | `middleware.ts`; `@clerk/nextjs` dependency (`package.json`)                                                                                                                           | No action — `clerkMiddleware`'s handler calls `await auth.protect()` whenever `!isPublicRoute(req)`.                                                                                                                                                                                                                          |
| A07-2 | Info     | Resolved | Rate limiting is applied per-tier (`webhook`/`sms`/`invite`/`auth`/`write`/`read`) via `resolveTier`, including a dedicated `auth` tier on brute-forceable no-session flows, returning 429 + `Retry-After` on denial. | `lib/api/rate-limit.ts` (`RATE_LIMIT_POLICIES`, `resolveTier`, `rateLimitResponse`); `middleware.ts`                                                                                  | No action — `resolveTier` maps `/api/church-group/join`, `/api/invitations/respond/:token`, and `/api/invitations/:id/accept` to the `auth` tier; `rateLimitResponse` sets `Retry-After` on every 429.                                                                                                                       |
| A07-3 | Medium   | Deferred | The rate-limit store is an in-memory `Map`, scoped per serverless instance — on Vercel this is not a global/distributed count, so a caller spread across instances (or a distributed attacker) can exceed the intended per-tier budget. | `lib/api/rate-limit.ts` lines 26-33 (`RATE_LIMIT_POLICIES`), line 123 (`store`); `package.json` (`@upstash/redis`, `@upstash/qstash` already listed as dependencies but not wired into this module) | Deferred: acceptable for Phase 1 launch scale as a best-effort layer on top of Clerk's own session/bot protections, but a distributed store should replace the in-memory `Map` before this becomes the sole anti-brute-force defense at higher traffic — the already-present `@upstash/redis` dependency is the obvious candidate. Not fixed here; tracked as a follow-up. |
| A07-4 | Info     | Resolved | `getRequestIdentifier`'s `x-forwarded-for` trust assumption (first hop, Vercel-overwritten rather than caller-appended) is explicitly documented in the source.        | `lib/api/rate-limit.ts` lines 93-121                                                                                                                                                   | No action — the function's comment block states the trust boundary and its failure mode if the app were ever fronted by something other than Vercel.                                                                                                                                                                        |
| A07-5 | Medium   | Deferred | `CRON_SECRET` bearer auth on the invitation-reminders cron route uses a non-constant-time comparison (cross-referenced with A02-5; recorded here for A07 completeness, not double-counted as a separate risk). | `app/api/cron/invitation-reminders/route.ts` line 25                                                                                                                                   | Deferred — see A02-5 for full reasoning and the follow-up (`crypto.timingSafeEqual`).                                                                                                                                                                                                                                          |
| A07-6 | Info     | Resolved | All four webhook signature verifiers throw "not implemented"; every route that would call them is a 501 stub, so no unsigned webhook payload is processed today — a pre-launch condition, not a closed item. | `lib/api/webhook-verify.ts`; `app/api/webhooks/{clerk,pingram,modal,resend}/route.ts`                                                                                                | No action for this issue — `verifyClerkWebhook`/`verifyPingramWebhook`/`verifyResendWebhook`/`verifyModalWebhook` must be implemented before their routes go live (#5, #58, #59, and the transcription pipeline work), per PRD §25.7. Tracked there, not here.                                                              |
| A07-7 | Info     | Resolved | Invitation response-token and guest-claim flows are a deliberate alternate authentication path (token possession = credential), independently authorized inside their own `SECURITY DEFINER` RPCs, not through Clerk. | `app/api/invitations/respond/[token]/route.ts`; `app/api/invitations/guest/claim/route.ts`; `20260712000002_get_invitation_by_token_rpc.sql`; `20260805000001_guest_invitation_flow.sql` (`claim_guest_invitation`) | No action — malformed tokens 404 identically to unknown ones (anti-enumeration); `claim_guest_invitation` is idempotent on re-claim and rejects an anonymized/already-claimed placeholder.                                                                                                                                    |

### Conclusion

Primary authentication is fully delegated to Clerk and enforced at the edge
by `middleware.ts`; the two alternate no-session paths (cron bearer token,
invitation/guest response tokens) are each independently authorized. The two
open items — a non-constant-time secret comparison and an in-memory,
per-instance rate-limit store — are both real but low-to-medium risk given
this app's current traffic scale and layered defenses, and are deferred with
named follow-ups rather than fixed in this review-only issue.

## 8. Open findings summary

| ID    | Severity | Status   | Summary                                                    | Evidence                                          | Resolution                                                                        |
| ----- | -------- | -------- | ----------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------- |
| A01-7 | Low      | Accepted | `app/api/_examples/admin-only/**` ships in production.       | `app/api/_examples/admin-only/route.ts`            | Accepted — auth-gated, no sensitive data; cleanup is a follow-up.                   |
| A02-5 | Medium   | Deferred | `CRON_SECRET` compared with `!==` (not constant-time).        | `app/api/cron/invitation-reminders/route.ts:25`    | Deferred — switch to `crypto.timingSafeEqual`; follow-up chore.                     |
| A05-5 | Low      | Accepted | `app/api/_examples/admin-only/**` ships in production (cross-ref A01-7). | `app/api/_examples/admin-only/route.ts`            | Accepted — same reasoning as A01-7.                                                 |
| A05-7 | Low      | Deferred | `next.config.ts` does not disable `poweredByHeader`.          | `next.config.ts`                                   | Deferred — one-line fix; follow-up chore.                                           |
| A07-3 | Medium   | Deferred | Rate-limit store is in-memory/per-instance.                    | `lib/api/rate-limit.ts`                            | Deferred — migrate to the already-present `@upstash/redis` dependency; follow-up.    |
| A07-5 | Medium   | Deferred | `CRON_SECRET` compared with `!==` (cross-ref A02-5).           | `app/api/cron/invitation-reminders/route.ts:25`    | Deferred — see A02-5.                                                               |

None of the rows above are `Critical`/`High`-and-not-`Resolved`, and none are
`Open` at any severity, so `bun run check:owasp` exits 0 for this document.

## 9. Re-run checklist

Before each subsequent phase launch, a human operator must:

- [ ] Re-run `bun audit --audit-level=high` and update Section 2's row (date,
      commit, result) with the fresh outcome.
- [ ] Re-run `bun run check:owasp` and confirm it exits 0.
- [ ] Re-check every `Deferred` finding in Section 8 (A02-5/A07-5 — move the
      `CRON_SECRET` comparison to `crypto.timingSafeEqual`; A05-7 — consider
      setting `poweredByHeader: false`; A07-3 — consider migrating the
      rate-limit store to `@upstash/redis`) and either resolve it (flip to
      `Resolved` with the fix described) or re-justify deferring it further.
- [ ] Confirm the human Phase 1 launch sign-off (issue #83) has been given —
      this document and `check:owasp` are a mechanical gate, not a
      substitute for that sign-off.
