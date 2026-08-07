# Test Results — Issue #75: [Sprint 4] PWA manifest & install prompt

This overwrites the stale `test-results.md` for issue #65 that was still
sitting at this path (per AGENTS.md, `.pipeline/` files reflect only the most
recent run).

## Verdict: PASS, with one flagged finding for Review

All automated checks pass (lint/typecheck/test/build), independently re-run and matching
the Coder's claims in `changes.md`. No failing test to stop the pipeline on. However,
manual verification against a real running production build (not a physical device, so
this **was** performable in this pipeline stage, contrary to the "manual verification"
checklist's blanket assumption) surfaced a genuine discrepancy between the spec's stated
intent and the actual rendered output — see "Finding" below. Recommend the Reviewer weigh
this before shipping.

## Re-run verification (independent)

- `bun run lint` — clean. Matches the Coder's claim.
- `bun run typecheck` — clean. Matches the Coder's claim.
- `bun run test` — **84 suites / 1068 tests passed**, exact match to the Coder's reported
  numbers, 0 failures. Also re-ran the 3 new PWA suites in isolation:
  `tests/unit/lib/pwa/install.test.ts`, `tests/unit/app/manifest.test.ts`,
  `tests/unit/app/install-prompt.test.tsx` → 3 suites / 28 tests passed.
- `bun run build` (with throwaway well-formed dummy Clerk keys, same approach the Coder
  used — no local `.env` in this worktree, nothing committed) — succeeds. Route list
  confirms `○ /apple-icon` and `○ /manifest.webmanifest` as static routes, matching the
  Coder's claim.
- Confirmed `.next/` build output is gitignored and `git status` is clean — no build
  artifacts or stray files were left behind by this verification.

## Manual/behavioral verification actually performed in this stage

Ran `bun run start` against the production build and hit it with `curl` (no physical
device needed for this subset of the spec's "Manual verification" checklist):

- `GET /manifest.webmanifest` while signed out → **200**, body matches every field in the
  spec's table exactly (name, short_name, description, id, start_url, scope, display,
  background_color, theme_color, both icons with `sizes: "any"`).
- `GET /apple-icon` while signed out → **200**. Confirms E9 / the middleware change works
  end-to-end: `middleware.ts`'s `isPublicRoute` correctly exempts both new paths, and
  `config.matcher`/`auth.protect()` are otherwise untouched (also diff-reviewed directly).
- `/` page source (shares the root layout/metadata with `/dashboard`) contains
  `<link rel="manifest" href="/manifest.webmanifest">`,
  `<meta name="theme-color" content="#4f46e5">`,
  `<meta name="application-name" content="Graceful">`,
  `<meta name="apple-mobile-web-app-title" content="Graceful">`, and
  `<meta name="apple-mobile-web-app-status-bar-style" content="default">`.
- `public/icons/icon.svg` / `icon-maskable.svg` checked numerically against spec:
  `icon.svg` has `rx="96"` rounding and `font-size="307"` (~60% of 512, matches spec);
  `icon-maskable.svg` has no rounding and `font-size="205"` (~40% of 512, matches the
  maskable safe-area requirement). `app/apple-icon.tsx` renders the same mark at 180x180
  PNG, flex-centered, no rounding, no custom font — matches spec exactly (correctly not
  imported from Jest per spec; verified only via `bun run build` + this curl check, as the
  spec intended).
- Could not directly hit `/dashboard` signed-out (Clerk's dev-browser rewrite returns 404
  for unauthenticated requests to protected routes when using dummy keys with no real
  Clerk dev-browser cookie — pre-existing Clerk/dummy-key interaction unrelated to this
  change, not a regression). Used `/` instead, which shares the same root layout/metadata,
  to check the meta tags.

## Finding (flagged for Review — not a Jest failure, but a real behavioral gap)

**`app/layout.tsx`'s `appleWebApp: { capable: true, ... }` does not render the
`<meta name="apple-mobile-web-app-capable" content="yes">` tag that the spec's own manual
verification checklist and AC-bullet-3 rationale both explicitly call for.**

Confirmed by inspecting the actual rendered `<head>` HTML from the production build (Next
15.5.22, the version installed in this worktree per `node_modules/next/package.json`):
only `<meta name="mobile-web-app-capable" content="yes">` (no `apple-` prefix) is emitted,
alongside `apple-mobile-web-app-title` and `apple-mobile-web-app-status-bar-style`. There
is no `apple-mobile-web-app-capable` tag anywhere in the response body.

Root cause traced to `node_modules/next/dist/lib/metadata/generate/basic.js`
(`AppleWebAppMeta`): in this installed Next version, `capable: true` is wired to emit only
`name: 'mobile-web-app-capable'`, not the Apple-prefixed variant:

```js
function AppleWebAppMeta({ appleWebApp }) {
    ...
    capable ? (0, _meta.Meta)({
        name: 'mobile-web-app-capable',
        content: 'yes'
    }) : null,
```

Why this matters: `changes.md` states `appleWebApp` "is what gives iOS the full-screen,
no-browser-chrome launch — AC bullet 3," and the spec's own manual checklist explicitly
targets "iOS Safari (iOS 16+)". Historically, iOS Safari's standalone-mode detection has
relied specifically on the `apple-` prefixed tag; the un-prefixed standards-track tag is a
comparatively recent WebKit addition. If the iOS versions in the spec's own target range
(16+) don't yet honor the un-prefixed tag, this implementation — despite following the
spec's `appleWebApp` API shape exactly as written — may silently fail AC bullet 3's
full-screen launch behavior on precisely the devices the manual checklist says to test.

This is not the Coder deviating from the spec (the spec asked for the `appleWebApp.capable`
field, which is the correct/only Next.js public API for this); it's a gap between what the
installed framework version actually outputs and what the spec assumed it would output —
worth a human decision (e.g. whether to add an explicit
`other: { "apple-mobile-web-app-capable": "yes" }` override in `app/layout.tsx`) before
this ships. No code was modified to work around this — flagging per the pipeline contract
for Review/human judgment rather than patching around it myself.

## Everything else checked and consistent with spec/changes.md

- `lib/pwa/install.ts`: all four exports match the spec's declared signatures and edge-case
  rules (E3, E5, E6) exactly; existing unit tests exercise iPhone Safari, iPadOS-13+
  spoofed-Mac-with-touch, real desktop Mac, `CriOS`/`FxiOS` exclusion, Android Chrome, and
  both storage-throw paths (E3) — re-run and confirmed passing; manually re-verified the
  assertions are non-tautological by reading the implementation alongside each test.
- `components/pwa/InstallPrompt.tsx`: E1 (null on mount before the effect fires), E2
  (standalone → no listeners/render), E4 (sticky dismissal across unmount/remount), E7
  (single-use `prompt()` guarded via clearing `deferred` before awaiting; a rejected
  `prompt()` still finalizes without an unhandled rejection — confirmed via a
  `jest.fn().mockRejectedValue` test), E8 (`appinstalled` hides + marks dismissed) are all
  covered and passing.
- `app/manifest.ts`: exact field match to the spec's table, plus the explicit
  `start_url`-inside-`scope` installability check (E10) the spec names.
- `middleware.ts`: diffed against the spec's file-10 instructions — only the two new
  entries were added to `isPublicRoute`; `config.matcher` and the `auth.protect()` call are
  byte-for-byte unchanged. Confirmed live via curl (both new paths return 200 while signed
  out).
- Out-of-scope guardrails respected: no service worker, no `next-pwa`/`workbox`, no new
  dependency (`next/og` is bundled with Next 15, not added to `package.json` — confirmed).
- The manual-verification checklist was correctly copied verbatim into `changes.md` and
  left unchecked, as the spec required.

## Files touched by this stage (Testing)

None — no new test files were added. The Coder's existing test suite
(`tests/unit/lib/pwa/install.test.ts`, `tests/unit/app/manifest.test.ts`,
`tests/unit/app/install-prompt.test.tsx`) already covers the happy path, every named edge
case, and at least one failure case (rejected `prompt()`) called for by the pipeline
contract, and was independently re-run rather than trusted. This stage's contribution was
re-running lint/typecheck/test/build and performing the additional live-server behavioral
verification described above, which surfaced the finding above that unit tests alone could
not catch.
