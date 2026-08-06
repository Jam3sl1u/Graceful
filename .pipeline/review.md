# Review — Issue #78: [Sprint 4] Infrastructure security pass (HTTPS, CSP, secret scan)

VERDICT: BLOCK

The diff matches the spec almost line for line, and every test in the pipeline is
green — but the CSP as shipped **breaks the six statically prerendered routes in
production**. This was verified empirically against this worktree's own
production build, not inferred.

---

## BLOCKER 1 — Nonce-based CSP blocks all inline scripts on prerendered routes

**Where:** `middleware.ts` + `lib/security/csp.ts` (interaction with Next's full
route cache), documented incorrectly in `documentation/infrastructure-security.md:53-55`.

**Evidence (reproduced live, `next start` on the build in `.next/`):**

`GET /` (public, in `prerender-manifest.json`):

```
x-nextjs-cache: HIT
x-nextjs-prerender: 1
content-security-policy: ... script-src 'self' 'nonce-ZnyOrs6hRXU0rnC+rl+RTQ==' ... (no 'unsafe-inline')
```

and the body it served:

```
<script>(self.__next_f=self.__next_f||[]).push([0])</script>
<script>self.__next_f.push([1,"0:{\"P\":null,...
```

— 8 inline `<script>` tags, **zero `nonce` attributes** (the RSC payload even
carries `"nonce":""` for ClerkProvider). Compare `GET /sign-in` (dynamically
rendered), which is correct:

```
<script nonce="DpU+fmZEjH9CB6g9VNGY0A==">
```

**Why:** Next reads the nonce out of the *request* `content-security-policy`
header at **render** time (`node_modules/next/dist/server/app-render/app-render.js:108-119`).
Statically prerendered routes are rendered at build time, when no such header
exists, and are then served from the full route cache with a fresh per-request
nonce in the response header that matches nothing in the HTML. With no
`'unsafe-inline'` in `script-src`, the browser blocks every one of those inline
scripts, `self.__next_f` never populates, and the App Router never hydrates.

**Affected routes** (from `.next/prerender-manifest.json`): `/`, `/dashboard`,
`/documents`, `/notifications`, `/conflicts`, `/_not-found` — i.e. the landing
page and the four main authenticated pages. On Vercel this is the same or worse
(CDN-served prerendered HTML + middleware-generated nonce).

**Fix (coder's call, but it must be verified end-to-end, not by unit test):**
- Simplest: opt the app out of static prerendering while a nonce CSP is in play
  (e.g. `export const dynamic = "force-dynamic"` in `app/layout.tsx`), then
  confirm `bun run build` reports no statically prerendered app routes and that
  a `next start` response for `/` shows `<script nonce="...">` matching the
  response header.
- Alternative: keep static prerendering and stop using a per-request nonce
  (hash-based / `'strict-dynamic'`) — significantly more fragile; only take this
  if you verify it against the built output.
- Do **not** "fix" this by adding `'unsafe-inline'` to `script-src` — that
  violates the issue's acceptance criteria.

**Regression coverage to add:** a check that actually inspects served HTML (or a
build-time assertion that no app route is statically prerendered). The current
`tests/unit/middleware.test.ts` only asserts on the header string, which is why
5/5 green tests missed a total production breakage.

## BLOCKER 2 — Documentation asserts the false premise

`documentation/infrastructure-security.md:53-55` states "because the policy (and
the nonce inside it) is generated fresh per request, pages render per-request
rather than being fully static/cached at the CSP layer." That is not true today —
`x-nextjs-cache: HIT` / `x-nextjs-prerender: 1` on `/` proves it. The comment
block in `middleware.ts:33-36` ("this is what makes 'no inline scripts'
achievable without 'unsafe-inline'") is likewise only true for dynamically
rendered routes. Both must be corrected as part of the fix, since this wrong
assumption is what let the bug through.

---

## Non-blocking issues (fix while you're in here)

1. **Tester's new test files are untracked.** `tests/unit/middleware.test.ts` and
   `tests/unit/scripts/check-git-secrets.test.ts` are not committed
   (`git status` shows `??`). They will not land in the PR as-is. Commit them.
2. **`README.md` unintended reformat.** The change de-indented an unrelated
   continuation line:
   ```
   -  check:service-role`) and re-verified in the Sprint 4 security audit (#79).
   +check:service-role`) and re-verified in the Sprint 4 security audit (#79).
   ```
   Renders the same (lazy continuation) but the spec said "nothing else in
   README.md changes". Restore the two-space indent.
3. **`scripts/check-git-secrets.mjs:109` — allowlist comment is inaccurate.**
   The comment claims a value "would still need to match the *whole* allowlist
   regex to be suppressed"; `VALUE_ALLOWLIST` entries are applied with
   `regex.test(matched)`, i.e. substring matching. A real secret containing
   `example`/`xxxx` as a substring would be silently suppressed. Either anchor
   the allowlist regexes or correct the comment.
4. **`scripts/check-git-secrets.mjs:105` — path bypass is broader than spec.**
   The spec asked for "any *test file* whose path contains `check-git-secrets`";
   the implementation exempts *any* path containing that fragment, which is a
   trivially nameable scanner bypass. Narrow it (e.g. require a `tests/` prefix).
5. **Merge commits are not scanned.** `git log --all -p` emits no diff for merge
   commits, so a secret introduced in a conflict resolution is invisible to the
   added-line scan. Acceptable as a known limitation, but it should be stated in
   `documentation/infrastructure-security.md` rather than left implicit under the
   "scans the *entire* history" claim in the script header.

## What is correct and verified

- HSTS: live response carries `Strict-Transport-Security: max-age=63072000;
  includeSubDomains; preload` on `/`; `next.config.ts` shape is valid (build
  succeeds).
- `lib/security/csp.ts` matches the spec's directive table exactly (order,
  tokens, `isDev` gating, `clerkOrigin: null` handling); verified against the
  live header, which correctly resolved `https://clean-mayfly-62.clerk.accounts.dev`
  from the publishable key.
- `scripts/check-git-secrets.mjs`: re-ran the tester's scratch-repo suite —
  fake `sk_live_` key, committed `.env` (even when later deleted), `.env.example`
  not flagged, shallow clone refused, non-git dir refused. Redaction never leaks
  the matched value. Exits 0 on this repo's real history. The two extra
  `VALUE_ALLOWLIST` entries are genuinely Jest fixtures.
- `.github/workflows/ci.yml` (`git-secret-scan` with `fetch-depth: 0`) and
  `.github/dependabot.yml` match the spec; no existing CI job touched.
- `bun run typecheck`, `bun run lint`, and the 24 security-related unit tests
  pass; every file this issue touches is Prettier-clean (repo-wide
  `format:check` drift is pre-existing and correctly left alone).
