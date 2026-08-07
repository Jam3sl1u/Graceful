# Review — Issue #75: [Sprint 4] PWA manifest & install prompt

## VERDICT: NEEDS WORK

The Android/Chrome half of this feature is solid and well tested. The **iOS half is
broken in a way no test in this repo can see**: the generated apple-touch-icon is
built but never referenced by any page, and the `apple-mobile-web-app-capable` tag
the spec's own checklist requires is not emitted. Two of the issue's acceptance
criteria (iOS home-screen icon, iOS full-screen launch) would fail on a real device
today, with 1068/1068 tests green.

Both fixes are in one file (`app/layout.tsx`) and total ~4 lines.

---

## BLOCKING FINDING 1 — `<link rel="apple-touch-icon">` is never emitted; `app/apple-icon.tsx` is dead weight

**Where:** `app/layout.tsx:10` (`icons: { icon: [...] }`) interacting with
`app/apple-icon.tsx`.

**Evidence (empirical, not theoretical).** Inspected the prerendered HTML from the
production build already present in this worktree:

```
$ grep -c "apple-touch-icon\|apple-icon" .next/server/app/dashboard.html
0
$ grep -o '<link rel="[^"]*"[^>]*>' .next/server/app/dashboard.html
<link rel="manifest" href="/manifest.webmanifest"/>
<link rel="icon" href="/icons/icon.svg" type="image/svg+xml"/>
```

`/apple-icon` *is* built (`.next/server/app/apple-icon.body` = `PNG image data,
180 x 180`, 200 OK — the Tester's curl was correct), but **zero** HTML pages link to
it.

**Root cause.** In Next 15.5.22, file-convention icons are only merged in when the
route has no explicit `metadata.icons`
(`node_modules/next/dist/lib/metadata/resolve-metadata.js:703-715`):

```js
if (leafSegmentStaticIcons.icon.length > 0 || leafSegmentStaticIcons.apple.length > 0) {
    if (!resolvedMetadata.icons) {          // <-- our metadata.icons is set, so this is false
        resolvedMetadata.icons = { icon: [], apple: [] };
        ... unshift(...leafSegmentStaticIcons.apple)
    }
}
```

Because `app/layout.tsx` sets `icons: { icon: [...] }`, the `apple` entry contributed
by `app/apple-icon.tsx` is silently discarded. This is a genuine spec/framework
interaction the spec did not anticipate: spec files 4 and 8 are individually correct
but mutually exclusive as written.

**Impact.** iOS has no apple-touch-icon link, and there is no `/apple-touch-icon.png`
at the site root to fall back to; the manifest's only icons are SVG, which iOS
ignores (the spec says so itself). The home-screen icon degrades to a page
screenshot — exactly the failure mode AC bullet 2 / the manual checklist calls out
("the icon is the 'G' mark (not a page screenshot)"). The whole of
`app/apple-icon.tsx` currently does nothing.

**Fix (minimal, preferred).** In `app/layout.tsx`, name the apple icon explicitly:

```ts
icons: {
  icon: [{ url: "/icons/icon.svg", type: "image/svg+xml" }],
  apple: [{ url: "/apple-icon", sizes: "180x180", type: "image/png" }],
},
```

(Alternative, if you'd rather stay on the file convention: drop `metadata.icons`
entirely and move the favicon to `app/icon.svg` so both file conventions are picked
up. More churn, and it duplicates the asset that `app/manifest.ts` points at, so the
explicit `apple` entry above is the smaller change.)

**Verification required after the fix** — a Jest test cannot catch this (importing
`app/layout.tsx` fails under Jest: plain `./globals.css` is not in the config's
`moduleNameMapper`). Re-run `bun run build` and confirm:

```
grep -o '<link rel="apple-touch-icon"[^>]*>' .next/server/app/dashboard.html
```

returns a match. Please paste that output into `changes.md`.

---

## FINDING 2 (must fix alongside 1) — `apple-mobile-web-app-capable` is not emitted

The Testing stage flagged this and it is confirmed independently. Rendered head from
the build contains `<meta name="mobile-web-app-capable" content="yes">` and nothing
Apple-prefixed; `node_modules/next/dist/lib/metadata/generate/basic.js:263` shows
Next 15.5.22's `AppleWebAppMeta` only emits the un-prefixed name for
`appleWebApp.capable`.

The spec's own manual-verification checklist requires
`<meta name="apple-mobile-web-app-capable" content="yes">` in the page source, so
that checklist item is guaranteed to fail as shipped, and AC bullet 3 (full-screen
launch, no browser chrome) is at risk on the iOS 16.x devices the spec names —
older iOS honours only the Apple-prefixed tag, and manifest-`display` support is the
newer path.

**Fix:** in `app/layout.tsx`'s `metadata`, add

```ts
other: { "apple-mobile-web-app-capable": "yes" },
```

alongside the existing `appleWebApp` (keep `appleWebApp` — it is what produces
`apple-mobile-web-app-title` / `-status-bar-style`). Harmless on every other
platform; belt-and-braces with the manifest's `display: "standalone"`.

---

## What I verified independently (and what is genuinely good)

Re-ran everything rather than trusting `changes.md` / `test-results.md`:

- `bun run typecheck` clean, `bun run lint` clean, `bun run test` → **84 suites /
  1068 tests passed**, matching both prior stages' claims exactly.
- New suites in isolation → 3 suites / 28 tests.
- Read the full `git diff main...HEAD`. No scope creep: nothing outside the 10 files
  the spec names (plus the 3 test files), no new dependency, no service worker,
  `middleware.ts`'s `config.matcher` and `auth.protect()` untouched.
- Verified the built artifacts on disk: `/manifest.webmanifest` body matches the
  spec's field table byte for byte (E10: `start_url: "/dashboard"` is inside
  `scope: "/"`); `/apple-icon` is a real 180x180 PNG and renders the white "G" on
  `#4f46e5` (viewed it — the `fontWeight: 700` doesn't take effect with next/og's
  bundled default font, purely cosmetic, not worth a round trip).

Quality notes on the code itself:

- `lib/pwa/install.ts` is genuinely pure and the E5/E6 rules match the spec exactly.
  The tests are non-tautological — real UA strings, both storage-throw paths, and a
  desktop-Mac-with-0-touch-points negative case.
- `components/pwa/InstallPrompt.tsx` handles E1/E2/E3/E4/E7/E8 correctly. The E7
  guard is real: `setDeferred(null)` runs synchronously before the first `await`,
  so a second click genuinely sees `null` — remove it and
  `expect(prompt).toHaveBeenCalledTimes(1)` fails. `finally` finalizes on a rejected
  `prompt()`. Good.
- `middleware.ts`: the two added entries are correctly scoped and cannot widen
  access to anything else; `isPublicRoute` has no other consumer in the repo. E9 is
  properly addressed (and the Tester's signed-out 200 on `/apple-icon` confirms it).
- Button reuse is correct — `components/ui/Button` forwards `className`/`aria-label`
  and already carries `min-height/min-width: 44px`, so PRD A-08 holds (the extra
  `.dismiss` rule is redundant but harmless).

## Non-blocking observations (do NOT fix in this pass)

- Manifest ships SVG-only icons. Chromium accepts `sizes: "any"` SVG for
  installability, so this should be fine, but there is no PNG 192/512 fallback for
  tooling that doesn't (some Android launchers, older Lighthouse). Worth a follow-up
  issue if the manual Chrome-Android check shows anything odd — not a blocker here,
  the spec made this call deliberately.
- `.pipeline/test-results.md` is currently uncommitted (`git status` shows ` M`).
  Commit it with the fix so the handoff artifacts stay in sync.
- E12 (early `beforeinstallprompt` before hydration) remains an accepted limitation
  per spec. Fine.

## Definition of done for the next pass

1. `app/layout.tsx`: add `icons.apple` pointing at `/apple-icon`.
2. `app/layout.tsx`: add `other: { "apple-mobile-web-app-capable": "yes" }`.
3. Re-run `bun run lint`, `bun run typecheck`, `bun run test`, `bun run build`.
4. Paste the `grep` output proving both `<link rel="apple-touch-icon" ...>` and
   `<meta name="apple-mobile-web-app-capable" content="yes">` now appear in
   `.next/server/app/dashboard.html` into `changes.md`.
5. Nothing else changes.
