# Spec — Issue #75: [Sprint 4] PWA manifest & install prompt

## OPEN QUESTIONS

**None blocking.** The pipeline may proceed.

Decisions made in the absence of an explicit brand/design source (the repo has zero
image assets, no logo, no design tokens beyond `app/globals.css`). Implement these as
written; do not re-litigate them:

- Brand colors come from `app/globals.css`: `theme_color` = `#4f46e5` (`--color-accent`),
  `background_color` = `#ffffff` (`--color-bg`).
- The app icon is a plain wordmark: white capital "G" centered on a solid `#4f46e5`
  square. No logo exists to use instead.
- Icons ship as SVG (Chrome/Android accepts SVG manifest icons with `sizes: "any"` for
  installability) plus one generated PNG for the iOS `apple-touch-icon` (iOS ignores SVG
  there). No binary assets are checked in.
- AC bullet 4 ("Verified on iOS Safari and Chrome Android") is a **manual** step that no
  stage of this pipeline can perform. See "Manual verification" below — the Coder must
  copy that checklist verbatim into `.pipeline/changes.md` and mark it as not-yet-done
  rather than claiming it.

## Scope

Install/launch experience only. **Out of scope:** service worker, offline caching,
`next-pwa`/`workbox` or any new dependency, push notifications, native app, any change to
existing screens other than the two layout files named below.

## Current state (verified, do not re-assume)

- No `public/` directory exists; no image asset of any kind exists in the repo.
- `app/layout.tsx` exports only `metadata` (`title`, `description`). No `viewport` export,
  no icons, no manifest link, no `appleWebApp`.
- No `app/manifest.ts`, no `app/icon.*`, no `app/apple-icon.*`.
- `middleware.ts` runs `clerkMiddleware` with `config.matcher = ["/((?!_next|.*\\..*).*)",
  "/(api|trpc)(.*)"]`. Paths **containing a dot** (e.g. `/manifest.webmanifest`,
  `/icons/icon.svg`) are already excluded from the matcher. Paths **without** a dot (e.g.
  `/apple-icon`) are matched and hit `auth.protect()` — see edge case E9.
- `NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in` (`.env.example`), so sign-in is in-app and
  stays inside the manifest scope.
- Jest: `testEnvironment: "node"`, `testMatch: ["**/tests/unit/**/*.test.ts(x)"]`,
  `@/*` → repo root, `*.module.css` mocked. Component tests opt into jsdom with a
  `/** @jest-environment jsdom */` docblock (see `tests/unit/app/conflicts-list.test.tsx`).
- Prettier: 100 cols, double quotes, semicolons, trailing commas.

## Files to create

### 1. `app/manifest.ts` (new)

Next.js `MetadataRoute.Manifest` file convention; served at `/manifest.webmanifest` and
auto-linked by Next (do **not** also set `metadata.manifest` in the root layout — that
would emit a duplicate `<link rel="manifest">`).

```ts
import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest;
```

Returned object, exactly these fields:

| field              | value                                                                 |
| ------------------ | --------------------------------------------------------------------- |
| `name`             | `"Graceful"`                                                          |
| `short_name`       | `"Graceful"`                                                          |
| `description`      | `"Scheduling, setlist, and music coordination for worship teams."` (same string as `app/layout.tsx` metadata) |
| `id`               | `"/"`                                                                 |
| `start_url`        | `"/dashboard"`                                                        |
| `scope`            | `"/"`                                                                 |
| `display`          | `"standalone"`                                                        |
| `background_color` | `"#ffffff"`                                                           |
| `theme_color`      | `"#4f46e5"`                                                           |
| `icons`            | two entries, below                                                    |

```
{ src: "/icons/icon.svg",          sizes: "any", type: "image/svg+xml", purpose: "any" }
{ src: "/icons/icon-maskable.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" }
```

If `MetadataRoute.Manifest` does not type the `id` property in the installed Next
version, drop `id` — do **not** add a type cast or `@ts-expect-error`. Everything else is
mandatory.

### 2. `public/icons/icon.svg` (new)

512×512 `viewBox`, full-bleed `#4f46e5` background with rounded corners (~96 radius),
white capital "G" centered, sans-serif, heavy weight, roughly 60% of the canvas height.
Must be a standalone static SVG (no external font/image refs, no CSS `@import`).

### 3. `public/icons/icon-maskable.svg` (new)

Same mark, but built for the Android maskable safe zone: full-bleed `#4f46e5` square with
**no** corner rounding, and the "G" confined to the centered 80% safe area (i.e. ~40%
of canvas height) so platform masking never clips it.

### 4. `app/apple-icon.tsx` (new)

Next.js `apple-icon` file convention using `ImageResponse` from `next/og` (bundled with
Next 15 — do not add a dependency). Produces the PNG `apple-touch-icon` iOS needs.

```tsx
import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon(): ImageResponse;
```

Render the same mark (white "G" on `#4f46e5`, flex-centered, no rounded corners — iOS
applies its own mask). Use only inline `style` objects and system-default text; do not
load a custom font.

### 5. `lib/pwa/install.ts` (new)

Pure, DOM-free-where-possible helpers so the logic is unit-testable without a browser.
Follow the "isolated, exhaustively-testable module" doc-comment style of
`lib/invitations/state-machine.ts`. Exact exports:

```ts
export const INSTALL_DISMISSED_KEY = "graceful:pwa-install-dismissed";

// Chrome's non-standard install event. Not in lib.dom, so declare it here.
export type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

type StandaloneWindow = {
  matchMedia?: (query: string) => { matches: boolean };
  navigator?: { standalone?: boolean };
};

type DismissalStorage = Pick<Storage, "getItem" | "setItem">;

/**
 * True when the page is already running as an installed app:
 * `(display-mode: standalone)` matches (Android/Chrome) or the non-standard
 * `navigator.standalone` is true (iOS Safari). Tolerates a missing matchMedia.
 */
export function isRunningStandalone(win: StandaloneWindow): boolean;

/**
 * True only for iOS/iPadOS in a browser that can actually "Add to Home Screen"
 * (Safari). iPadOS 13+ reports a "Macintosh" UA, hence the maxTouchPoints arg.
 */
export function isIosInstallCapable(userAgent: string, maxTouchPoints: number): boolean;

/** Never throws — a storage failure reads as "not dismissed". */
export function isInstallPromptDismissed(storage: DismissalStorage | undefined): boolean;

/** Never throws. */
export function markInstallPromptDismissed(storage: DismissalStorage | undefined): void;
```

`isIosInstallCapable` rules:

- iOS device if `/iPad|iPhone|iPod/` matches the UA, **or** `/Macintosh/` matches and
  `maxTouchPoints > 1` (iPadOS 13+).
- Return `false` if the UA contains `CriOS`, `FxiOS`, `EdgiOS`, or `OPiOS` — those iOS
  browsers cannot add to the home screen.
- Return `false` for everything else.

### 6. `components/pwa/InstallPrompt.tsx` (new)

Client component, named export (matches `components/layout/AppShell.tsx` and
`components/ui/Button.tsx` conventions — `export function InstallPrompt()`, no default
export). Reuse `components/ui/Button.tsx` for the install action.

```tsx
"use client";
export function InstallPrompt(): React.ReactElement | null;
```

State: `mode: "hidden" | "android" | "ios"` (initial `"hidden"`) and
`deferred: BeforeInstallPromptEvent | null`.

Mount effect (all `window`/`navigator`/`localStorage` access lives here, never in render):

1. If `isRunningStandalone(window)` → return (stay hidden, register nothing).
2. If `isInstallPromptDismissed(window.localStorage)` → return.
3. Register `beforeinstallprompt`: `event.preventDefault()`, store the event, set mode
   `"android"`.
4. Register `appinstalled`: `markInstallPromptDismissed(window.localStorage)`, set mode
   `"hidden"`, clear the deferred event.
5. If `isIosInstallCapable(navigator.userAgent, navigator.maxTouchPoints)` → set mode
   `"ios"`.
6. Cleanup removes both listeners.

Render:

- `mode === "hidden"` → `null`.
- Otherwise a banner `<div className={styles.banner} role="region" aria-label="Install
  Graceful">` containing:
  - `"android"`: heading text `Install Graceful`, body
    `Add Graceful to your home screen for one-tap access.`, a `<Button>Install</Button>`,
    and the dismiss button.
  - `"ios"`: heading text `Install Graceful`, body
    `Tap the Share button, then "Add to Home Screen".`, and the dismiss button (no
    Install button — iOS exposes no programmatic prompt).
  - Dismiss button in both modes: `aria-label="Dismiss install prompt"`, visible label
    `Not now`.

Handlers:

- Install: if no deferred event, hide and return. Otherwise `await deferred.prompt()`,
  `await deferred.userChoice`, then — in all outcomes, including a thrown/rejected
  `prompt()` — set mode `"hidden"`, clear the deferred event, and call
  `markInstallPromptDismissed(window.localStorage)`. Guard against a second
  `prompt()` call (the event is single-use): clear `deferred` before/while awaiting so a
  double click cannot re-invoke it.
- Dismiss: `markInstallPromptDismissed(window.localStorage)` then mode `"hidden"`.

### 7. `components/pwa/InstallPrompt.module.css` (new)

Copy the token/style conventions of `app/(app)/conflicts/conflicts-list.module.css`
(`var(--color-border)`, `var(--color-fg)`, 8px radius, rem spacing). Requirements:

- `.banner` fixed to the bottom of the viewport, centered, `max-width: 480px`,
  above page content (`z-index`), 1px `var(--color-border)` border,
  `background: var(--color-bg)`, and
  `padding-bottom: max(1rem, env(safe-area-inset-bottom));` so it clears the iOS home
  indicator in standalone mode.
- Buttons meet PRD A-08: `min-height: 44px; min-width: 44px;`.

## Files to modify

### 8. `app/layout.tsx`

- Keep `title`/`description` unchanged. Add to `metadata`:
  - `applicationName: "Graceful"`
  - `appleWebApp: { capable: true, title: "Graceful", statusBarStyle: "default" }`
    (this is what gives iOS the full-screen, no-browser-chrome launch — AC bullet 3)
  - `icons: { icon: [{ url: "/icons/icon.svg", type: "image/svg+xml" }] }`
- Add a new export (Next 15 warns on `themeColor` inside `metadata`):

```ts
import type { Metadata, Viewport } from "next";

export const viewport: Viewport = {
  themeColor: "#4f46e5",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};
```

- Do **not** add `metadata.manifest` (see file 1). Do not touch `ClerkProvider` or the
  `html`/`body` structure.

### 9. `app/(app)/layout.tsx`

Render the prompt inside the existing shell; leave the TODO comment intact:

```tsx
<AppShell>
  {children}
  <InstallPrompt />
</AppShell>
```

Import as `import { InstallPrompt } from "@/components/pwa/InstallPrompt";`. Do not mount
it in `(marketing)`, `(auth)`, or `(public)` layouts.

### 10. `middleware.ts`

Add `"/apple-icon(.*)"` and `"/manifest.webmanifest"` to the `createRouteMatcher` array in
`isPublicRoute`, with a one-line comment explaining why (PWA install assets must be
fetchable by the browser/OS with no session). Change nothing else in the file — the
`config.matcher` and `auth.protect()` logic stay as-is.

## Edge cases the implementation must handle

- **E1 — SSR/hydration:** the component must render `null` on the server and on first
  client render. No `window`, `navigator`, `localStorage`, or `matchMedia` access outside
  `useEffect`.
- **E2 — Already installed:** when launched from the home screen
  (`display-mode: standalone`, or `navigator.standalone === true` on iOS), the banner
  never renders and no listeners are attached.
- **E3 — Storage unavailable:** Safari private mode / disabled storage makes
  `localStorage` access throw. `isInstallPromptDismissed` and
  `markInstallPromptDismissed` swallow the error; a read failure means "not dismissed" and
  a write failure must not break the dismiss/install click.
- **E4 — Dismissal is sticky:** once dismissed (or installed, or prompted), the banner
  does not come back on later visits in that browser.
- **E5 — Non-Safari iOS browsers:** Chrome/Firefox/Edge/Opera on iOS (`CriOS`, `FxiOS`,
  `EdgiOS`, `OPiOS`) get no banner — they cannot add to the home screen and the
  instructions would be wrong.
- **E6 — iPadOS 13+ UA spoofing:** a `Macintosh` UA with `maxTouchPoints > 1` counts as
  iOS; a real desktop Mac (`maxTouchPoints === 0`) does not.
- **E7 — Single-use prompt:** `BeforeInstallPromptEvent.prompt()` may be called at most
  once; a rejected `prompt()`/`userChoice` must hide the banner without an unhandled
  rejection or crash.
- **E8 — `appinstalled` fired from elsewhere** (e.g. the browser's own menu install) hides
  the banner and records the dismissal.
- **E9 — Auth-gated PWA assets:** `/apple-icon` has no dot in its path, so the existing
  `middleware.ts` matcher *does* run Clerk on it and would 302 an unauthenticated
  request to sign-in — which breaks the iOS home-screen icon. File 10 is not optional.
- **E10 — Chrome installability:** the manifest must keep `display: "standalone"`, a
  same-origin `start_url` inside `scope`, and at least one icon Chrome accepts
  (SVG with `sizes: "any"` qualifies). Any `start_url` outside `scope` silently kills
  installability.
- **E11 — Desktop Chrome also fires `beforeinstallprompt`:** the banner appearing on
  desktop Chrome is intended behavior, not a bug. Do not gate the Android branch on a UA
  check.
- **E12 — Early `beforeinstallprompt`:** Chrome can fire the event before React mounts, in
  which case the banner will not appear until a reload. Accepted limitation for this
  issue; do **not** add a document-level capture script to work around it.

## Testability notes (for the Testing stage)

- `lib/pwa/install.ts` is pure and runs under the default `node` Jest environment; feed it
  literal UA strings and plain `{ getItem, setItem }` / `{ matchMedia, navigator }` stubs.
  Suggested path: `tests/unit/lib/pwa/install.test.ts`.
- `app/manifest.ts` is a plain function — import the default export and assert the fields
  in the table above. Suggested path: `tests/unit/app/manifest.test.ts`.
- `components/pwa/InstallPrompt.tsx` needs the `/** @jest-environment jsdom */` docblock
  and `@testing-library/react`, exactly like `tests/unit/app/conflicts-list.test.tsx`.
  Drive the Android path by dispatching a fake `beforeinstallprompt` event on `window`
  carrying `prompt`/`userChoice`; drive the iOS path by stubbing
  `navigator.userAgent`/`maxTouchPoints`.
- **Do not import `app/apple-icon.tsx` from a Jest test** — `next/og` pulls in
  edge/wasm-only code that `@swc/jest` will not load. It is verified by `bun run build`.

## Verification the Coder must run

`bun run lint`, `bun run typecheck`, `bun run test`, and `bun run build` (the build is the
only thing that exercises `app/manifest.ts` and `app/apple-icon.tsx` as routes).

## Manual verification (copy into `.pipeline/changes.md`, unchecked)

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
