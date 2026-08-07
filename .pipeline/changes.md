# Changes — Issue #75: [Sprint 4] PWA manifest & install prompt

## Summary

Implements the install/launch experience described in `.pipeline/spec.md`: a
Next.js web app manifest, home-screen icons (SVG for Android/Chrome, a
generated PNG apple-touch-icon for iOS), viewport/appleWebApp metadata, and a
client-side install-prompt banner (Android `beforeinstallprompt` + iOS
"Add to Home Screen" instructions). No service worker, offline caching, or new
dependency was added — out of scope per the spec.

## Files created

- `app/manifest.ts` — `MetadataRoute.Manifest` file convention (served at
  `/manifest.webmanifest`, auto-linked by Next). Fields match the spec table
  exactly: `name`/`short_name` "Graceful", `description` matching
  `app/layout.tsx`, `id: "/"`, `start_url: "/dashboard"`, `scope: "/"`,
  `display: "standalone"`, `background_color: "#ffffff"`,
  `theme_color: "#4f46e5"`, and two SVG icons (`any` + `maskable` purpose).
  `id` is typed by the installed Next version (`next/dist/lib/metadata/types/manifest-types.d.ts`),
  so no cast/drop was needed.
- `public/icons/icon.svg` — 512x512, `#4f46e5` background, 96 corner radius,
  white "G" wordmark centered (~60% canvas height via font-size).
- `public/icons/icon-maskable.svg` — same mark, full-bleed square (no corner
  radius), "G" sized to the ~40%-height Android maskable safe area.
- `app/apple-icon.tsx` — Next `apple-icon` convention using `ImageResponse`
  from `next/og` (no new dependency), 180x180 PNG, white "G" flex-centered on
  `#4f46e5`, no rounding (iOS applies its own mask).
- `lib/pwa/install.ts` — pure, DOM-free helper module (doc-comment style
  copied from `lib/invitations/state-machine.ts`): `INSTALL_DISMISSED_KEY`,
  `BeforeInstallPromptEvent` type, `isRunningStandalone`,
  `isIosInstallCapable` (iPhone/iPod/iPad UA or iPadOS-13+ spoofed
  `Macintosh` + `maxTouchPoints > 1`; excludes `CriOS`/`FxiOS`/`EdgiOS`/`OPiOS`),
  `isInstallPromptDismissed`/`markInstallPromptDismissed` (never throw; a
  storage failure reads as "not dismissed").
- `components/pwa/InstallPrompt.tsx` — client component, named export, reuses
  `components/ui/Button`. Mount effect: standalone check → dismissed check →
  register `beforeinstallprompt` (Android) and `appinstalled` listeners → iOS
  capability check. Install handler clears the deferred event *before*
  awaiting `prompt()`/`userChoice` (guards a double-click re-invoking a
  single-use event) and always finalizes (hide + mark dismissed) even if
  `prompt()` rejects. Dismiss handler marks dismissed and hides. All
  `window`/`navigator`/`localStorage` access is confined to the effect and
  handlers, never render, so SSR/first-render output is `null`.
- `components/pwa/InstallPrompt.module.css` — fixed bottom banner,
  `max-width: 480px`, `var(--color-border)`/`var(--color-bg)` tokens, 8px
  radius (top corners), `padding-bottom: max(1rem, env(safe-area-inset-bottom))`,
  dismiss button `min-height/min-width: 44px` (the `Install`/`Not now` buttons
  already meet this via `components/ui/Button.module.css`).
- `tests/unit/lib/pwa/install.test.ts` — unit tests for all four exports:
  standalone detection (display-mode match, iOS `navigator.standalone`,
  missing `matchMedia`), iOS capability rules (iPhone Safari, iPadOS-13+
  spoofed Mac + touch points, real desktop Mac with 0 touch points, `CriOS`/
  `FxiOS` exclusions, Android Chrome), and dismissal read/write including
  thrown `getItem`/`setItem`.
- `tests/unit/app/manifest.test.ts` — asserts every manifest field, plus an
  explicit check that `start_url` stays inside `scope` (installability) and
  both icons are present with `sizes: "any"`.
- `tests/unit/app/install-prompt.test.tsx` — jsdom + `@testing-library/react`,
  drives Android via a fake `beforeinstallprompt` event carrying
  `prompt`/`userChoice`, and iOS via stubbed `navigator.userAgent`/
  `maxTouchPoints`. Covers: hidden before any signal, hidden when already
  dismissed, hidden when standalone (`matchMedia` stub), Android
  install-and-hide, double-click guard (single `prompt()` call), rejected
  `prompt()` still hides without throwing, dismiss is sticky across
  unmount/remount, `appinstalled` hides + marks dismissed, iOS banner
  copy/no-Install-button, iOS dismiss.

## Files modified

- `app/layout.tsx` — added `applicationName`, `appleWebApp`, and `icons.icon`
  to the existing `metadata` object (title/description unchanged, no
  `metadata.manifest` added). Added a new `viewport` export (`themeColor`,
  `width: "device-width"`, `initialScale: 1`, `viewportFit: "cover"`).
- `app/(app)/layout.tsx` — renders `<InstallPrompt />` as a sibling after
  `{children}` inside `<AppShell>`; the pre-existing Sprint-0 TODO comment is
  left intact. Not mounted in `(marketing)`/`(auth)`/`(public)`.
- `middleware.ts` — added `"/apple-icon(.*)"` and `"/manifest.webmanifest"` to
  the `isPublicRoute` matcher array with a one-line comment (E9: `/apple-icon`
  has no dot in its path, so it would otherwise hit `auth.protect()` and 302 an
  unauthenticated request, breaking the iOS home-screen icon).
  `config.matcher` and the `auth.protect()` call are untouched.

## Notable implementation decision (not a deviation)

`lib/pwa/install.ts`'s `isRunningStandalone` takes a `navigator?: { standalone?: boolean }`
field (as specified), which TypeScript's "weak type" check rejects if you pass
the real DOM `window` object directly (`Navigator` shares no property with
`{ standalone?: boolean }` since that field is non-standard and absent from
`lib.dom.d.ts`). `components/pwa/InstallPrompt.tsx` calls it with an object
literal (`{ matchMedia: window.matchMedia?.bind(window), navigator:
window.navigator as unknown as { standalone?: boolean } }`) instead of passing
`window` directly — the cast is narrowly scoped to that one non-standard
property, not a workaround for anything in our own code, and keeps
`lib/pwa/install.ts` itself cast-free and independently testable with plain
stubs.

## Verification run

- `bun run lint` — clean.
- `bun run typecheck` — clean.
- `bun run test` — 84 suites / 1068 tests passed (includes the 3 new suites
  above).
- `bun run build` — succeeds; route list includes `○ /apple-icon` and
  `○ /manifest.webmanifest` as static routes. Note: this repo's build always
  requires *some* well-formed `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` /
  `CLERK_SECRET_KEY` (Clerk validates the key format at build time) — this is
  pre-existing and unrelated to this change; there is no local `.env` in this
  worktree, so the build was run with throwaway well-formed dummy values
  (`pk_test_...` base64 of `example.clerk.accounts.dev$`, `sk_test_dummy`)
  purely to exercise the build. Nothing was committed with real or fake
  secrets.

## Manual verification (copied verbatim from spec.md — NOT performed by this pipeline stage)

Not performable by any pipeline stage — requires physical devices per PRD §28.5.

- [ ] Chrome Android: install banner appears, "Install" adds the icon, launched app shows
      no browser chrome and lands on `/dashboard`.
- [ ] iOS Safari (iOS 16+): instruction banner appears; Share → Add to Home Screen; the
      icon is the "G" mark (not a page screenshot); launched app is full-screen.
- [ ] Chrome desktop DevTools → Application → Manifest: no errors, both icons resolve,
      "Installability: yes".
- [ ] View source of `/dashboard` contains `<link rel="manifest" href="/manifest.webmanifest">`,
      `<meta name="theme-color" content="#4f46e5">`, and
      `<meta name="apple-mobile-web-app-capable" content="yes">`.
- [ ] `/manifest.webmanifest` and `/apple-icon` both return 200 while signed out.

## What the Tester should focus on

- `lib/pwa/install.ts` unit coverage (pure, `node` environment) — especially
  the `CriOS`/`FxiOS`/`EdgiOS`/`OPiOS` exclusions and the iPadOS-13+
  `Macintosh` + `maxTouchPoints` rule (E5/E6).
- `InstallPrompt` E7 (single-use `prompt()`, rejected promise must not crash
  or leave the banner stuck) and E3 (storage-throws paths) — these are
  behavior correctness, not just "does it render".
- `app/apple-icon.tsx` is intentionally **not** imported from any Jest test
  (per spec — `next/og` is edge/wasm-only and `@swc/jest` can't load it); its
  only verification is `bun run build` succeeding and emitting the
  `○ /apple-icon` route.
- Confirm `middleware.ts`'s `config.matcher` and `auth.protect()` logic were
  left untouched — only the `isPublicRoute` array gained two entries.
