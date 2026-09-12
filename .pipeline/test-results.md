# Test Results — Issue #73: Notification Inbox screen (+ in-app invitation response, option C)

## Verdict: ALL PASS

Independently re-ran and verified against the code in this worktree (not just
trusting `changes.md`'s claims):

- `bun run lint` — pass, no warnings/errors.
- `bun run typecheck` — pass.
- `bun run test` — **153 suites / 3227 tests, all pass** (baseline before this
  stage: 147 suites / 3144 tests; 6 new test files / 83 new tests added by
  this stage, zero pre-existing tests touched or broken).

## New test files (this stage)

1. `tests/unit/lib/notifications/inbox-links.test.ts` (40 tests)
   - `NOTIFICATION_FILTERS` exact order/labels.
   - `filterForType` full table (all 15 `NotificationType` values, incl. the
     3 that map to `null`).
   - `matchesFilter`: `"all"` always true, category match/mismatch, no-category
     types never match a non-`"all"` filter.
   - `resolveNotificationHref`: all 4 known `linkEntityType`s incl.
     `"invitation"` → `/invitations/:id` (the option-C behavior), `null` for
     `"google_calendar"` even with a non-null id, `null` for null id/empty
     id/null type, `null` (no throw) for an unknown/future type.
   - `formatRelativeTime`: all boundary values (60s/60m/24h/7d, both just
     under and exactly at each boundary), the >=7d absolute-date format,
     future-timestamp clock skew → `"just now"` (never negative), unparseable
     and empty-string input → `""` without throwing.

2. `tests/unit/app/notification-bell.test.tsx` (7 tests)
   - Happy path badge render + accessible label; `unreadCount === 0` → no
     badge; `unreadCount > 99` → `"99+"`; refresh on
     `UNREAD_CHANGED_EVENT`/`notifyUnreadChanged()`; silent failure on a
     non-OK response and on a network error (no badge, no error UI).

3. `tests/unit/app/notification-inbox.test.tsx` (16 tests)
   - Loading state; happy-path row rendering (title/body/timestamp/link
     href); `body === null` renders no body element (not the string
     `"null"`); `linkEntityId === null` renders a non-clickable button row
     that still issues the read PATCH on tap; unknown `linkEntityType` is
     non-clickable and doesn't throw; unread rows get the visually-hidden
     "Unread" marker and read rows don't; the Chat filter's empty state with
     no refetch; empty-inbox state + disabled mark-all-read; the "Showing N
     of Total" footnote (present/absent); mark-all-read disabled-when-nothing-
     unread (no request issued), happy path (flips rows + dispatches the
     event), and HTTP-failure path (inline error, list state unchanged,
     screen stays usable); already-read row taps issue no PATCH; list-fetch
     failure (non-OK and network-error) both show the error view.

4. `tests/unit/app/api/invitations-get-own-route.test.ts` (8 tests) — new
   `getOwnInvitation` handler.
   - 401 when no JWT; 400 on a malformed id; happy path returns the exact
     `PublicInvitationLookup` shape; computed `"expired"` for a pending
     invitation past its deadline; an already-responded invitation is never
     recomputed to `"expired"` even past its deadline; 404 for a nonexistent
     invitation; **same 404 body for "not owned"/"nonexistent" cases — no
     existence leak**; 500 on a Supabase query error.

5. `tests/unit/app/invitation-response.test.tsx` (9 tests) — new in-app
   accept/deny screen (`app/(app)/invitations/[id]/invitation-response.tsx`).
   - Loading state; happy path fetches by id (`/api/invitations/:id`, no
     token in the URL); accept posts an **empty body** (no `responseToken`)
     and shows accepted-success; accept dispatches `notifyUnreadChanged()`
     end-to-end; decline posts `{ reason }` (no `responseToken`) and shows
     declined-success; expired-on-load and already-responded-on-load both
     show the friendly unavailable copy (never the raw status); a 404 lookup
     and a network error on the lookup both show the not-found unavailable
     view, not a crash.

6. `tests/unit/invitations-id-route-auth-gate.test.ts` (3 tests) — exercises
   `middleware.ts`'s real (unmocked) `isPublicRoute` matcher.
   - `GET /api/invitations/:id` is NOT public (protected by default —
     `auth.protect()` runs, so an unauthenticated request is redirected/401'd,
     never returning invitation data).
   - `/invitations/:id` (the in-app response page) is NOT public.
   - Contrast check: the existing public, token-gated `/accept`, `/deny`, and
     `/respond/:token` endpoints remain public (regression guard against this
     change accidentally widening or narrowing that allowlist).

## Spec/edge-case coverage cross-check

All items from spec.md's "Edge cases the implementation must handle" (1–15)
and changes.md's "What the Tester should focus on" (1–5) are covered above,
including the option-C-specific `resolveNotificationHref("invitation", id)`
behavior and the `getOwnInvitation` no-existence-leak / expired-status-parity
checks the coder flagged as needing independent verification.

## Notes for the Reviewer

- No failures encountered; nothing was patched around. The one hiccup during
  authoring was in my own test fixture (an invitation `response_deadline` of
  `2026-07-15` was in the past relative to today's actual date, 2026-09-12,
  which made the "still pending" happy-path fixture spuriously compute as
  `"expired"` — fixed by using a fixture deadline in 2099; not a code defect).
- `console.error: Error: Not implemented: navigation (except hash changes)`
  appears in jsdom output when clicking a `next/link` row in
  `notification-inbox.test.tsx` and `invitation-response.test.tsx` — this is
  jsdom's standard harmless noise for unmocked anchor navigation (same
  pattern already present in this repo's other Link-based screens, e.g.
  `conflicts-list.test.tsx`), not a test failure.
- Manual code review (not just tests) confirms: `getOwnInvitation` scopes its
  query by both `church_group_id` and `user_id` before falling back to a
  uniform 404, matching `denyInvitation`'s existing in-app-branch precedent;
  no `schemas/**`, `lib/supabase/**`, or `supabase/migrations/**` files were
  touched, matching the spec's scope boundary; `AppShell.tsx`/`.module.css`
  changes are additive only (`.sidebar`/`.shell`/`.content` untouched).
