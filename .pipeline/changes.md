# Changes — Issue #78: [Sprint 4] Run infrastructure security pass (HTTPS, CSP, secret scan)

Implements `.pipeline/spec.md` in full. No OPEN QUESTIONS blocked the pipeline
(both items in the spec's OPEN QUESTIONS section are post-merge human-action
checklist items, recorded in the new documentation file per the spec).

## Fix pass — resolving the BLOCK verdict in `.pipeline/review.md`

The branch was also rebased onto current `main` (via merge commit) to pick up
issues #74–#77, which had merged after this branch diverged and were making
the PR show as `CONFLICTING`.

- **`app/layout.tsx`** — added `export const dynamic = "force-dynamic";`.
  This is the fix for BLOCKER 1: nothing previously forced dynamic rendering,
  so Next statically prerendered `/`, `/dashboard`, `/documents`,
  `/notifications`, `/conflicts`, `/_not-found` at build time, shipping HTML
  with no nonce on inline bootstrap scripts while the CSP header carried a
  different, per-request nonce — the browser blocked every inline script and
  the app never hydrated. Forcing dynamic rendering at the root cascades to
  every route group, guaranteeing a real per-request render (and thus a valid
  nonce) everywhere the CSP middleware applies. Verified empirically (not
  just re-read): `bun run build` afterward shows `.next/prerender-manifest.json`
  contains only `/apple-icon` and `/manifest.webmanifest` (binary/JSON
  responses, no inline scripts, unaffected either way); a `bun run start`
  response for `/` returns the same nonce in `content-security-policy` as on
  all 19 inline `<script nonce="...">` tags in the served HTML.
- **`documentation/infrastructure-security.md`** — corrected BLOCKER 2: the
  §3 CSP section no longer claims per-request rendering was already an
  automatic consequence of the nonce design; it now states that
  `app/layout.tsx`'s `force-dynamic` export is what guarantees it, and why
  that's required (Next only signs inline scripts with a nonce at render
  time). Re-checked `middleware.ts`'s own comment for the same false
  premise — it doesn't assert one; only the doc needed correcting.
- **`scripts/check-git-secrets.mjs`** — three non-blocking fixes:
  1. `isAllowedPath`'s `path.includes("check-git-secrets")` bypass is now
     scoped to `tests/` paths only (`/(^|\/)tests\//.test(path) &&
     path.includes(...)`), matching the spec's actual "any test file whose
     path contains check-git-secrets" wording instead of exempting any path
     anywhere in history containing that fragment.
  2. The `VALUE_ALLOWLIST` comment no longer claims whole-string match
     semantics; it now accurately describes the (intentional) substring
     match `isAllowedValue` performs.
  3. `scanAddedLines()`'s `git log` invocation now passes
     `--diff-merges=first-parent`, so a secret introduced only via a merge
     commit's conflict resolution is no longer invisible to the scan (plain
     `git log -p` silently omits merge-commit diffs). Re-verified
     `bun run check:git-secrets` still exits 0 clean against this repo's
     real history with the wider coverage.
- **`README.md` non-blocking finding — investigated, no change needed.** The
  review asked to restore a 2-space continuation-line indent under the
  `check:service-role` bullet. Verified in isolation
  (`bunx prettier` on a standalone file reproducing the exact pattern) that
  Prettier's own canonical formatting for this markdown list-continuation
  line strips that indent — restoring it would fail `prettier --check` and
  get stripped again on the next format pass. The originally-shipped version
  was already Prettier-correct; this was a false positive in the review, not
  an accidental reformat.
- **Recreated the two test files** `tests/unit/middleware.test.ts` and
  `tests/unit/scripts/check-git-secrets.test.ts` never made it into the PR
  (written by the Testing stage but never `git add`ed before that worktree
  was cleaned up — confirmed unrecoverable via `git fsck --dangling`).
  - `tests/unit/middleware.test.ts` was reclaimed in the meantime by #76
    (rate-limiting tests) merging first, so the CSP-specific coverage now
    lives in a new file, **`tests/unit/middleware-csp.test.ts`** (5 tests,
    same scenarios `.pipeline/test-results.md` originally described).
  - **`tests/unit/scripts/check-git-secrets.test.ts`** (8 tests): the
    original 6 scratch-repo scenarios, plus 2 new cases covering this fix
    pass's two `check-git-secrets.mjs` behavior changes (narrowed path
    bypass; substring-allowlist suppression still works as documented).

## Files changed

- **`lib/security/csp.ts`** (new) — pure, dependency-free, edge-safe module:
  - `clerkFrontendApiOrigin(publishableKey)` — derives `https://<host>` from a
    `pk_test_`/`pk_live_` Clerk key by base64-decoding the payload up to the
    first `$`; returns `null` for any invalid/undefined/garbage input.
  - `generateNonce()` — 16 random bytes via `crypto.getRandomValues`,
    base64-encoded via `btoa`.
  - `buildContentSecurityPolicy({ nonce, clerkOrigin, isDev })` — builds the
    single-line CSP header value per the directive table in the spec
    (`script-src`/`connect-src` include the Clerk origin only when non-null;
    `'unsafe-eval'`/`ws:` only when `isDev`; `upgrade-insecure-requests`
    omitted when `isDev`).

- **`middleware.ts`** (modified) — `isPublicRoute`, the `clerkMiddleware`
  wrapper, the auth behavior, and the exported `config` matcher are
  unchanged. Added: generate a nonce + CSP per request, stamp the CSP onto
  the *request* headers before `NextResponse.next()` (so Next.js can sign its
  own streaming inline scripts with the nonce), then set the same CSP on the
  *response* headers. Comment explains the redirect-short-circuit edge case
  (an `auth.protect()` redirect carries no CSP header — acceptable, empty
  body). No `x-nonce` header added (no app code reads it — would be unused
  scope creep).

- **`next.config.ts`** (modified) — added `async headers()` returning one
  entry: `source: "/:path*"` with
  `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`.
  `reactStrictMode`, `outputFileTracingRoot`, `eslint.dirs` untouched. CSP is
  deliberately NOT here (must be per-request/nonce-based, middleware-only).

- **`scripts/check-git-secrets.mjs`** (new) — git-history secret scanner,
  following `check-service-role.mjs`'s exit-code convention and
  `check-workflows.mjs`'s `execFileSync` usage (node builtins only, no `bun
  install` needed):
  1. Fails if not inside a git work tree.
  2. Fails (with an explanatory message) if the repo is a shallow clone —
     `git rev-parse --is-shallow-repository`.
  3. Added-line scan over `git log --all --full-history -p -U0` output,
     matching `PATTERNS` (Clerk secret keys, Resend API keys, Google OAuth
     client secrets, AWS/R2 access key IDs, PEM private key blocks, JWTs, and
     assigned secret env vars from the 20 secret-bearing names in
     `.env.example`).
  4. Committed-`.env*`-file scan via `git log --diff-filter=A --name-only`,
     flagging any added `.env`/`.env.*` path except `.env.example`.
  5. Findings print to stderr as `<sha> <path> - <patternName>:
     <redacted>` and exit 1; a clean scan prints `OK: ...` and exits 0.
     Redaction is always `<first 4 chars>…(len=<n>)` — the matched secret
     itself is never printed.
  - Two allowlists, each entry carrying a `reason`: `VALUE_ALLOWLIST`
    (matched-text regexes) and `PATH_ALLOWLIST` (the script's own path, plus
    any path containing `check-git-secrets` for that script's own test
    fixtures — nothing broader; `.pipeline/**` and `documentation/**` stay in
    scope).
  - **Deliberate deviation from the `check-service-role.mjs` `REPO_ROOT`
    pattern:** this script does NOT hardcode `cwd` to its own location.
    Instead it lets `git` auto-discover the repository from the process's
    actual working directory. This is what makes the "exits 1 against a
    scratch git repo with a fake key" test case in the spec's verification
    section actually work — hardcoding `cwd` to this repo's root would make
    the script always scan *this* repo regardless of where/against what it's
    invoked, which would make that test case impossible to satisfy without
    copying the script into the scratch repo first.
  - Added `"check:git-secrets": "node scripts/check-git-secrets.mjs"` to
    `package.json` scripts.

- **`.github/workflows/ci.yml`** (modified) — added a new top-level
  `git-secret-scan` job (checkout with `fetch-depth: 0`, `setup-bun`, `bun
  run check:git-secrets`, no `bun install` step). Every existing job,
  including `check-secrets` (Actions-secret availability — unrelated,
  untouched), is unchanged.

- **`.github/dependabot.yml`** (new) — weekly `bun` (root manifest) and
  `github-actions` update checks, each capped at 5 open PRs. Header comment
  notes this repo uses Bun exclusively per `AGENTS.md`.

- **`documentation/infrastructure-security.md`** (new) — follows
  `documentation/staging-environment.md`'s house style. Sections: purpose &
  scope (cross-references #76/#77/#79 as out of scope), HTTPS enforcement
  (+ operator checklist), CSP (full directive table, nonce rationale, dev-only
  relaxations, pre-launch checklist), git-history secret scan (how to run,
  allowlist policy, **the actual scan run recorded**: date 2026-08-06, commit
  `43050470ea60ca3637c4abaf02a843aa2321e728` — repo HEAD immediately prior to
  this issue's own commit — result `OK: no secrets found in git history.`),
  and Dependabot (+ post-merge verification checklist item).

- **`README.md`** (modified) — added the `check:git-secrets` bullet to the
  Scripts list and a line under "Environments" linking to the new doc.
  Nothing else changed.

- **`tests/unit/lib/security/csp.test.ts`** (new) — coder-authored unit
  tests for all three exported functions, covering every "Behaviors the
  tester should be able to verify" bullet in the spec: valid/invalid
  `pk_test_`/`pk_live_` keys, nonce uniqueness/byte-length, `isDev: false`
  vs `isDev: true` directive differences, `clerkOrigin: null` well-formedness,
  and directive ordering/no-trailing-semicolon.

- **`.pipeline/spec.md`** (staged) — this is the planning stage's own output
  for this pipeline run (was already present, uncommitted, in the working
  tree when this coding stage started); staged here so it lands in the same
  commit as the implementation it specifies, rather than being lost. The
  previously-committed `.pipeline/spec.md` on this branch was stale content
  left over from issue #66.

## Verification performed (all passed)

- `bun run check:git-secrets` — exits 0 against this repo's real history.
  Two `VALUE_ALLOWLIST` entries were added beyond the spec's minimum seed set
  to suppress two categories of obvious false positive found on the first
  run, both from this repo's own Jest test fixtures (not real secrets):
  - `/"test-[a-z0-9-]+"/i` — reason: "Jest test-double value for a secret env
    var (e.g. CRON_SECRET/PINGRAM_API_KEY fixtures like
    `"test-cron-secret"`), not a real credential." Matched
    `tests/unit/app/api/cron-invitation-reminders-route*.test.ts`,
    `tests/unit/e2e-support/env.test.ts` (all `"test-cron-secret"`) and a
    prior version of `tests/unit/lib/pingram/client.test.ts`
    (`"test-api-key"`).
  - `/"client-(id|secret)(-\d+)?"/i` — reason: "Jest test-double value for
    GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET fixtures (e.g.
    `"client-secret-456"`), not a real credential." Matched
    `tests/unit/lib/google-calendar/{oauth,sync,sync-tester-supplement}.test.ts`.
  Both were manually confirmed by reading the actual fixture source (`git
  show <sha>:<path>`) before allowlisting — neither is a real credential.
  Also independently exercised: exits 1 (redacted output, not the secret)
  against a scratch repo with a fake `sk_live_...` key committed; exits 1
  against a scratch repo with a committed `.env` file; exits 1 (with the
  shallow-clone message) against a `--depth 1` clone.
- `bun run typecheck`, `bun run lint`, `bun run test` (1064 tests, 83 suites,
  including the 13 new CSP tests) — all pass.
- `bun run format:check` — **fails repo-wide, but pre-existing and out of
  scope for this issue**: 79 files fail Prettier on this branch, none of
  them touched by this change (confirmed by running `prettier --check` on
  only the 10 files this issue adds/modifies — all pass — and by
  `git stash`-ing this issue's diff and re-running `format:check` against
  unmodified `origin/main`, which fails on 80 pre-existing files, i.e. the
  same drift minus the one file — `README.md` — this issue happens to touch
  and which was reformatted as a side effect of editing it). Not fixed here
  per AGENTS.md's no-scope-creep rule; every file this issue actually
  changed is individually Prettier-clean.
- `bun run build` — succeeds when Clerk env vars are present (confirms the
  `next.config.ts` `headers()` shape is valid). Note: `bun run build` fails
  in this sandbox both before and after this change (`Missing publishableKey`
  on `/documents` prerender) because no `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
  is set in this environment — verified pre-existing via `git stash` (fails
  identically on unmodified `origin/main`). Re-ran with a synthetic
  `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`/`CLERK_SECRET_KEY` set and the build
  succeeded end-to-end, producing all 37 routes plus a compiled Middleware
  bundle.

## What the tester should focus on

- The CSP directive string itself (order, exact tokens, no double spaces,
  dev vs. prod differences) — `tests/unit/lib/security/csp.test.ts` covers
  this but an independent read of `lib/security/csp.ts` against the spec's
  directive table is worthwhile.
- `middleware.ts`'s request-header nonce plumbing — this can't be unit
  tested in isolation the way `csp.ts` can; worth a manual/integration check
  that a real request gets a `content-security-policy` response header.
- `scripts/check-git-secrets.mjs`'s shallow-clone detection and the
  cwd-discovery behavior (no hardcoded `REPO_ROOT`) — independently verify
  the three scratch-repo scenarios named in the spec's verification section
  (fake key present, shallow clone, committed `.env` file).
- The two `VALUE_ALLOWLIST` additions above — confirm independently that the
  matched fixture values really are fake/test-only, not real credentials.
