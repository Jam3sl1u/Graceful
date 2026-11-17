# Graceful design system

The shared foundation every screen is built on. It is deliberately small:
each piece exists because [the frontend audit](frontend-audit.md) found the
same thing re-implemented in several screens.

Styling approach is unchanged from the rest of the repo: **CSS Modules plus
CSS custom properties**. No CSS framework and no component library were added.

## Principles

1. **Navy, white, yellow.** Navy is structure and text, white is surface,
   yellow is the one thing on the screen you should do next.
2. **Tokens, never literals.** Components use semantic tokens (`--surface`,
   `--text`, `--primary`). A hex value in a component module is a bug.
3. **Phone first.** Every control is at least 44 px; every layout is a single
   column until there is room for more.
4. **Every screen has four states**: loading, empty, error (with offline), and
   no-access. They are components, not ad hoc paragraphs.
5. **Colour is never the only signal.** Status always has a word or an icon.

## Tokens

Defined in [`app/globals.css`](../app/globals.css).

### Colour

| Token | Light | Dark | Use |
| ----- | ----- | ---- | --- |
| `--bg` | `#f3f6fc` | `#060f26` | Page background |
| `--surface` | `#ffffff` | `#0e1c40` | Cards, inputs, dialogs |
| `--surface-sunken` | `#eaeff8` | `#0a1633` | Hover fills, inset blocks |
| `--text` | `#0b1f4b` | `#edf1fb` | Body text and headings |
| `--text-muted` | `#4a5878` | `#a9b5d3` | Secondary text |
| `--border` / `--border-strong` | `#d5dcec` / `#8793b0` | `#25376a` / `#6f80ad` | Dividers / control outlines |
| `--primary` / `--on-primary` | navy `#0b1f4b` / white | yellow `#f7b500` / navy | Standard filled button |
| `--accent` / `--on-accent` | yellow `#f7b500` / navy `#071433` | same | The single key action |
| `--link` | `#24479b` | `#9fb9ff` | Links, ghost buttons |
| `--danger` | `#b42318` | `#ff8a7d` | Destructive outline, error text |
| `--focus-ring` | yellow | yellow | Focus outline (see below) |
| `--shell-bg` | navy `#0b1f4b` | `#091631` | Sidebar, tab bar, public header |

Status tones come in background/foreground pairs —
`--tone-{neutral,info,success,warning,danger}-{bg,fg}` — and are what `Badge`,
state icons and alert banners use.

The raw palette (`--navy-50…950`, `--yellow-100/400/500`) exists so the
semantic tokens have something to point at. Reach for it directly only on
surfaces that are navy in *both* themes (the shell).

Dark mode follows `prefers-color-scheme` and is a pure token swap. There is no
in-app toggle.

### Type

System font stack (`--font-sans`) — no web font is loaded, which keeps the CSP
unchanged. Scale: `--text-xs` 12 · `--text-sm` 14 · `--text-md` 16 ·
`--text-lg` 18 · `--text-xl` 22 · `--text-2xl` 28 · `--text-3xl` 36.
`h1` is `2xl/700`, `h2` is `lg/700`, `h3` is `md/600`, set globally.

### Spacing, shape, elevation, motion

- Spacing, 4 px base: `--space-1` 4 · `2` 8 · `3` 12 · `4` 16 · `5` 24 · `6` 32
  · `7` 48 · `8` 64.
- Radius: `--radius-sm` 6 · `--radius-md` 10 (controls) · `--radius-lg` 16
  (cards, dialogs) · `--radius-full` (pills, avatars).
- Shadow: `--shadow-sm` (cards) · `--shadow-md` (hover) · `--shadow-lg`
  (dialogs, toasts).
- Motion: `--duration-fast` 120 ms · `--duration-base` 200 ms · `--ease-out`.
  All animation is disabled under `prefers-reduced-motion`.

### Layout

- `--tap-target: 44px` — minimum height and width of anything clickable.
- `--page-gutter` — 16 px on phones, 24 px from 640 px.
- `--shell-bottom` — the height the mobile tab bar occupies. Anything fixed or
  sticky to the bottom of the viewport must offset by it (the setlist action
  bar, toasts and the install banner do).

Breakpoints (plain media queries): **640 px** (two-up forms), **900 px** (tab
bar becomes sidebar), **1100 px** (screens with a side panel go two-column).

### Focus

One rule for the whole app: a 3 px yellow outline with a 2 px navy inner
edge, on `:focus-visible`. The two-tone ring stays visible on white, navy and
yellow backgrounds. Do not remove outlines in component CSS.

## Primitives

All in [`components/ui/`](../components/ui/).

| Component | Replaces (audit) | Notes |
| --------- | ---------------- | ----- |
| `Button`, `ButtonLink` | Per-screen button overrides; hand-rolled link-buttons | Variants `primary`, `accent`, `secondary`, `ghost`, `danger`; sizes `sm`, `md`, `lg`; `fullWidth`; `loading` shows a spinner and sets `aria-busy`. Defaults to `type="button"`. |
| `InputField`, `TextareaField`, `SelectField` | Unstyled or ad hoc inputs on 5 screens | Visible label, optional hint, and an error wired up with `aria-describedby` + `aria-invalid`. `controlClassName` is exported for a bare control that needs a custom label. 16 px font so iOS does not zoom. |
| `Card`, `CardHeader`, `interactiveCardClassName` | The same border/radius rule in 8 modules | `as` picks the element (`section`, `li`, `form` …). |
| `Badge` | Hard-coded palette | Tones `neutral`, `info`, `success`, `warning`, `danger`. |
| `Modal` | Inaccessible modal + a second hand-built sheet | `role="dialog"`, `aria-modal`, labelled by `title`, focus trap, Escape, backdrop click, focus restored on close. Centred from 640 px, bottom sheet below. |
| `ToastProvider`, `useToast` | Silent saves | Polite live region. A toast only *confirms* what the screen already shows — never the only place a result or error appears. No-op without a provider. |
| `LoadingState`, `Skeleton` | `<p>Loading…</p>` on 9 screens | Skeleton layout plus one announced "Loading…". |
| `EmptyState` | Bare "No X yet" sentences | Icon, title, optional help text and action. |
| `ErrorState`, `ErrorAlert` | Dead-end error screens | `ErrorState` is for a failed *load*: retry button, detects offline and retries on reconnect. `ErrorAlert` is for a failed *action* on a screen that still works. |
| `NoAccessState`, `NoticeState`, `SuccessState` | `<h1>` used as a status message | Role-forbidden, neutral terminal (expired / not found) and positive terminal states. |
| `Page`, `PageHeader` | Three different page paddings | The screen's `<main id="main">`; widths `narrow` 520 · `medium` 720 · `wide` 1200. |
| `Avatar`, `getInitials` | Two copies | Decorative; always shown beside the name. |
| `Icon` | Emoji | Inline SVG, `currentColor`, `aria-hidden`. Name the control, not the icon. |

Layout components in [`components/layout/`](../components/layout/): `AppShell`
(sidebar ≥ 900 px, bottom tab bar below; skip link; hosts `ToastProvider`),
`PublicHeader`, `Logo`, `NotificationBell`.

Shared formatting in [`lib/format/dates.ts`](../lib/format/dates.ts) replaces
six copies of `formatServiceDate` and the raw `toLocaleString()` timestamps.

## Recipes

**A data screen.** Keep the existing `view` state machine and render one
state component per branch:

```tsx
if (view === "loading") return <Page><LoadingState cards={3} /></Page>;
if (view === "forbidden") return <Page><NoAccessState>…</NoAccessState></Page>;
if (view === "error") return <Page><ErrorState onRetry={retry} /></Page>;
```

`retry` bumps a `reloadKey` in the load effect's dependency list.

**A form field with an error.**

```tsx
<InputField label="Guest email" type="email" error={emailError} hint="We'll send the invite here." />
```

**Choosing a button.** One `accent` per screen at most (Accept, Publish).
`primary` for the normal confirm. `secondary` for the alternative. `ghost` for
cancel/back. `danger` for remove.

## Copy rules

- Sentence case for buttons and headings.
- Errors say what happened and what to do next, and never blame the person:
  "That's on our side, not yours. Please try again."
- A week with no title is "Untitled service".
- No issue numbers, enum values or status codes in anything a user reads.

## Not included, on purpose

Tabs, dropdown menus, tooltips, date pickers, tables and a theme toggle — no
existing screen needs them. Add them when a second screen does.
