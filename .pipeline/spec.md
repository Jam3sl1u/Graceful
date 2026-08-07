# Spec — Issue #78: [Sprint 4] Run infrastructure security pass (HTTPS, CSP, secret scan)

## OPEN QUESTIONS

**None blocking — do not stop the pipeline.** Two items need a human *action*
(not a decision) after merge; they are recorded in the new documentation file as
operator checklist items and must not block implementation:

1. Vercel's HTTP→HTTPS redirect is platform behavior, not repo code. The
   repo-side deliverable is HSTS + verification steps; a human confirms the
   redirect on the deployed URL.
2. Dependabot must be verified as actually running (GitHub UI → Insights →
   Dependency graph → Dependabot) after `.github/dependabot.yml` lands on the
   default branch. If GitHub reports the config as invalid, that is a follow-up
   fix, not a reason to stall this issue.

## Goal

Add the infrastructure-level security baseline the PRD requires before first
deploy (PRD §25.7 in `documentation/prd/graceful_requirements_v10.md`, cited as
§15.7 in the issue):

1. HTTPS enforced on every route (HSTS header from the app; Vercel does the
   redirect) — no exceptions, including `app/api/**` and webhook routes.
2. Strict, nonce-based CSP: `script-src` limited to `'self'`, a per-request
   nonce, and Clerk's origins. No `'unsafe-inline'` in `script-src`, no
   `'unsafe-eval'` in production.
3. A repeatable git-history secret scan, wired into CI, plus the result of the
   scan run for this issue recorded in documentation.
4. Dependabot config committed to the repo.

Out of scope (do not touch): rate limiting, input validation, anything in
`schemas/`, `supabase/`, or existing route handlers.

## Current state (verified by reading the code)

- `next.config.ts` has **no** `headers()` — zero security headers today.
- `middleware.ts` wraps `clerkMiddleware`, matcher
  `["/((?!_next|.*\\..*).*)", "/(api|trpc)(.*)"]` (covers pages **and** API
  routes; excludes `_next` and dotted static files). The handler currently
  returns nothing.
- No `vercel.json`, no `.github/dependabot.yml` anywhere in the repo.
- `.github/workflows/ci.yml` jobs: `checks`, `check-secrets` (this one only
  detects whether *GitHub Actions secrets* are configured — unrelated to secret
  scanning; do not modify it or reuse its name), `rls-integration`, `e2e`.
- No app code uses `dangerouslySetInnerHTML`, `next/script`, or any external
  script tag (grepped). All client `fetch()` calls are same-origin `/api/...`.
  Supabase and R2 are server-only. R2 presigned downloads are opened as plain
  `<a href target="_blank">` navigations (`app/(app)/member-week/[id]/member-week-view.tsx`),
  which CSP `connect-src`/`img-src` do not govern.
- `app/layout.tsx` wraps everything in `<ClerkProvider>` — Clerk's browser JS is
  the only third-party script.
- Existing guard-script pattern to copy: `scripts/check-service-role.mjs`
  (node builtins only, `REPO_ROOT` via `fileURLToPath(import.meta.url)`, prints
  violations to stderr, `process.exit(1)` on findings / `0` on clean).
  `scripts/check-workflows.mjs` is the pattern for shelling out via
  `execFileSync` from `node:child_process`.
- Jest: `testMatch` is `tests/unit/**/*.test.ts(x)`, `@/` maps to repo root,
  `testEnvironment: "node"`.
- `bun.lock` (text format) is the lockfile; there is no `song2score/` directory
  in this checkout, so Dependabot only needs the root manifest.

---

## 1. `lib/security/csp.ts` (NEW)

Pure, dependency-free module (node/edge-safe). **Do not** `import "server-only"`
here — this module is imported by Edge middleware.

```ts
export function clerkFrontendApiOrigin(publishableKey: string | undefined): string | null;
export function generateNonce(): string;
export function buildContentSecurityPolicy(options: {
  nonce: string;
  clerkOrigin: string | null;
  isDev: boolean;
}): string;
```

### `clerkFrontendApiOrigin(publishableKey)`

A Clerk publishable key is `pk_test_` / `pk_live_` + base64 of the instance's
frontend-API host with a trailing `$` (e.g. decoding yields
`clean-mayfly-62.clerk.accounts.dev$`). Derive the origin from the key rather
than hardcoding a domain — the production domain is not known yet.

- Strip the `pk_test_` or `pk_live_` prefix; any other prefix (or
  `undefined`/empty) → return `null`.
- `atob()` the remainder inside `try/catch`; on throw → `null`.
- Take the decoded string up to the first `$`.
- Validate against `/^[a-z0-9.-]+$/i`; otherwise → `null`.
- Return `` `https://${host}` `` (no trailing slash).

### `generateNonce()`

16 random bytes from `crypto.getRandomValues(new Uint8Array(16))`, base64-encoded
via `btoa(String.fromCharCode(...bytes))`. Must be unique per call. Do not use
`Math.random`.

### `buildContentSecurityPolicy({ nonce, clerkOrigin, isDev })`

Returns a **single-line** header value: directives joined by `"; "`, each
directive `name SP value SP value...`, no trailing `;`, no newlines, no double
spaces. Emit directives in exactly this order:

| Directive | Value |
| --- | --- |
| `default-src` | `'self'` |
| `script-src` | `'self' 'nonce-<nonce>' https://challenges.cloudflare.com` + `clerkOrigin` (when non-null) + `'unsafe-eval'` **only when `isDev`** |
| `style-src` | `'self' 'unsafe-inline'` |
| `img-src` | `'self' data: blob: https://img.clerk.com` |
| `font-src` | `'self' data:` |
| `connect-src` | `'self' https://clerk-telemetry.com` + `clerkOrigin` (when non-null) + `ws:` **only when `isDev`** |
| `worker-src` | `'self' blob:` |
| `frame-src` | `'self' https://challenges.cloudflare.com` |
| `object-src` | `'none'` |
| `base-uri` | `'self'` |
| `form-action` | `'self'` |
| `frame-ancestors` | `'none'` |
| `upgrade-insecure-requests` | present with no value, **omitted when `isDev`** |

Rationale to keep in a comment at the top of the file: `challenges.cloudflare.com`
and `img.clerk.com` are Clerk's own documented CSP requirements (bot-protection
widget and avatar CDN), so they fall under "self and Clerk";
`style-src 'unsafe-inline'` is required by Next/Clerk injected styles and is
explicitly *not* prohibited by the AC (which prohibits inline **scripts** and
`eval`).

Edge cases the implementation must handle:

- `clerkOrigin === null` → the Clerk token is simply absent from `script-src` /
  `connect-src`; no `undefined`, no empty token, no stray double space.
- `isDev === false` → the string must contain neither `'unsafe-eval'` nor `ws:`.
- Nonce is embedded exactly as `'nonce-<value>'` (single quotes, no spaces).

## 2. `middleware.ts` (MODIFY)

Keep `isPublicRoute`, the `clerkMiddleware` wrapper, the auth behavior, and the
exported `config` matcher exactly as they are. Add CSP emission inside the
existing handler:

1. `const nonce = generateNonce();`
2. `const csp = buildContentSecurityPolicy({ nonce, clerkOrigin: clerkFrontendApiOrigin(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY), isDev: process.env.NODE_ENV !== "production" });`
3. Keep the existing `if (!isPublicRoute(req)) await auth.protect();`.
4. Build `const requestHeaders = new Headers(req.headers);` and
   `requestHeaders.set("content-security-policy", csp);` — Next.js reads the
   nonce back out of the **request** CSP header to stamp its own streaming
   inline scripts. This is what makes "no inline scripts" achievable without
   `'unsafe-inline'`.
5. `const res = NextResponse.next({ request: { headers: requestHeaders } });`
   then `res.headers.set("content-security-policy", csp);` and `return res;`
   (`NextResponse` imported from `next/server`).

Notes / edge cases:

- Do **not** set an `x-nonce` header: no app code reads it, and unused surface
  is scope creep here.
- Compute the nonce/CSP before `auth.protect()`, but accept that when
  `auth.protect()` redirects an unauthenticated request it short-circuits and
  that redirect response carries no CSP header. That is fine (empty body) —
  state it in a comment so it doesn't read as a bug.
- Returning a response from the `clerkMiddleware` handler is supported; Clerk
  merges its own headers into the returned response. Do not bypass
  `clerkMiddleware`.

## 3. `next.config.ts` (MODIFY)

Add an `async headers()` returning one entry:

- `source: "/:path*"` (all routes, including `/api/*`)
- header `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`

Keep `reactStrictMode`, `outputFileTracingRoot`, and `eslint.dirs` unchanged. Do
**not** put CSP here — it must be per-request (nonce), which only middleware can
do. Do not add any other headers; anything beyond HSTS + CSP is out of scope for
this issue.

## 4. `scripts/check-git-secrets.mjs` (NEW) + `package.json` script

Follow `scripts/check-service-role.mjs` for structure/exit-code conventions and
`scripts/check-workflows.mjs` for `execFileSync` usage. Node builtins only
(`node:child_process`, `node:path`, `node:url`) — must run without
`bun install`. Add to `package.json` scripts:

```
"check:git-secrets": "node scripts/check-git-secrets.mjs"
```

Behavior, in order:

1. `git rev-parse --is-inside-work-tree` → if it fails, print an error and exit 1.
2. `git rev-parse --is-shallow-repository` → if it prints `true`, print an error
   explaining the scan is meaningless on a shallow clone (CI must use
   `fetch-depth: 0`) and **exit 1**. A shallow scan silently reporting "clean" is
   the main failure mode this guard exists to prevent.
3. Added-line scan: `git log --all --full-history --no-color -p -U0 --pretty=format:__COMMIT__%H`
   via `execFileSync` with `{ encoding: "utf8", maxBuffer: 512 * 1024 * 1024 }`.
   Parse line by line: `__COMMIT__<sha>` updates the current commit; `+++ b/<path>`
   updates the current file; a line starting with `+` that is not `+++` is a
   candidate added line. Test every candidate line against `PATTERNS`.
4. Committed-env-file scan:
   `git log --all --full-history --diff-filter=A --name-only --pretty=format:__COMMIT__%H`.
   Flag any added path whose basename matches `.env` or starts with `.env.`
   **except** `.env.example` (e.g. `.env`, `.env.local`, `.env.production` are
   findings).
5. Print each finding to stderr as
   `<sha> <path> - <patternName>: <redacted>` and exit 1; otherwise print a
   single `OK: ...` line and exit 0.

`PATTERNS` — array of `{ name, regex }`, at minimum:

- Clerk secret key: `/\bsk_(test|live)_[A-Za-z0-9]{20,}/`
- Resend API key: `/\bre_[A-Za-z0-9]{20,}/`
- Google OAuth client secret: `/\bGOCSPX-[A-Za-z0-9_-]{10,}/`
- AWS/R2 access key id: `/\bAKIA[0-9A-Z]{16}\b/`
- Private key block: `/-----BEGIN [A-Z ]*PRIVATE KEY-----/`
- JWT (Supabase anon/service-role keys are JWTs):
  `/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/`
- Assigned secret env var: the names from `.env.example` that hold secrets
  (`SUPABASE_SERVICE_ROLE_KEY`, `CLERK_SECRET_KEY`, `CLERK_WEBHOOK_SECRET`,
  `PINGRAM_API_KEY`, `PINGRAM_WEBHOOK_SECRET`, `RESEND_API_KEY`,
  `RESEND_WEBHOOK_SECRET`, `GOOGLE_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY`,
  `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `UPSTASH_REDIS_REST_TOKEN`,
  `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`,
  `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`, `MODAL_WEBHOOK_SECRET`,
  `SPOTIFY_CLIENT_SECRET`, `CRON_SECRET`, `SUPABASE_JWT_SECRET`) followed by
  `\s*[=:]\s*` and a quoted-or-bare value of 12+ chars from
  `[A-Za-z0-9_\-/+]`.

Two allowlists, each with a `reason` string per entry and a comment explaining
why allowlisting is safe:

- `VALUE_ALLOWLIST`: regexes applied to the **matched text**; seed with obvious
  non-secrets (`/placeholder/i`, `/example/i`, `/changeme/i`, `/^your[-_]/i`,
  `/xxxx/i`).
- `PATH_ALLOWLIST`: exact paths skipped entirely — seed with
  `scripts/check-git-secrets.mjs` (the pattern list would otherwise scan itself)
  and any test file whose path contains `check-git-secrets` (fixtures for it
  will contain fake-secret-looking strings). Nothing else — `.pipeline/**` and
  `documentation/**` must stay in scope, since a pasted real secret there is a
  genuine finding.

**Redaction requirement:** never print a matched secret verbatim. Print the
first 4 characters, then `…`, then `(len=<n>)`. The scanner's own output must not
become a new leak (it lands in CI logs and `.pipeline/*.md`).

## 5. `.github/workflows/ci.yml` (MODIFY)

Add one new top-level job (leave every existing job untouched, especially the
existing `check-secrets` job which is about Actions-secret availability):

```yaml
  git-secret-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0   # full history — a shallow clone makes the scan meaningless
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.2.x
      - run: bun run check:git-secrets
```

No `bun install` step — the script uses node builtins only.

## 6. `.github/dependabot.yml` (NEW)

```yaml
version: 2
updates:
  - package-ecosystem: "bun"
    directory: "/"
    schedule:
      interval: "weekly"
    open-pull-requests-limit: 5
  - package-ecosystem: "github-actions"
    directory: "/"
    schedule:
      interval: "weekly"
    open-pull-requests-limit: 5
```

Add a header comment noting this repo uses Bun exclusively (`bun.lock`), so the
JavaScript ecosystem entry is `bun` — do not switch it to another package
manager's ecosystem, per `AGENTS.md`.

## 7. `documentation/infrastructure-security.md` (NEW)

Follow the house style of `documentation/staging-environment.md`: numbered `##`
sections, tables, and human-operator checklists as `- [ ]` items. Sections:

1. **Purpose & scope** — PRD §25.7, issue #78; what is *not* here (rate
   limiting #76, input validation #77, OWASP review #79).
2. **HTTPS enforcement** — Vercel auto-redirects HTTP→HTTPS on all routes incl.
   `/api/*` and webhooks (platform behavior, no repo config); the app also sends
   HSTS from `next.config.ts`. Operator checklist: verify a plain-`http://`
   request to the deployed app, to one `/api/` route, and to a webhook path each
   returns a 3xx to `https://`, and that `Strict-Transport-Security` is present
   on the HTTPS response.
3. **Content Security Policy** — where it is set (`middleware.ts` +
   `lib/security/csp.ts`), the full directive table, why a per-request nonce is
   used instead of `'unsafe-inline'`, the note that nonce-based CSP means pages
   render per-request, the dev-only relaxations (`'unsafe-eval'`, `ws:`) and that
   they are gated on `NODE_ENV`, and that any new third-party script requires a
   deliberate directive change. Pre-launch checklist: run the deployed URL
   through an OWASP/Google CSP evaluator, and click through sign-in, sign-up,
   and one authenticated page with the browser console open to confirm zero CSP
   violations.
4. **Git-history secret scan** — how to run (`bun run check:git-secrets`), what
   it covers, the allowlist policy, the CI job and its `fetch-depth: 0`
   requirement. Record the run performed for this issue: date, the commit SHA
   scanned (`git rev-parse HEAD`), and the result. If there are findings, record
   only the redacted output — never the secret value — and note that remediation
   order is **rotate the credential first, then purge history**.
5. **Dependabot** — what the config covers and the post-merge verification
   checklist item from OPEN QUESTIONS #2.

## 8. `README.md` (MODIFY)

- Add to the Scripts list, matching the existing bullet style:
  `- `bun run check:git-secrets` — scan the full git history for committed secrets`
- Add one line to the "Environments" section (or immediately after it) linking
  to `documentation/infrastructure-security.md` for the HTTPS/CSP/secret-scan
  baseline.

Nothing else in `README.md` changes.

---

## Required verification before finishing

1. `bun run check:git-secrets` — must run against this repo's real history and
   exit 0. **If it exits 1 with a genuine finding, stop: do not rewrite history,
   do not weaken the patterns to make it pass, and do not paste the secret
   anywhere.** Record the redacted output in `.pipeline/changes.md` and flag it
   for the human.
   If it exits 1 on an obvious false positive (a placeholder/fixture value), add
   a narrowly-scoped `VALUE_ALLOWLIST` entry with a `reason` and say so in
   `.pipeline/changes.md`.
2. `bun run typecheck`, `bun run lint`, `bun run test`, `bun run format:check`
   all pass.
3. `bun run build` succeeds (catches an invalid `next.config.ts` `headers()`
   shape, which typecheck alone will not).

## Behaviors the tester should be able to verify

These are the seams the implementation must leave testable (unit tests belong in
`tests/unit/lib/security/csp.test.ts`, importing via `@/lib/security/csp`):

- `clerkFrontendApiOrigin`: valid `pk_test_`/`pk_live_` key → `https://<host>`;
  `undefined`, `""`, a non-`pk_` string, and a key whose base64 payload is
  garbage → `null`.
- `generateNonce`: two calls differ; result is valid base64 decoding to 16 bytes.
- `buildContentSecurityPolicy` with `isDev: false`: contains
  `'nonce-<nonce>'` in `script-src`, contains `frame-ancestors 'none'`,
  `object-src 'none'`, `upgrade-insecure-requests`; contains **no**
  `'unsafe-eval'`, no `'unsafe-inline'` inside `script-src`, no `ws:`; is one
  line with no double spaces.
- `buildContentSecurityPolicy` with `isDev: true`: adds `'unsafe-eval'` and
  `ws:`, drops `upgrade-insecure-requests`.
- `buildContentSecurityPolicy` with `clerkOrigin: null`: well-formed output, no
  `undefined`/empty token.
- `check-git-secrets`: exits 0 on the current history; exits 1 (failure case)
  when run against a scratch git repo whose history contains a fake key matching
  one of the patterns; refuses to report clean on a shallow clone.
