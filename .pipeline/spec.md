# Spec — Issue #73: [Sprint 4] Build Notification Inbox screen

PRD: `documentation/prd/graceful_requirements_v10.md` §13 Screen 6 (line 1320) and §13.2 (line 392).
Backend (#71) is already shipped — this issue is UI only. **No API handler, schema, or
migration changes.**

---

## OPEN QUESTION (blocking — pipeline stops here until a human answers)

**Where should an `invitation` notification deep-link to?**

The acceptance criterion says "invitation → accept/deny flow", but verified current state:

- Invitation notifications are written with `link_entity_type: "invitation"`,
  `link_entity_id = <invitation id>`
  (`app/api/invitations/handler.ts:980`, `app/api/conflicts/handler.ts:247`, and the
  accept/deny RPC migrations).
- **There is no in-app accept/deny screen.** The only response UI is the public,
  token-gated `app/(public)/invite/[token]/invite-response.tsx`, and its URL needs
  `response_token`, which `GET /api/notifications` deliberately does not return and
  which `app/api/invitations/handler.ts:61-63` calls "the no-session credential —
  never expose".
- There is also no member-accessible endpoint that maps an invitation id to its
  `service_week_id` (`GET /api/invitations` is admin/set_leader-only and requires a
  `serviceWeekId` query param).

So a working deep link for `invitation` rows cannot be built from what exists. Options:

- **(A) Recommended:** render `invitation` rows as non-clickable (same treatment as any
  unresolvable target — see "Deep-link resolution" below); tapping still marks read.
  No new endpoints, nothing dead-links to a 404.
- (B) Link to `/invitations/${linkEntityId}` and accept that it 404s today (precedent:
  `app/(app)/conflicts/[id]/conflict-resolution.tsx:171` already links to a
  not-yet-built `/invitations/new`).
- (C) Build the in-app accept/deny screen in this issue (scope creep — that is PRD
  Screen 3 / "In-app response" work, not Screen 6).

Everything else in this spec is unambiguous and unaffected by the answer; the coder should
implement all of it and apply the chosen option in `resolveNotificationHref` only.

---

## Current state (verified in this worktree)

- `app/(app)/notifications/page.tsx` is a 4-line "coming soon" stub.
- `components/layout/AppShell.tsx` renders a sidebar containing the literal string
  "Graceful" and **no nav links at all** (its TODO comment names this exact gap).
- Endpoints already implemented in `app/api/notifications/handler.ts`:
  - `GET /api/notifications?page=&pageSize=` → `{ data: { notifications: NotificationItem[],
    pagination: { page, pageSize, total } } }`; `pageSize` max 100, default 20.
  - `GET /api/notifications/unread-count` → `{ data: { unreadCount: number } }`
  - `PATCH /api/notifications/:id/read` → `{ data: { notification } }` (idempotent)
  - `POST /api/notifications/mark-all-read` → `{ data: { updatedCount: number } }`
- `NotificationItem` (exported from `app/api/notifications/handler.ts`):
  `{ id, type: NotificationType, title, body: string | null, linkEntityType: string | null,
  linkEntityId: string | null, isRead: boolean, createdAt: string /* ISO */ }`
- `NotificationType` union: `types/domain.ts:22-37`.
- `link_entity_type` values actually produced today: `"invitation"`, `"service_week"`,
  `"setlist"`, `"conflict"`, `"google_calendar"` (the last with `link_entity_id = null`).
- Existing app routes available as link targets: `/week/[id]`, `/member-week/[id]`,
  `/conflicts/[id]`, `/setlists/[id]`, `/dashboard`, `/documents`, `/profile`,
  `/notifications`.
- CSS variables available (`app/globals.css`): `--color-bg`, `--color-fg`,
  `--color-border`, `--color-accent`.

## Pattern to copy

`app/(app)/conflicts/` is the model for this screen — copy its structure exactly:

- `page.tsx`: tiny server component that renders the `"use client"` child, no shell.
- `conflicts-list.tsx`: `"use client"`, `ViewState = "loading" | "ready" | "error"`,
  `useEffect` + `fetch` with a `cancelled` flag, reads `body.data.<key>`, a CSS module.
- `conflicts-list.module.css`: `.container` / `.list` / `.card` conventions.
- Test pattern (for the tester stage): `tests/unit/app/conflicts-list.test.tsx`
  (`/** @jest-environment jsdom */`, `global.fetch` mocked with a `jsonResponse` helper).

---

## Files to create

### 1. `lib/notifications/inbox-links.ts` (new, pure, no React, no `"server-only"`)

```ts
import type { NotificationType } from "@/types/domain";

export type NotificationFilter = "all" | "invitations" | "setlists" | "events" | "chat";

export const NOTIFICATION_FILTERS: { id: NotificationFilter; label: string }[];
// exactly: all → "All", invitations → "Invitations", setlists → "Setlists",
// events → "Events", chat → "Chat" (in that order)

export function filterForType(type: NotificationType): NotificationFilter | null;

export function matchesFilter(type: NotificationType, filter: NotificationFilter): boolean;

export function resolveNotificationHref(
  linkEntityType: string | null,
  linkEntityId: string | null,
): string | null;

export function formatRelativeTime(iso: string, now?: Date): string;
```

`filterForType` mapping (anything not listed returns `null` → only visible under "All"):

| filter        | types |
| ------------- | ----- |
| `invitations` | `set_invitation`, `invitation_reminder`, `invitation_accepted`, `invitation_denied`, `invitation_withdrawn` |
| `setlists`    | `setlist_released` |
| `events`      | `practice_reminder`, `scheduling_conflict`, `google_calendar_event`, `service_week_cancelled`, `service_week_reactivated` |
| `chat`        | `chat_mention` |
| `null`        | `devotion_shared`, `new_church_document`, `google_calendar_reauth_required` |

`matchesFilter(type, "all")` is always `true`; otherwise `filterForType(type) === filter`.

`resolveNotificationHref` — returns `null` (row not clickable) whenever `linkEntityId`
is `null`/empty, `linkEntityType` is `null`, or the type is unknown:

| `linkEntityType` | href |
| ---------------- | ---- |
| `"setlist"`      | `/setlists/${linkEntityId}` |
| `"conflict"`     | `/conflicts/${linkEntityId}` |
| `"service_week"` | `/member-week/${linkEntityId}` |
| `"invitation"`   | per the OPEN QUESTION answer |
| anything else (incl. `"google_calendar"`) | `null` |

`formatRelativeTime(iso, now = new Date())` — plain English, no new dependency
(use `Intl.RelativeTimeFormat` or manual arithmetic, coder's choice):
`< 60s` → `"just now"`; `< 60m` → `"Nm ago"`; `< 24h` → `"Nh ago"`; `< 7d` → `"Nd ago"`;
otherwise the absolute date via `toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })`.
A future timestamp (clock skew) must render `"just now"`, never a negative value.
An unparseable `iso` must return `""` and must not throw.

### 2. `app/(app)/notifications/notification-inbox.tsx` (new, `"use client"`)

Default export `NotificationInbox()`. No props.

State: `view: "loading" | "ready" | "error"`, `notifications: NotificationItem[]`
(declare the row type locally in this file, mirroring how `conflicts-list.tsx` declares
its own `Conflict` type — do not import from `app/api/**` into a client component),
`total: number`, `filter: NotificationFilter` (default `"all"`),
`markingAll: boolean`.

Behaviour:

- On mount, `fetch("/api/notifications?page=1&pageSize=50")`; on non-ok or throw →
  `view = "error"` with the same copy as `conflicts-list.tsx` ("Something went wrong" /
  "Please try again later."). Use the `cancelled` cleanup flag pattern.
- Header: `<h1>Notifications</h1>` plus a **"Mark all read"** `<button>`. Disabled when
  `markingAll` is true or when no loaded notification is unread. On click:
  `POST /api/notifications/mark-all-read` → on ok, set every loaded row's `isRead` to
  `true` in local state and dispatch the unread-count refresh event (below). On failure,
  leave state untouched and show an inline error message near the button; do not flip
  the whole screen to the error view.
- Filter row: a `<nav>`/`<div>` of buttons built from `NOTIFICATION_FILTERS`, the active
  one marked with `aria-pressed={true}` (or `aria-current`). Selecting a filter only
  changes local state — **no refetch**.
- List: `<ul>` of `<li>`, one per notification passing `matchesFilter`. Each row shows,
  in order: a type icon (a plain text/emoji glyph via a local
  `iconForType(type: NotificationType): string` map with a sensible default — no icon
  library, no new dependency), `title`, `body` (omit the element entirely when `null`),
  and `formatRelativeTime(createdAt)` rendered inside a
  `<time dateTime={createdAt}>` element.
- Unread rows get an extra CSS class (`styles.unread`) **and** a visually-hidden
  `"Unread"` text marker (e.g. `<span className={styles.srOnly}>Unread</span>`) so the
  distinction is assertable in tests and available to screen readers.
- Row interaction: when `resolveNotificationHref` returns a string, the row content is a
  `next/link` `<Link href={...}>`; when it returns `null`, render the same content inside
  a `<button type="button">` styled as the card. In **both** cases, activating the row
  first fires `PATCH /api/notifications/${id}/read` (fire-and-forget: do not await before
  navigating, do not block navigation on failure) and optimistically sets that row's
  `isRead` to `true`, then dispatches the unread-count refresh event. Already-read rows
  must **not** issue the PATCH.
- Empty states (all rendered inside the same `.container`, never a blank screen):
  - `total === 0` → "No notifications yet."
  - loaded rows exist but none match the active filter → "No <label> notifications."
    (this is what the inert **Chat** filter hits today — it must render this empty state,
    not break the layout).
- If `total > notifications.length`, render one line of muted text below the list:
  `Showing the {notifications.length} most recent of {total} notifications.`
  No pagination controls (out of scope).

### 3. `app/(app)/notifications/notification-inbox.module.css` (new)

Copy `app/(app)/conflicts/conflicts-list.module.css` conventions
(`.container`, `.list`, `.card`) and add: `.header` (flex row, space-between),
`.filters`, `.filterButton`, `.filterButtonActive`, `.unread`
(e.g. `border-left: 3px solid var(--color-accent)` + `font-weight: 600` on the title),
`.icon`, `.timestamp` (muted), `.empty`, `.footnote`, `.srOnly` (standard
clip/1px visually-hidden rule). Only `var(--color-*)` tokens listed above.

### 4. `components/layout/NotificationBell.tsx` (new, `"use client"`)

```tsx
export function NotificationBell(): React.JSX.Element;
```

- Renders `<Link href="/notifications" aria-label="Notifications">` containing a bell
  glyph and, when `unreadCount > 0`, a badge element showing the count
  (`unreadCount > 99` → the string `"99+"`).
- Fetches `GET /api/notifications/unread-count` on mount; reads `body.data.unreadCount`.
  On any failure, render the icon with no badge and no error UI (`unreadCount = 0`).
- Refreshes on the custom event `notifications:unread-changed`:
  add a `window.addEventListener` in a `useEffect` and remove it on cleanup. Export the
  event name and a dispatch helper **from this file** so the inbox screen imports them:
  ```ts
  export const UNREAD_CHANGED_EVENT = "notifications:unread-changed";
  export function notifyUnreadChanged(): void; // no-op when `typeof window === "undefined"`
  ```
  (`notification-inbox.tsx` calls `notifyUnreadChanged()` after mark-all-read and after
  each per-row PATCH is issued.)
- The badge must be exposed accessibly: `aria-label={`${unreadCount} unread notifications`}`
  on the badge element.

### 5. `components/layout/NotificationBell.module.css` (new)

`.link`, `.icon`, `.badge` (small pill, `background: var(--color-accent)`, white text,
positioned relative to `.link`).

## Files to modify

### 6. `app/(app)/notifications/page.tsx` (replace whole file)

Mirror `app/(app)/conflicts/page.tsx`: a comment naming PRD Screen 6 / issue #73, then
a default-export server component returning `<NotificationInbox />`. No shell wrapper
(the `(app)` layout already supplies `AppShell`).

### 7. `components/layout/AppShell.tsx` (modify)

Keep it a server component. Inside `.sidebar`, keep the "Graceful" wordmark and add a
persistent nav containing `<NotificationBell />`. Scope: **only** the notifications
entry — do not add dashboard/week/setlist/profile links, and do not delete the existing
`TODO(Sprint 1+)` comment (amend it to note that notifications is now wired up).

### 8. `components/layout/AppShell.module.css` (modify)

Add only what the nav needs (e.g. `.sidebarHeader` / `.nav`); leave `.shell`,
`.sidebar`, `.content` as they are.

---

## Edge cases the implementation must handle

1. `body === null` → no body element rendered (must not print "null").
2. `linkEntityId === null` (e.g. `google_calendar` rows) → non-clickable row, still
   markable as read.
3. Unknown / future `linkEntityType` string → treated as non-clickable, never throws.
4. Notification types with no filter category (`devotion_shared`,
   `new_church_document`, `google_calendar_reauth_required`) → visible under "All" only.
5. **Chat filter selected** → the "No Chat notifications." empty state; layout intact;
   no fetch, no error.
6. `unreadCount === 0` → bell renders with no badge at all.
7. `unreadCount > 99` → badge shows `"99+"`.
8. Mark-all-read when nothing is unread → button disabled, no request issued.
9. Mark-all-read HTTP failure → list state unchanged, inline error shown, screen stays
   usable.
10. Per-row PATCH failure → navigation still happens; the optimistic unread flip is
    allowed to stand (the next page load re-reads the truth).
11. Tapping an already-read row → no PATCH request.
12. Empty inbox (`total === 0`, `notifications: []`) → "No notifications yet.", and
    mark-all-read disabled.
13. Fetch rejects / non-2xx on the list endpoint → error view (no crash, no infinite
    loading).
14. Unmount before fetch resolves → no `setState` (use the `cancelled` flag).
15. `createdAt` in the future or unparseable → `"just now"` / `""`, never `NaN` or a
    negative duration.

## Out of scope (do not build)

Push/SMS/email delivery, pagination or infinite scroll, per-notification delete,
notification preferences UI (already shipped as `/api/notifications/preferences`),
any Chat functionality, a "System" filter, any other nav link in `AppShell`, and any
change to `app/api/**`, `schemas/**`, `lib/supabase/**`, or `supabase/migrations/**`.

## Verification

`bun run lint`, `bun run typecheck`, `bun run test` must all pass.
