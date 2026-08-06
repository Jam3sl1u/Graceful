# Test Results — Issue #78: [Sprint 4] Run infrastructure security pass (HTTPS, CSP, secret scan)

## Verdict: ALL PASS

Independently re-ran every verification `.pipeline/changes.md` claimed, from a
clean `node_modules` (this worktree had none checked out — ran `bun install`
first), and added two new test files covering the two seams the spec/changes.md
flagged as not yet independently exercised: `middleware.ts`'s request/response
CSP-header plumbing, and `scripts/check-git-secrets.mjs`'s exit-code behavior
against disposable scratch git repos.

## New test files added by this stage

### `tests/unit/middleware.test.ts` (new, 5 tests)

`middleware.ts` wraps its handler in `clerkMiddleware`, so it can't be
exercised the way a pure module can. Mocked `@clerk/nextjs/server` down to an
identity function for `clerkMiddleware` only (`clerkMiddleware: (handler) =>
handler`), keeping the real `createRouteMatcher` (pure route matching against
`req.nextUrl.pathname`, no external calls), so the actual handler body in
`middleware.ts` runs against a real `NextRequest`.

- **Happy path**: a public route (`/sign-in`) gets a
  `content-security-policy` response header containing `default-src 'self'`,
  a `script-src 'self' 'nonce-...'` token, and `frame-ancestors 'none'`,
  without `auth.protect()` being called.
- **Edge case (spec-named auth interaction)**: a non-public route
  (`/dashboard`) calls `auth.protect()` exactly once and still returns a
  response carrying the CSP header.
- **Edge case (the plumbing changes.md specifically flagged as worth
  checking)**: spied on `NextResponse.next` to confirm the *same* nonce that
  ends up in the response header is also stamped onto the *request* headers
  object passed to `NextResponse.next({ request: { headers } })` — this is
  the mechanism the spec relies on for Next to sign its own inline scripts.
- **Edge case**: two consecutive requests get two different CSP strings
  (nonce uniqueness carried through the full handler, not just
  `generateNonce()` in isolation).
- **Edge case (dev/prod branching)**: with `NODE_ENV=production`, the
  response CSP contains neither `'unsafe-eval'` nor `ws:`, and does contain
  `upgrade-insecure-requests`.

Result: **5/5 passed**.

### `tests/unit/scripts/check-git-secrets.test.ts` (new, 6 tests)

Integration-style test (real `git`/`node` subprocesses against disposable
scratch repos under `os.tmpdir()`, cleaned up per-test) — the behavior under
test (git history semantics, shallow-clone detection, exit codes) is only
meaningfully verified end-to-end, matching the spec's own named verification
scenarios.

- **Happy path**: a clean scratch repo (one commit, no secrets) → exit 0,
  stdout contains `OK:`.
- **Failure case (spec-named)**: a scratch repo with a commit containing a
  fake `sk_live_...` key → exit 1, stderr names the `Clerk secret key`
  pattern, stderr does **not** contain the raw fake secret anywhere, and the
  redaction format matches `sk_l…(len=<n>)` exactly as the script's `redact()`
  function specifies.
- **Edge case**: a committed `.env` file, even after being deleted in a later
  commit, still triggers a `Committed .env file` finding (history scan, not
  working-tree scan) → exit 1.
- **Edge case**: a committed `.env.example` file is correctly *not* flagged →
  exit 0.
- **Edge case (spec-named)**: a shallow clone (`git clone --depth 1`) of a
  2-commit repo → exit 1 with a stderr message containing "shallow",
  regardless of whether the shallow history itself contains a secret — i.e.
  the shallow-clone guard fires before/instead of reporting a false "clean".
- **Failure case**: running the script outside any git working tree → exit 1
  with a "git working tree" error message.

Result: **6/6 passed**.

## Independent re-verification of the Coding stage's claims

All run fresh in this worktree
(`/Users/jamesliu/Documents/Graceful/.claude/worktrees/issue-78`), after `bun
install` (node_modules was absent at the start of this stage):

| Check | Command | Result |
|---|---|---|
| Typecheck | `bun run typecheck` | PASS — no errors |
| Lint | `bun run lint` | PASS — no errors/warnings |
| Unit tests (baseline, before this stage's new files) | `bun run test` | PASS — **83 suites, 1064 tests** — matches changes.md's claimed count exactly |
| Unit tests (after this stage's 2 new test files) | `bun run test` | PASS — **85 suites, 1075 tests** (1064 + 5 middleware + 6 check-git-secrets, no regressions) |
| Format check (repo-wide) | `bun run format:check` | FAILS — but confirmed pre-existing: same 79-file drift changes.md described, none of which are files this issue touches or the 2 files this stage added (`prettier --check` on the new test files individually passes) |
| Format check (new test files only) | `bunx prettier --check tests/unit/middleware.test.ts tests/unit/scripts/check-git-secrets.test.ts` | PASS |
| Git-history secret scan | `bun run check:git-secrets` | PASS — exit 0, `OK: no secrets found in git history.` against this repo's real history |
| Production build | `bun run build` (with synthetic `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`/`CLERK_SECRET_KEY` set, since none are configured in this sandbox) | PASS — exit 0, all 37 routes + Middleware bundle produced, confirming `next.config.ts`'s `headers()` shape is valid Next.js config |

## Manual review against the spec (spot-checked, not just trusted changes.md)

- **`lib/security/csp.ts`**: directive order, tokens, and dev/prod branching
  in `buildContentSecurityPolicy` match the spec's directive table exactly
  (verified by reading the source against the table line by line, plus the
  coder's own `tests/unit/lib/security/csp.test.ts`, which independently
  looks correct and complete — re-ran it as part of the full suite above).
  `clerkFrontendApiOrigin`'s prefix-strip / `atob` / `$`-split / host-regex
  sequence matches the spec's five bullet points exactly.
- **`middleware.ts`**: `isPublicRoute`, the `clerkMiddleware` wrapper, the
  `auth.protect()` gate, and the exported `config` matcher are byte-for-byte
  unchanged from what the spec said to preserve. The nonce/CSP addition
  matches the spec's 5-step description; the redirect-short-circuit comment
  is present and accurate. No stray `x-nonce` header (confirmed by grep).
- **`next.config.ts`**: single `headers()` entry, exact HSTS value from the
  spec (`max-age=63072000; includeSubDomains; preload`), `source: "/:path*"`.
  No CSP here (correctly deferred to middleware). `reactStrictMode`,
  `outputFileTracingRoot`, `eslint.dirs` untouched (confirmed via diff-free
  read).
- **`scripts/check-git-secrets.mjs`**: all 7 `PATTERNS` entries match the
  spec's regexes verbatim, including the 20-name `SECRET_ENV_VAR_NAMES` list.
  Both allowlists carry a `reason` per entry as required. `PATH_ALLOWLIST` is
  narrowly scoped to the script's own path plus `check-git-secrets`-fragment
  paths — confirmed `.pipeline/**` and `documentation/**` are NOT allowlisted
  (grepped `PATH_ALLOWLIST`/`isAllowedPath`, only the two entries described in
  changes.md exist). Redaction format matches spec exactly (`<first 4
  chars>…(len=<n>)`) — confirmed with a live scratch-repo run above. The
  deliberate no-hardcoded-`cwd` deviation from `check-service-role.mjs` is
  real and is exactly what makes the scratch-repo test cases in this stage's
  new test file work.
- **`.github/workflows/ci.yml`**: new `git-secret-scan` job matches the
  spec's YAML verbatim (`fetch-depth: 0`, `setup-bun@v2` at `1.2.x`, no `bun
  install` step, `bun run check:git-secrets`). Every other job
  (`checks`, `check-secrets`, `rls-integration`, `e2e`) is untouched —
  confirmed by reading the full file (reproduced above).
- **`.github/dependabot.yml`**: matches the spec's YAML verbatim, header
  comment present.
- **`README.md`**: both additions (Scripts bullet, Environments link) present
  and match the spec's requested wording/placement; nothing else changed.
- **`documentation/infrastructure-security.md`**: read in full — covers all
  five spec sections (purpose/scope, HTTPS, CSP, git-history scan, Dependabot)
  with the operator checklists as `- [ ]` items, and records the actual scan
  run (date, commit SHA, `OK:` result) as required. The recorded commit SHA
  (`43050470ea60ca3637c4abaf02a843aa2321e728`) is the repo HEAD immediately
  prior to this issue's own commits, consistent with changes.md's explanation.
- Confirmed the two `VALUE_ALLOWLIST` additions beyond the spec's seed set
  (`"test-..."` and `"client-(id|secret)..."` regexes) by reading the actual
  matched fixture files via `git show` — both are genuinely Jest test-double
  strings (`"test-cron-secret"`, `"test-api-key"`, `"client-secret-456"`),
  not real credentials. No overly broad allowlist entries found.

## Not independently exercised (environment limitation, not a gap in the diff)

- The two OPEN QUESTION items (Vercel's actual HTTP→HTTPS redirect behavior
  on a deployed URL; Dependabot actually running on GitHub) are explicitly
  post-merge human-action items per the spec and were not — and could not be
  — exercised from this sandbox.
- `bun run test:e2e` was not re-run: no `STAGING_APP_URL`/Clerk/E2E secrets
  are configured in this sandbox (same limitation prior pipeline runs in this
  repo have hit), and this issue's scope doesn't touch any E2E-covered flow.
  Not required by this issue's spec.
- A live end-to-end HTTP round-trip against a running `next dev`/`next start`
  server (to see the `content-security-policy`/`Strict-Transport-Security`
  headers on an actual HTTP response, as opposed to the in-process handler
  test added above) was not performed — this repo's E2E harness needs real
  Clerk credentials to boot the app (`clerkMiddleware` throws without a
  publishable/secret key pair), which are not present in this sandbox. The
  `tests/unit/middleware.test.ts` added by this stage exercises the same
  handler code path in-process instead, which is the closest substitute
  available without those credentials.

## Failure case coverage summary (per AGENTS.md's Testing-stage requirement)

- `clerkFrontendApiOrigin` invalid-input failure cases: covered by the
  coder's `tests/unit/lib/security/csp.test.ts` (undefined, empty string,
  non-`pk_` string, garbage base64, invalid decoded host) — re-verified
  green.
- `check-git-secrets.mjs` failure cases: fake-secret-in-history, shallow
  clone, and non-git-directory all covered by this stage's new test file
  above, each independently confirmed to exit 1 with the expected message.
- `middleware.ts`: no distinct failure-mode branch exists in this handler
  beyond the auth redirect (which the spec explicitly says is out of scope
  to test — "that redirect response carries no CSP header... state it in a
  comment so it doesn't read as a bug" — not a code path the tester needs to
  assert on).

No product bugs found. No failing tests. Ready for Review.
