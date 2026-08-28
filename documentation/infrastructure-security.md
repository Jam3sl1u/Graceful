# Infrastructure Security Baseline

## 1. Purpose & scope

This document covers the infrastructure-level security baseline required
before first deploy (PRD §25.7 in `documentation/prd/graceful_requirements_v10.md`,
cited as §15.7 in issue #78):

1. HTTPS enforced on every route (HSTS + Vercel's platform-level redirect).
2. A strict, nonce-based Content-Security-Policy.
3. A repeatable git-history secret scan, wired into CI.
4. Dependabot configuration.

**Out of scope here** (tracked as separate issues):

- Rate limiting (#76).
- Input validation (#77).
- The broader OWASP security review (#79).

## 2. HTTPS enforcement

Vercel automatically redirects plain `http://` requests to `https://` for
every route on a deployment, including `/api/*` routes and webhook paths —
this is platform behavior, not something configured in this repo. On top of
that, the app itself sends an HSTS header (`next.config.ts` → `headers()`)
telling browsers to go straight to HTTPS on every subsequent request without
even attempting the plain-HTTP hop first:

```
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
```

**Operator checklist (verify on the deployed URL after this ships):**

- [ ] A plain `http://` request to the deployed app's root returns a 3xx
      redirect to `https://`.
- [ ] A plain `http://` request to one `/api/*` route returns a 3xx redirect
      to `https://`.
- [ ] A plain `http://` request to a webhook path (`/api/webhooks/*`) returns
      a 3xx redirect to `https://`.
- [ ] The `Strict-Transport-Security` header is present on the `https://`
      response for each of the above.

## 3. Content Security Policy

The CSP is built per-request in `middleware.ts`, using the pure helper
functions in `lib/security/csp.ts` (`clerkFrontendApiOrigin`,
`generateNonce`, `buildContentSecurityPolicy`). A fresh nonce is generated on
every request and threaded through to Next.js via the *request* headers
(`content-security-policy` set on `requestHeaders` before
`NextResponse.next()`), which is how Next.js signs its own streaming inline
scripts with that nonce — this is what makes "no inline scripts" achievable
without `'unsafe-inline'` in `script-src`. This only works for routes Next.js
actually renders per-request — Next only signs inline scripts with a nonce
at render time, so a statically prerendered route (the default whenever
nothing else forces dynamic rendering) would ship build-time HTML with no
nonce on its inline bootstrap scripts, which the browser's CSP would then
block, breaking hydration entirely. `app/layout.tsx` sets
`export const dynamic = "force-dynamic"` at the root specifically to
guarantee every route gets a real per-request render (and thus a valid
nonce) — this is a requirement of the nonce-based CSP design, not an
automatic consequence of it.

Full directive table (`isDev: false`, i.e. production):

| Directive | Value |
| --- | --- |
| `default-src` | `'self'` |
| `script-src` | `'self' 'nonce-<nonce>' https://challenges.cloudflare.com` + Clerk's origin (when resolvable) |
| `style-src` | `'self' 'unsafe-inline'` |
| `img-src` | `'self' data: blob: https://img.clerk.com` |
| `font-src` | `'self' data:` |
| `connect-src` | `'self' https://clerk-telemetry.com` + Clerk's origin (when resolvable) |
| `worker-src` | `'self' blob:` |
| `frame-src` | `'self' https://challenges.cloudflare.com` |
| `object-src` | `'none'` |
| `base-uri` | `'self'` |
| `form-action` | `'self'` |
| `frame-ancestors` | `'none'` |
| `upgrade-insecure-requests` | present, no value |

Why nonce-based instead of `'unsafe-inline'`: `'unsafe-inline'` in
`script-src` defeats the entire point of CSP — it allows any injected
`<script>` tag to execute, which is exactly the class of attack (XSS) CSP
exists to stop. A per-request nonce lets the app's own scripts (and Next's
streaming inline scripts, signed with the same nonce) run while anything an
attacker injects — which won't know the nonce — is blocked.
`challenges.cloudflare.com` and `img.clerk.com` are Clerk's own documented CSP
requirements (the bot-protection widget and avatar CDN); `style-src
'unsafe-inline'` is required by Next.js/Clerk injected styles and is not
prohibited by the acceptance criteria, which target inline **scripts** and
`eval`, not inline styles.

Dev-only relaxations, both gated on `process.env.NODE_ENV !== "production"`
(the `isDev` flag passed into `buildContentSecurityPolicy`):

- `'unsafe-eval'` is added to `script-src` (Next.js dev's HMR/fast-refresh
  tooling needs it).
- `ws:` is added to `connect-src` (Next.js dev's HMR websocket).
- `upgrade-insecure-requests` is omitted in dev (no HTTPS in local dev).

Any new third-party script (analytics, a widget, etc.) requires a deliberate
change to the `script-src`/`connect-src` directives in `lib/security/csp.ts`
— it will not work silently, by design.

**Pre-launch checklist:**

- [ ] Run the deployed URL through an OWASP/Google CSP evaluator
      (e.g. https://csp-evaluator.withgoogle.com/) and confirm no
      high-severity findings.
- [ ] Click through sign-in, sign-up, and one authenticated page with the
      browser console open; confirm zero CSP violation messages.

## 4. Git-history secret scan

Run locally with:

```
bun run check:git-secrets
```

This runs `scripts/check-git-secrets.mjs`, which scans the **entire** git
history (not just the working tree) for:

1. Added lines matching a known secret shape (Clerk secret keys, Resend API
   keys, Google OAuth client secrets, AWS/R2 access key IDs, PEM private key
   blocks, JWTs, and assigned values of the secret-bearing env var names from
   `.env.example`).
2. Committed `.env*` files other than the checked-in `.env.example`
   placeholder.

It refuses to report "clean" on a shallow clone (`git rev-parse
--is-shallow-repository`) — a shallow scan can only see recent history and
would silently miss a secret committed further back, which is the main
failure mode the guard exists to prevent. CI (`.github/workflows/ci.yml`,
`git-secret-scan` job) always checks out with `fetch-depth: 0` for this
reason.

**Allowlist policy:** two narrow allowlists exist in the script,
`VALUE_ALLOWLIST` (matched-text regexes, e.g. `/placeholder/i`, `/example/i`,
plus two entries added for this issue's own Jest test-fixture values —
`"test-cron-secret"`-style and `"client-secret-456"`-style doubles used in
`tests/unit/**`) and `PATH_ALLOWLIST` (exact paths — currently only the
script's own file, since its pattern list would otherwise match itself, plus
any path containing `check-git-secrets` for that script's own test
fixtures). `.pipeline/**` and `documentation/**` are deliberately **not**
allowlisted — a pasted real secret there is a genuine finding. Every
allowlist entry carries a `reason` string.

Never print a matched secret verbatim, including when reporting a finding —
the script always redacts to `<first 4 chars>…(len=<n>)`, since its own
output lands in CI logs and in `.pipeline/*.md`. If a real finding ever
occurs, the remediation order is: **rotate the credential first, then purge
history** — never the reverse, since a still-valid credential remains usable
by anyone who already saw it in history regardless of a later history purge.

**Run recorded for this issue:**

| | |
| --- | --- |
| Date | 2026-08-06 |
| Commit scanned | `43050470ea60ca3637c4abaf02a843aa2321e728` (repo HEAD immediately prior to this issue's own commit) |
| Result | `OK: no secrets found in git history.` (exit 0) |

## 5. Dependabot

`.github/dependabot.yml` configures weekly update checks for two ecosystems:

- `bun` (directory `/`) — this repo's JavaScript/TypeScript dependencies,
  tracked via `bun.lock`. Per `AGENTS.md`, this stays `bun`, not `npm` or any
  other package manager's ecosystem.
- `github-actions` (directory `/`) — the actions referenced in
  `.github/workflows/*.yml`.

Each is capped at 5 open PRs at a time.

**Human setup after merge:**

- [ ] Confirm Dependabot is actually running: GitHub UI → repo → Insights →
      Dependency graph → Dependabot. If GitHub reports the config as
      invalid, that's a follow-up fix, not something that should have
      blocked this issue.
