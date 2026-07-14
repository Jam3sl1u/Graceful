# Spec — Issue #50: Build Conflict Resolution screen (PRD §13 Screen 7)

## OPEN QUESTIONS

None are hard-blocking — the screen is fully buildable. Two judgment calls were
made while planning; both have a chosen default so the pipeline does NOT halt.
They are called out here only so a human can override later.

1. **"Find a Replacement" deep-link target (#40) does not exist yet.** There is
   no send-invitation UI anywhere in the repo (grep confirms). The AC says this
   button "opens the invitation flow, slot pre-selected." Since #40's route +
   query-param contract is undefined, this spec fixes a forward-compatible URL:
   `/invitations/new?serviceWeekId={serviceWeekId}&roleNote={encoded roleNote}`.
   Clicking it today will land on a not-yet-built route — that is acceptable
   (the issue lists #40 only as an implementation note, not a hard blocker, and
   the button is present, labeled, and clickable per the AC). When #40 lands,
   the human/that issue can correct the path/params.

2. **"Their reason if provided" maps to `conflict.triggerReason`.** The member's
   own free-text note (availability `note`) is NOT durably stored on the conflict
   row — it is only interpolated into the notification body at creation time (see
   `supabase/migrations/20260713000001_conflict_notification.sql`). The only
   reason-like field durably retrievable per conflict is `conflicts.trigger_reason`
   (a caller-supplied tag such as `"marked_unavailable"` / `"availability_deleted"`).
   This spec surfaces `triggerReason` as the reason line. Recovering the member's
   verbatim note would require a data-model change and is out of scope here.

## Context (current state — verified, do not re-assume)

- `app/(app)/conflicts/page.tsx` is a one-line stub ("coming soon"). Leave it
  as-is; this issue does NOT build the conflicts list.
- The resolve endpoint (#47) is live: `POST /api/conflicts/[id]/resolve` accepts
  `{ resolution: "withdraw" | "member_reconfirmed" | "admin_dismissed" }`
  (`schemas/conflicts.ts`), returns `{ data: { conflict: {...} } }`, and 409s if
  already resolved. Note "replaced" is NOT a resolution this endpoint accepts.
- The list endpoint (#47) is live: `GET /api/conflicts` returns
  `{ data: { conflicts: OpenConflict[] } }` for OPEN conflicts only
  (`resolved_at IS NULL`) in the caller's group. `OpenConflict` currently lacks
  `roleNote` — this spec adds it.
- Conflict notifications deep-link with `link_entity_type: "conflict"`,
  `link_entity_id: <conflictId>`. The notification inbox that would turn that
  into a URL is itself a stub — so this issue only builds the destination screen
  at a routable URL; wiring the inbox link is out of scope.
- API success envelope is `{ data: T }`; errors are `{ error, code }` (see
  `lib/api/response.ts`). Client fetch reads `body.data`.
- App screens under `app/(app)/**` render inside `AppShell` via the `(app)`
  layout — no per-page shell needed.

## Button → action mapping (the core of this screen)

| Button label         | Behavior                                                                 |
| -------------------- | ------------------------------------------------------------------------ |
| Find a Replacement   | Navigate (link) to the invitation flow URL in OPEN QUESTION 1. No API call. Conflict stays open. |
| Mark as Resolved     | `POST /api/conflicts/{id}/resolve` `{ resolution: "member_reconfirmed" }` |
| Dismiss              | `POST /api/conflicts/{id}/resolve` `{ resolution: "admin_dismissed" }`    |

All three must always be visible and enabled (except while a request is in
flight). No AI-suggestion UI is implemented (Phase 4). Leave a short HTML comment
above the button row marking where the Phase 4 AI suggestion will render.

## Files to modify

### 1. `app/api/conflicts/handler.ts` — expose `roleNote`

Minimal, additive change so the screen can show "original role":
- Add `roleNote: string | null;` to the `OpenConflict` type.
- In the invitations query (currently
  `.select("id, user_id, service_week_id, status")`), add `role_note`, and add
  `"role_note"` to the `Pick<..., "id" | "user_id" | "service_week_id" | "status">`
  type on `invitationRows`.
- In the `result` map, add `roleNote: invitation?.role_note ?? null,`.
- Do not touch any other field, ordering, or the resolve handler.

### 2. `tests/unit/app/api/conflicts-route.test.ts` — keep it green

The happy-path test uses an exact `toEqual`, so it must be updated for the new
field (otherwise CI fails):
- Add `role_note: "Lead vocals"` to the `invitationRow` fixture (~line 95-100).
- Add `roleNote: "Lead vocals"` to the expected object in the "happy path"
  `toEqual` (~line 150-161).
- The "missing joined invitation row" test uses `toMatchObject`; no change needed,
  but you may optionally assert `roleNote: null` there.

## Files to create

Follow the pattern of the invitation-response screen
(`app/(public)/invite/[token]/page.tsx` + `invite-response.tsx` +
`invite-response.module.css`) closely — same server-page-awaits-params +
client-component-does-fetch/actions structure, same loading/ready/terminal view
states, same CSS-module approach, same `Button` from `@/components/ui/Button`.

### 3. `app/(app)/conflicts/[id]/page.tsx` (server component)

Mirror `app/(public)/invite/[token]/page.tsx`:
```tsx
export default async function ConflictResolutionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ConflictResolution conflictId={id} />;
}
```
Add a short comment noting PRD §13 Screen 7 / issue #50.

### 4. `app/(app)/conflicts/[id]/conflict-resolution.tsx` (client component)

`"use client"`. Props: `{ conflictId: string }`.

Local data shape (subset of `OpenConflict`):
```ts
type Conflict = {
  id: string;
  memberName: string;
  serviceDate: string;      // "YYYY-MM-DD"
  serviceWeekTitle: string | null;
  serviceWeekId: string;
  roleNote: string | null;
  triggerReason: string | null;
};
```

View states: `"loading" | "ready" | "unavailable" | "resolved-success"`.

Load (in `useEffect`, with the `cancelled` guard from invite-response):
- `GET /api/conflicts`, read `body.data.conflicts`, find the entry whose `id === conflictId`.
- Found → `ready`. Not found (already resolved, or bad id) or non-OK response or
  network error → `unavailable`.

Render on `ready`:
- Member name (`memberName`).
- Service date — reuse a `formatServiceDate(dateStr)` helper copied from
  invite-response (`new Date(\`${dateStr}T00:00:00\`)` + `toLocaleDateString`).
  If `serviceWeekTitle` is present, show it as a heading alongside the date.
- Original role: show `roleNote` if non-null; otherwise omit the line (or show a
  muted "No role specified"). Do not render an empty label.
- Reason: show `triggerReason` under a "Reason" label if non-null; otherwise omit.
- `<!-- Phase 4 (#, out of scope): AI-suggested replacement renders here -->`
- Button row (see mapping table), using `@/components/ui/Button`:
  - "Find a Replacement": render as a Next `Link`/anchor styled as a button with
    `href={\`/invitations/new?serviceWeekId=${serviceWeekId}&roleNote=${encodeURIComponent(roleNote ?? "")}\`}`.
    Using a plain link (not `useRouter`) keeps it testable via `href` and avoids
    a router mock.
  - "Mark as Resolved" and "Dismiss": `Button`s calling a shared
    `resolve(resolution)` handler.

`resolve(resolution: "member_reconfirmed" | "admin_dismissed")`:
- Guard against double-submit (`submitting` flag; disable all buttons while true).
- `POST /api/conflicts/${conflictId}/resolve`, headers `Content-Type: application/json`,
  body `JSON.stringify({ resolution })`.
- `res.ok` → `resolved-success`.
- `res.status === 409` (already resolved) → `unavailable` (treat as gone).
- any other non-OK, or thrown error → set an inline `actionError` string, stay on
  `ready`, keep buttons usable. Never surface raw `error`/`code`/`status`.

Render on `unavailable`: a message like "This conflict has been resolved or no
longer exists." plus a link back to `/conflicts` (or `/dashboard`).

Render on `resolved-success`: a brief confirmation ("Conflict resolved") plus a
link back to `/conflicts` (or `/dashboard`).

Render on `loading`: a simple "Loading…" placeholder.

### 5. `app/(app)/conflicts/[id]/conflict-resolution.module.css`

Copy the relevant class shapes from `invite-response.module.css` (`.container`,
`.card`, `.date`, `.roleNote`, `.buttonRow`, `.error`). Use existing CSS vars
(`var(--color-border)`, `var(--color-fg)`). Keep touch targets comfortable
(PRD mobile-first). No new design system work.

### 6. `tests/unit/app/conflict-resolution.test.tsx` (component test)

Mirror `tests/unit/app/invite-response.test.tsx`: `/** @jest-environment jsdom */`,
`@testing-library/react`, mock `global.fetch` directly, `jsonResponse(status, body)`
helper. Cover:
- Loading state before the GET resolves.
- Happy path: GET returns a `{ data: { conflicts: [conflict] } }` list containing
  the target id → renders member name, formatted service date, role note, and
  reason. Assert the three action controls are present.
- "Find a Replacement" anchor has the expected `href` (with encoded `roleNote`
  and correct `serviceWeekId`).
- "Mark as Resolved" click → POST to `/api/conflicts/{id}/resolve` with body
  `{ resolution: "member_reconfirmed" }`, then success view. Assert the request
  URL + body.
- "Dismiss" click → POST with `{ resolution: "admin_dismissed" }`.
- Not-found: GET returns a list NOT containing the id → unavailable view (a
  failure/edge case).
- (Optional but encouraged) 409 on resolve → unavailable view.

## Edge cases the implementation must handle

- Conflict id not present in the open list (already resolved, or invalid id) →
  `unavailable`, never a crash.
- `serviceWeekTitle` null → fall back to the formatted date / "Service".
- `roleNote` null → omit the role line cleanly.
- `triggerReason` null → omit the reason line cleanly.
- In-flight request → all buttons disabled; no double-submit.
- 409 (conflict already resolved by someone else) → `unavailable`.
- Non-OK / network error on resolve → inline error, buttons stay usable.
- No raw `error`/`code`/`status` strings shown to the user.

## Patterns to copy (name the file)

- Server page awaiting `params` + delegating to a client component:
  `app/(public)/invite/[token]/page.tsx`.
- Client fetch + view-state machine + action handlers + `cancelled` guard +
  `formatServiceDate`: `app/(public)/invite/[token]/invite-response.tsx`.
- CSS module: `app/(public)/invite/[token]/invite-response.module.css`.
- Button: `@/components/ui/Button`.
- Component test scaffolding (jsdom, fetch mock, `jsonResponse`):
  `tests/unit/app/invite-response.test.tsx`.
- Endpoint handler/test conventions: `app/api/conflicts/handler.ts` +
  `tests/unit/app/api/conflicts-route.test.ts`.

## Out of scope (do not build)

- AI-suggested replacement (Phase 4) — reserve a commented placeholder only.
- The conflicts list screen, the notification inbox, and the actual #40
  send-invitation flow. Do not modify `app/(app)/conflicts/page.tsx`.
- Any change to the resolve endpoint, its schema, or the DB migrations.

## Verification before finishing (coder)

- `bun run typecheck`
- `bun run lint`
- `bun run test` (Jest; not the bare `bun test` runner)
