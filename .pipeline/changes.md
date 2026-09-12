# Changes — Issue #73: Notification Inbox screen (+ in-app invitation response, option C)

## Scope note

The planner's OPEN QUESTION ("where should an `invitation` notification
deep-link to?") was resolved by a human operator as **option C**: build the
in-app accept/deny screen now (PRD Screen 3), even though it expands scope
beyond the original Screen-6-only spec. That resolution overrides spec.md's
"No API handler, schema, or migration changes" framing — this changeset
does add one new API endpoint, but **no schema or migration changes** were
needed (see below).

## New files

- `lib/notifications/inbox-links.ts` — pure helpers: `NOTIFICATION_FILTERS`,
  `filterForType`, `matchesFilter`, `resolveNotificationHref`,
  `formatRelativeTime`. `resolveNotificationHref("invitation", id)` returns
  `/invitations/${id}` (option C), everything else per the spec's table.
- `app/(app)/notifications/notification-inbox.tsx` + `.module.css` — the
  Notification Inbox screen: loads `GET /api/notifications`, filter row,
  mark-all-read, per-row read-on-tap (Link when `resolveNotificationHref`
  returns a href, button otherwise), unread styling + visually-hidden
  "Unread" marker, empty states, "Showing N of Total" footnote. Follows the
  `conflicts-list.tsx` pattern (ViewState, `cancelled` fetch flag, local row
  type instead of importing from `app/api/**`).
- `app/(app)/notifications/page.tsx` (replace) — tiny server component
  rendering `NotificationInbox`.
- `components/layout/NotificationBell.tsx` + `.module.css` — bell icon
  linking to `/notifications`, fetches `GET /api/notifications/unread-count`
  on mount, refreshes on the `notifications:unread-changed` custom event
  (`UNREAD_CHANGED_EVENT` / `notifyUnreadChanged()` exported from this
  file), `99+` badge cap, accessible `aria-label`.
- `components/layout/AppShell.tsx` (modified) — added a persistent nav
  containing `<NotificationBell />` inside the sidebar; kept the "Graceful"
  wordmark and amended (did not delete) the `TODO(Sprint 1+)` comment.
- `components/layout/AppShell.module.css` (modified) — added
  `.sidebarHeader` / `.nav`, left `.shell`/`.sidebar`/`.content` untouched.

## Option C — in-app invitation accept/deny screen

- `app/api/invitations/handler.ts` — added `getOwnInvitation(req, id, lookup)`:
  a new in-app, authenticated read of a member's **own** invitation, scoped
  by `church_group_id` + `user_id` (not-owned/not-found/wrong-group all
  return the same 404, mirroring `denyInvitation`'s in-app branch — no
  existence leak). Returns the same `PublicInvitationLookup` shape as the
  existing `getInvitationByToken` (service week + role note + events +
  computed `"expired"` status), so both response screens share one data
  contract. **No new RPC/migration**: RLS already grants an authenticated
  caller `SELECT` on their own `invitations` row (`invitations_select_own`)
  and on tenant-scoped `service_weeks`/`events` rows
  (`service_weeks_select_tenant`, `events_select_tenant` — see
  `supabase/migrations/20260704000001_rls_policies.sql`), so this is a
  direct table read, not a `SECURITY DEFINER` RPC like the token path.
- `app/api/invitations/[id]/route.ts` — added `GET`, wired to
  `getOwnInvitation` (the `DELETE` → `withdrawInvitation` route was already
  there, untouched).
- **No changes to `accept`/`deny` handlers or routes** — their existing
  in-app branch (no `responseToken` in the body → identity from the Clerk
  session, scoped to the caller's own invitation) already does exactly what
  this screen needs; it was unused by any UI until now.
- `app/(app)/invitations/[id]/page.tsx` + `invitation-response.tsx` +
  `.module.css` (new) — a member-facing accept/deny screen, structurally a
  copy of the public `app/(public)/invite/[token]/invite-response.tsx`
  (same `ViewState`/`UnavailableReason` shape, same card/button layout, CSS
  copied verbatim) but: fetches `GET /api/invitations/:id` (no token in the
  URL), posts to `/accept` and `/deny` with an empty/`{ reason }` body (no
  `responseToken` field), and calls `notifyUnreadChanged()` after a
  successful accept/deny so the sidebar bell's unread count refreshes.
  `middleware.ts`'s route matcher required no changes — `/api/invitations/:id`
  GET was already outside the public-route list (protected by default), and
  `/invitations/[id]` is inside the `(app)` route group (already
  auth-protected).

## Verification

- `bun run lint` — pass (no warnings/errors).
- `bun run typecheck` — pass.
- `bun run test` — 147 suites / 3144 tests, all pass (pre-existing suite;
  no new unit tests were added in this pass — that's the Testing stage's
  job per AGENTS.md).

## What the Tester should focus on

1. `lib/notifications/inbox-links.ts`: `filterForType`/`matchesFilter` table
   coverage, `resolveNotificationHref`'s `"invitation"` → `/invitations/:id`
   case specifically (this is the option-C behavior change vs. the
   planner's recommended option A), `formatRelativeTime` edge cases
   (future timestamp, unparseable string, boundary values at 60s/60m/24h/7d).
2. `notification-inbox.tsx`: mark-all-read disabled/error states, per-row
   read-on-tap firing exactly once and not blocking navigation, the Chat
   filter's empty state, the `total > notifications.length` footnote.
3. `NotificationBell.tsx`: 0/badge-hidden, >99 → "99+", refresh on the
   custom event, silent failure (no badge, no error UI).
4. **New surface**: `getOwnInvitation` — verify a non-owner/wrong-group/
   nonexistent id all 404 identically (no existence leak), the computed
   `"expired"` status matches `get_invitation_by_token`'s logic, and that
   accept/deny via `invitation-response.tsx` (no `responseToken`) actually
   updates the invitation status end-to-end (this reuses existing,
   previously-untested-from-the-UI in-app branches of `acceptInvitation`/
   `denyInvitation`).
5. Confirm `/invitations/:id` and `/api/invitations/:id` (GET) are properly
   auth-gated (unauthenticated request → redirect/401, not the invitation
   data).
