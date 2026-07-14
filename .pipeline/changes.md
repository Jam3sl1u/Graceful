# Changes — Issue #50: Build Conflict Resolution screen (PRD §13 Screen 7)

## Summary

Built the destination screen for a resolved/dismissed conflict (routable at
`/conflicts/[id]`), following the same server-page + client-fetch pattern as
the invitation-response screen (#49). Made a minimal, additive change to the
`GET /api/conflicts` handler so it also returns `roleNote` (the "original
role" the member was booked for), which the new screen needs to render.

No changes were made to the conflicts list screen, the notification inbox,
the resolve endpoint/schema, or any DB migration — all explicitly out of
scope per spec.

## Backend

- **`app/api/conflicts/handler.ts`** — added `roleNote: string | null` to the
  `OpenConflict` type; the invitations join now selects `role_note` in
  addition to the existing columns, and the `result` map surfaces it as
  `roleNote: invitation?.role_note ?? null`. The resolve handler
  (`resolveConflict`) is untouched.
- **`tests/unit/app/api/conflicts-route.test.ts`** — updated the happy-path
  fixture/expectation (exact `toEqual`) to include `role_note`/`roleNote`;
  added `roleNote: null` to the "missing joined invitation row" `toMatchObject`
  assertion (optional per spec, done for completeness).

## Files created

- **`app/(app)/conflicts/[id]/page.tsx`** — server component; awaits
  `params`, delegates to the client component. Mirrors
  `app/(public)/invite/[token]/page.tsx`.
- **`app/(app)/conflicts/[id]/conflict-resolution.tsx`** — client component
  (`"use client"`), mirrors `invite-response.tsx`'s structure:
  - View-state machine: `"loading" | "ready" | "unavailable" | "resolved-success"`.
  - Load effect (with `cancelled` guard): `GET /api/conflicts`, finds the
    conflict whose `id === conflictId` in `body.data.conflicts`. Not found,
    non-OK, or a thrown/network error all route to `"unavailable"`.
  - `formatServiceDate` helper copied verbatim from `invite-response.tsx`.
  - Renders member name, service date (+ `serviceWeekTitle` heading, falling
    back to `"Service"` when null), "Original role" line (omitted when
    `roleNote` is null), and "Reason" line (omitted when `triggerReason` is
    null).
  - A commented placeholder above the button row:
    `{/* Phase 4 (out of scope): AI-suggested replacement renders here */}`.
  - Button row (all three always visible/enabled except mid-request):
    - **Find a Replacement** — plain `<a>` (not `next/link`'s `Link`, per the
      spec's own reasoning: testable via `href`, no router mock needed) to
      `/invitations/new?serviceWeekId={id}&roleNote={encodeURIComponent(roleNote ?? "")}`.
      This route does not exist yet (#40 is unbuilt) — intentional per spec's
      OPEN QUESTION 1.
    - **Mark as Resolved** / **Dismiss** — `Button`s that call a shared
      `resolve(resolution)` handler with `"member_reconfirmed"` /
      `"admin_dismissed"` respectively.
  - `resolve()`: guards double-submit via a `submitting` flag (disables both
    buttons while in flight), `POST`s to
    `/api/conflicts/{conflictId}/resolve`. `res.ok` → `"resolved-success"`;
    `409` → `"unavailable"` (already resolved by someone else); any other
    non-OK or thrown error → sets an inline `actionError` string and stays on
    `"ready"` (buttons remain enabled). No raw `error`/`code`/`status` is ever
    rendered.
  - The two internal "back" links (`unavailable` and `resolved-success`
    views, both pointing at `/conflicts`) use `next/link`'s `Link` — plain
    `<a>` tags there tripped `@next/next/no-html-link-for-pages` (the
    `/conflicts` stub is a real page, unlike the not-yet-built
    `/invitations/new`). `Link` renders as an `<a>` in tests so this required
    no test changes/router mocking.
- **`app/(app)/conflicts/[id]/conflict-resolution.module.css`** — copied the
  relevant class shapes (`.container`, `.card`, `.date`, `.roleNote`,
  `.buttonRow`, `.error`, `.checkmark`, `.appLink`) from
  `invite-response.module.css`, plus a new `.replacementLink` class so the
  plain anchor visually matches the `Button` styling.
- **`tests/unit/app/conflict-resolution.test.tsx`** — jsdom component test
  mirroring `invite-response.test.tsx`'s scaffolding (`fetch` mocked
  directly, `jsonResponse` helper). Covers: loading state; happy path
  (member name, formatted date, role note, reason, all three actions
  present); the "Find a Replacement" anchor's `href` (encoded `roleNote` +
  `serviceWeekId`); "Mark as Resolved" and "Dismiss" each POST the correct
  `resolution` body and land on the success view; null `roleNote`/
  `triggerReason` are omitted cleanly; null `serviceWeekTitle` falls back to
  "Service"; in-flight double-submit guard (both buttons disabled, no
  second request); not-found-in-list → unavailable; network error on lookup
  → unavailable (no crash); 409 on resolve → unavailable; non-OK (500) on
  resolve → inline alert, stays on ready view, no raw error/code leaked.

## Verification

- `bun run typecheck` — clean.
- `bun run lint` — clean (the two "back to conflicts" links had to become
  `next/link`'s `Link` to satisfy `@next/next/no-html-link-for-pages`; see
  above).
- `bun run test` — full suite green: 41 suites / 490 tests passed, including
  the 19 new/updated tests across `conflict-resolution.test.tsx` (new) and
  `conflicts-route.test.ts` (updated).

## What the Tester should focus on

- The `roleNote` plumbing end-to-end: `handler.ts` → API response →
  component render (including the null-omission edge case).
- The three button behaviors, especially that "Find a Replacement" makes
  **no** API call and leaves the conflict open (it's a pure navigation
  link), while the other two both hit `POST /resolve` with the right
  `resolution` value.
- Double-submit protection and the 409/"already resolved" → unavailable
  path, since a real admin/set_leader could plausibly race another admin
  resolving the same conflict.
- That no raw `error`/`code`/`status` string is ever shown to the user on
  any failure path (component test asserts this negatively but worth a
  manual look too).
- Scope: `app/(app)/conflicts/page.tsx` (the list stub) was intentionally
  left untouched, as was the resolve endpoint/schema and all migrations.
