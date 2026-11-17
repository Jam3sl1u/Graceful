# Frontend audit — existing screens (pre-Phase 2)

Date: 2026-11-16 · Branch: `frontend-quality-pass` · Scope: every screen under
`app/(app)`, `app/(public)`, `app/(auth)`, `app/(marketing)` and the shared
components in `components/`. Nothing was fixed while writing this document.

## How this was reviewed

- **Code**: every screen component and CSS module was read in full.
- **Running app**: the public screens were opened in the dev server directly.
  The authenticated screens sit behind Clerk's hosted sign-in, which an agent
  must not log into, so they were rendered through a local-only harness (not
  committed) that mounts the real screen components inside the real `AppShell`
  with a mocked `fetch`. Layout, states, and measurements are therefore real;
  the data is fixture data.
- **Viewports**: 375, 768 and 1280 px. Screenshots are in
  [`frontend-audit/before/`](frontend-audit/before/).
- **Dark mode**: the app has no dark theme at all (`globals.css` defines four
  light-only variables), so there was nothing to review. Recorded as a finding.
- **Measured, not eyeballed**: horizontal overflow (`scrollWidth − innerWidth`)
  and every interactive element smaller than 44 px were measured in the browser.

Severity: **S1** blocks a task or breaks a screen · **S2** clearly hurts
usability or accessibility · **S3** polish / inconsistency.

## Screen inventory

| # | Route | File | Role(s) | State before |
| - | ----- | ---- | ------- | ------------ |
| 1 | `/invitations/[id]` | `app/(app)/invitations/[id]/invitation-response.tsx` | Member, Guest | Functional, unpolished |
| 2 | `/invite/[token]` | `app/(public)/invite/[token]/invite-response.tsx` | Anyone with link | Near-duplicate of #1 |
| 3 | `/member-week/[id]` | `app/(app)/member-week/[id]/member-week-view.tsx` | Member | Functional |
| 4 | `/week/[id]` | `app/(app)/week/[id]/week-view.tsx` | Set Leader, Admin | Functional, two dead buttons |
| 5 | `/setlists/[id]` | `app/(app)/setlists/[id]/setlist-builder.tsx` | Set Leader, Admin | Functional, desktop-only layout |
| 6 | `/notifications` | `app/(app)/notifications/notification-inbox.tsx` | All signed-in | Functional |
| 7 | `/dashboard` | `app/(app)/dashboard/admin-dashboard.tsx` | Set Leader, Admin | Functional |
| 8 | `/conflicts` | `app/(app)/conflicts/conflicts-list.tsx` | Set Leader, Admin | Functional |
| 9 | `/conflicts/[id]` | `app/(app)/conflicts/[id]/conflict-resolution.tsx` | Set Leader, Admin | Functional, one dead link |
| 10 | `/profile` | `app/(app)/profile/page.tsx` | All signed-in | Stub (inline styles) |
| 11 | `/documents` | `app/(app)/documents/page.tsx` | — | "Coming soon" stub |
| 12 | `/join/[code]` | `app/(public)/join/[code]/join-form.tsx` | Signed-in invitee | Unstyled |
| 13 | `/guest/[token]` | `app/(public)/guest/[token]/*` | Guest | Unstyled |
| 14 | `/sign-in`, `/sign-up` | `app/(auth)/*` | Anyone | Clerk default widget |
| 15 | `/` | `app/(marketing)/page.tsx` | Anyone | Two lines of text |

Shared components: `AppShell`, `NotificationBell`, `PublicHeader`,
`InstallPrompt`, `ui/Button`, `ui/Badge`, `ui/Modal`.

Missing entirely: `app/not-found.tsx`, `app/error.tsx`, `app/global-error.tsx`,
any `loading.tsx`, and a layout for the `(public)` group (so `/invite`, `/join`
and `/guest` render with no header or brand at all).

## The five screens that matter most

Ordered by how many people hit them and how costly a failure is:

1. **Invitation response** (`/invitations/[id]` and `/invite/[token]`) — the
   single action the whole scheduling loop depends on, almost always opened on
   a phone from a text or email.
2. **Member week view** — what every confirmed member opens before rehearsal.
3. **Week view** — the Set Leader's working surface for a service.
4. **Setlist builder** — the most interaction-heavy screen in the app.
5. **Notification inbox** — the hub that routes people to 1–4.

This matches the guess in the brief. The **AppShell** is ranked above all five
for ordering purposes, because its bug (below) breaks every one of them on a
phone.

## Measurements (before)

Horizontal overflow in px at each width, and count of interactive elements
under 44 px.

| Screen | 375 | 768 | 1280 | Targets < 44 px |
| ------ | --- | --- | ---- | --------------- |
| Invitation (in-app) | **70** | 0 | 0 | 0 |
| Invite (public) | 0 | 0 | 0 | 0 |
| Member week | **15** | 0 | 0 | 2 (file links, 18 px tall) |
| Week view | **393** | 0 | 0 | 5 (week arrows 14×18, both guest inputs 21 px, Collapse 68×21) |
| Setlist builder | **795** | **402** | 0 | 7 (search 33 px, key selects 19 px, notes 30 px) |
| Notifications | **72** | 0 | 0 | 6 (five filter chips 30 px, "Mark all read" 21 px) |
| Dashboard | 0 | 0 | 0 | 3 (date inputs 21 px, select 19 px) |
| Conflicts list | 0 | 0 | 0 | 0 |
| Conflict detail | **70** | 0 | 0 | 0 |
| Join | 0 | 0 | 0 | 1 (button 78×21) |
| Guest claim | 0 | 0 | 0 | 1 (button 193×21) |

## Cross-cutting findings

These recur on most screens and are the reason Step 2 (the design foundation)
exists. Each is listed once here rather than repeated per screen.

### X1 · App shell is desktop-only — S1

`AppShell.module.css` gives the sidebar a fixed `width: 220px` with no
breakpoint. At 375 px the content column is 155 px wide. This is the direct
cause of six of the seven overflow results above and makes every authenticated
screen close to unusable on a phone — the device most members use.

### X2 · The shell has no navigation — S1

The sidebar contains the word "Graceful" and a bell. There is no link to the
dashboard, conflicts, profile, or the user's own week, no account menu and no
sign-out. Every screen other than notifications is reachable only by a
notification link or by typing a URL. (The code has a `TODO(Sprint 1+)` for
this.)

### X3 · Nested `<main>` landmarks — S2

`AppShell` renders `<main>` and every screen inside it renders its own
`<main>`. Two nested main landmarks is invalid and confuses screen-reader
landmark navigation. There is also no skip link.

### X4 · No brand, no tokens — S2

`globals.css` has four variables. The accent is indigo `#4f46e5`, not the
brand navy/yellow. Everything else is hard-coded per file: the error red
`#b42318` appears in 7 modules, the same "card" rule (1 px border, 8 px
radius) is re-declared in 8, the avatar in 2, an `.srOnly` class in 1, an
accept-green `#1a7f37` in 2. There is no spacing, type, radius or shadow
scale; page padding is `3rem 1.5rem` on some screens, `2rem 1.5rem` on others
and `1.5rem 1rem` on one. Heading sizes are browser defaults.

### X5 · Form controls are browser defaults — S2

Only `Button` is shared. Every `<input>`, `<select>` and `<textarea>` is
either unstyled (dashboard filters, guest invite form, join/guest buttons) or
styled ad hoc with different padding per screen. Most are 19–33 px tall.

### X6 · Loading is a bare "Loading…" paragraph everywhere — S2

All nine data screens render `<p>Loading…</p>`: no skeleton, so the layout
jumps when data arrives, and no `role="status"`, so it is not announced.

### X7 · Error states are dead ends — S2

Every screen's error state is "Something went wrong / Please try again later."
with no retry button and no way back. None distinguishes being offline from a
server failure. Error text is an `<h1>`, and the state is not announced.

### X8 · No offline state anywhere — S2

A failed `fetch` (airplane mode, a church basement) is indistinguishable from
a 500. For an installable PWA this is the most likely failure in the field.

### X9 · No visible focus treatment, links look like text — S2

`globals.css` sets `a { color: inherit; text-decoration: none }` and defines
no `:focus-visible` style. Links that are not manually restyled (member-week
document links, the public invite's links) are indistinguishable from body
text. Focus rings are whatever the browser gives, and are invisible on several
bordered cards.

### X10 · Dialogs are not accessible — S2

`ui/Modal` has no `role="dialog"`, no `aria-modal`, no label, no focus
management, no Escape key, and a `min-width: 320px` that overflows a phone.
The member-week event sheet has `role="dialog"` but the same gaps. The week
view uses a blocking `window.confirm` for the double-booking warning.

### X11 · Emoji as icons — S3

The bell, all 15 notification type icons, the chat button, the drag handle and
the success check mark are emoji or text glyphs. They render differently per
platform, ignore the colour scheme and cannot be themed.

### X12 · No dark mode — S3

No `prefers-color-scheme` support and `themeColor` is the off-brand indigo.

### X13 · Duplicated helpers — S3

`formatServiceDate` is copy-pasted into 6 files, `getInitials` into 2, and the
in-app and public invitation screens are ~340 lines each with a 60-line diff.

### X14 · Terminology drift — S3

- Decline / Declined / "denied" (API status leaks into nothing visible, but
  "Response recorded" hides which answer was recorded).
- A week with no title is "Untitled service" on three screens and "Service"
  on three others.
- "Global dashboard" (jargon from the PRD) for what users would call
  "Schedule" or "Service weeks".
- Title Case buttons on the conflict screen ("Mark as Resolved", "Find a
  Replacement") versus sentence case everywhere else.
- Internal issue numbers shown to users: "until email delivery is available,
  #68".

## Per-screen findings

Only problems specific to the screen are listed; X1–X14 apply on top.

### 1–2 · Invitation response (in-app and public)

| Sev | Category | Problem |
| --- | -------- | ------- |
| S1 | Mobile | In-app version overflows by 70 px at 375 (X1). |
| S2 | States | A network failure shows "We couldn't find this invitation." — wrong and alarming. No offline or retry path. |
| S2 | Copy | `responseDeadline` is fetched and never shown. The member is not told by when to answer. |
| S2 | Copy | "Keep it" (cancel declining) is ambiguous; "Go to the app" says nothing about where. "Response recorded" after declining does not say what was recorded. |
| S2 | A11y | State messages ("This invitation has expired.") are the `<h1>`; success is not announced (`role="status"` missing); the ✓ is a text glyph. |
| S2 | A11y | Decline textarea has no character count for its 200 limit; focus is not moved into the form when it appears. |
| S2 | Design | Accept is an ad hoc green override of the primary button; event rows have no icons or type; role note is a bold-prefixed paragraph. |
| S3 | Design | Public version has no header, logo or footer — a stranger arriving from an email sees an unbranded card. |
| S3 | Roles | Guests get the identical screen with no acknowledgement that they are a guest. |

### 3 · Member week view

| Sev | Category | Problem |
| --- | -------- | ------- |
| S2 | Copy | Event times use `toLocaleString()`: "11/19/2026, 7:00:00 PM". Seconds, no weekday, and the end time repeats the full date. |
| S2 | Copy | Event type is the raw enum with `text-transform: capitalize`: "Sound_check", "Pre_practice". |
| S2 | A11y | Document links are unstyled (X9), 18 px tall, open a new tab without saying so, and show no file type or size though both are in the payload. |
| S2 | A11y | Event sheet: no focus trap, no Escape, backdrop click does nothing, focus is not returned (X10). |
| S2 | Mobile | A disabled "Week chat (coming soon)" floating button is fixed over the content on every scroll position and sits where the install banner appears. It advertises a Phase 2 feature. |
| S2 | States | No distinct offline state; forbidden and not-found have no way out. |
| S3 | Design | Setlist rows are not numbered though order is the point; key is a faint right-aligned letter with no label; team shows instruments but drops `vocalCapability`. |
| S3 | Mobile | 15 px overflow at 375 from the long member name row. |

### 4 · Week view (Set Leader / Admin)

| Sev | Category | Problem |
| --- | -------- | ------- |
| S1 | Mobile | 393 px overflow at 375: the availability sidebar is a fixed 320 px beside the content with no stacking breakpoint. |
| S1 | Function | "+ Add event" and "Edit setlist" are live-looking buttons with no handler; "0 songs" and the "Draft" badge are hard-coded. See "Needs human decision". |
| S2 | A11y | Availability grid conveys available / unavailable / unknown by colour alone (red/green), with no text, no legend, no table semantics and no accessible names. |
| S2 | A11y | Guest invite inputs have placeholder-only labelling (`aria-label` present, no visible label) and are 21 px tall. Errors are not tied to the field. |
| S2 | A11y | Week arrows are 14×18 px plain-text `←` `→` using `<a href>` (full page reload) and an `aria-disabled` span when absent. |
| S2 | Design | Double-booking warning is a `window.confirm`. |
| S2 | Copy | Guest setup link paragraph exposes "#68"; the raw API `error` string is shown for guest-invite failures. |
| S3 | Design | Roster "Open" badge + "+ Invite" button: status vocabulary (Open/Pending/Confirmed/Declined/Conflict) has no legend; no summary count ("4 of 6 confirmed"). |
| S3 | Mobile | "Collapse" is a 68×21 native button; collapsed state still occupies the column. |

### 5 · Setlist builder

| Sev | Category | Problem |
| --- | -------- | ------- |
| S1 | Mobile | 795 px overflow at 375 and 402 px at 768. Two fixed columns (360 px + rest) never stack; each setlist row is a single non-wrapping flex line of six controls. |
| S1 | A11y | Reordering is drag-and-drop only. No keyboard path and HTML5 drag does not work on touch, so the order cannot be changed on a phone or without a mouse. |
| S2 | A11y | Search box, per-row key `<select>` and notes input have no label (placeholder only, or nothing). |
| S2 | Mobile | The fixed bottom bar spans the full viewport including under the sidebar, covers the install banner, and floats above the on-screen keyboard while typing notes. |
| S2 | States | Publish and Unlock have no pending state (double-submit possible); saves are silent — no "Saved" confirmation; a failed catalog load silently shows an empty list. |
| S2 | Design | The page title is "Setlist Builder" with no indication of which service it belongs to. |
| S3 | Copy | "— none —" for no key; "Added" as a disabled button label. |

### 6 · Notification inbox

| Sev | Category | Problem |
| --- | -------- | ------- |
| S1 | Mobile | 72 px overflow at 375 (X1). |
| S2 | A11y | Filter chips are 30 px tall, wrapped in a `<nav>` although they filter rather than navigate. |
| S2 | A11y | "Mark all read" is an unstyled 21 px native button. The result is not announced. |
| S2 | States | "Showing the 50 most recent of 73 notifications." with no way to see the rest. See "Needs human decision". |
| S2 | Design | Unread is a 3 px left border plus bold; rows with no destination are buttons that appear clickable and do nothing visible. |
| S3 | A11y | Bell badge has an `aria-label` on a `<span>` inside a link that already has `aria-label="Notifications"`, so the count is never read. Count changes are not announced. |
| S3 | Copy | Empty filter text "No Invitations notifications." |

### 7 · Dashboard

| Sev | Category | Problem |
| --- | -------- | ------- |
| S2 | States | Changing any filter sets the whole view back to "Loading…", unmounting the filter controls — focus is lost on every change. |
| S2 | Roles | A Member who lands here gets a "no access" dead end with no link to anything they can use. |
| S2 | Design | Unstyled date inputs and select (X5); no summary, no grouping of upcoming versus past, cancelled weeks look like active ones. |
| S3 | Copy | "Global dashboard"; filter error blames the input without marking the field. |

### 8–9 · Conflicts list and detail

| Sev | Category | Problem |
| --- | -------- | ------- |
| S1 | Function | "Find a Replacement" links to `/invitations/new`, which does not exist — a guaranteed 404. See "Needs human decision". |
| S2 | States | Detail maps *every* failure (403, 500, offline) to "This conflict has been resolved or no longer exists." |
| S2 | Copy | "Mark as Resolved" versus "Dismiss": the difference (member re-confirmed versus ignore) is not explained. Both show "Submitting…" at once. |
| S2 | Mobile | Detail overflows by 70 px at 375 (X1). |
| S3 | Design | List has no count and no severity; the empty state is a plain sentence. |

### 10–11 · Profile and Documents

| Sev | Category | Problem |
| --- | -------- | ------- |
| S2 | Design | Profile is inline-styled "Name: —" paragraphs inside a nested `<main>`; no role, no sign-out. |
| S3 | Design | Documents is a bare `<h1>` "coming soon". It is not linked from anywhere, so it is left as a styled placeholder only. |

### 12–13 · Join and Guest claim

| Sev | Category | Problem |
| --- | -------- | ------- |
| S2 | Design | Inline styles, native 21 px buttons, no card, no brand, no header. |
| S2 | Copy | Raw API `error` strings shown to the user; the join screen shows the invite code but not which group it joins. |
| S2 | A11y | Success is not announced; error paragraph appears below the button, away from focus. |

### 14–15 · Auth and Marketing

| Sev | Category | Problem |
| --- | -------- | ------- |
| S2 | Design | Marketing page is a heading and a sentence — no sign-in link, so there is no way into the app from `/`. |
| S3 | Design | Clerk widget uses its default indigo theme inside an inline-styled wrapper; no brand around it. |

### Shared components

| Component | Problems |
| --------- | -------- |
| `Button` | Two variants only; no danger/ghost, no size, no loading state, no focus style, no disabled style, cannot render as a link (so link-buttons are re-implemented per screen). |
| `Badge` | Fine structurally; hard-coded palette; no icon, so status is colour + word only (acceptable) but tones are not tokenised. |
| `Modal` | See X10. |
| `NotificationBell` | Emoji; count not announced; lives alone in the sidebar. |
| `PublicHeader` | Text logo only; used by marketing only. |
| `InstallPrompt` | Solid; collides with the setlist bottom bar and the member-week chat button; not themed. |
| Missing | Field/Input, Card, Sheet, Toast, EmptyState, ErrorState, Skeleton, Avatar, PageHeader, icons. |

## Role review

| Role | Verdict |
| ---- | ------- |
| **Admin / Set Leader** | Have real, separate screens (dashboard, week, setlist, conflicts) but no navigation between them (X2). Admin and Set Leader are indistinguishable in the UI. |
| **Member** | Has a purpose-built week view, which is good, but no home: there is no "my upcoming weeks" list, and the only entry points are notifications. Landing on a leader URL is a dead end. |
| **Guest** | Has a claim flow, then is dropped into the member screens with the member shell. Nothing tells a guest they are a guest or limits the chrome to what they can use. |

The shell renders the same for every role. A proper role-aware nav needs the
current user's role on the client, which no existing endpoint exposes to the
shell — see below.

## Needs human decision

Not fixed in this pass because each needs a product or API decision.

1. **Role-aware navigation.** There is no endpoint the shell can call for "who
   am I and what is my role", and no "my weeks" list for members. This pass
   adds a navigation shell with the links that exist for everyone; hiding
   leader-only links for members needs a small read endpoint.
2. **Week view "+ Add event" / "Edit setlist" / "0 songs" / "Draft" badge.**
   All four are placeholders. Wiring them is feature work (the events API and
   setlist lookup by week). This pass marks them honestly as not yet available.
3. **"Find a Replacement" → `/invitations/new`** does not exist.
4. **Notification pagination.** The API supports `page`; the UI shows only the
   first 50. Adding "Load more" is new behaviour.
5. **Members hitting `/dashboard`.** Should redirect to their own week;
   needs the same "my weeks" data as (1).
6. **Guest-specific shell.** Depends on (1).
7. **Raw API error strings** shown on join, guest claim and guest invite.
   Replacing them with fixed copy would hide useful server messages ("already
   a member"); mapping them properly needs stable error codes from the API.
8. **Clerk widget theming.** Possible through Clerk's `appearance` prop; left
   alone here because it touches the auth surface.

## Proposed order of work

| Order | Issue | Why first |
| ----- | ----- | --------- |
| 0 | Design foundation: tokens + primitives | Everything else depends on it |
| 1 | App shell: responsive, navigation, landmarks | Unblocks every screen on mobile (X1–X3) |
| 2 | Invitation response (in-app + public) | Highest-traffic action |
| 3 | Member week view | |
| 4 | Notification inbox | |
| 5 | Week view | |
| 6 | Setlist builder | |
| 7 | Dashboard | |
| 8 | Conflicts list + detail | |
| 9 | Public entry: join, guest claim, marketing, auth wrapper | |
| 10 | Profile, documents, not-found / error boundaries | |
