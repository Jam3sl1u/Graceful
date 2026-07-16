# Changes — Issue #56: Publish setlist (BR-01 zero-song publish)

## Summary

Implemented the two setlist state-transition endpoints that previously
returned `501 notImplemented`:

- `POST /api/setlists/:id/publish` — draft -> published, sets `published_at`,
  and notifies confirmed members (BR-01: a zero-song setlist is still
  publishable).
- `POST /api/setlists/:id/unlock` — published -> draft, resets
  `published_at` to `null`, sends no notifications.

## Files changed

- **`app/api/setlists/[id]/handler.ts`**
  - Added `import { toSetlistResponse } from "@/app/api/service-weeks/[id]/setlist/handler"`.
  - Added `publishSetlist(req, id, lookup?)`:
    - `requireAuth` + `requireRole(["admin", "set_leader"])`.
    - JWT via `auth().getToken({ template: "supabase" })`; missing -> `401`.
    - Loads the setlist tenant-scoped by `id` + `church_group_id`; DB error ->
      `500`; missing -> `404 "Setlist not found"`; `status !== "draft"` ->
      `409 "Setlist is already published."`.
    - Updates `status: "published"`, `published_at: new Date().toISOString()`
      (no cast needed — `setlists` `Update` is `Partial<SetlistsRow>`).
    - Counts `setlist_songs` for the setlist (drives notification copy, never
      blocks publish).
    - Loads confirmed members: `invitations` rows for
      `updated.service_week_id` with `status = "accepted"`, deduped by
      `user_id` via `Set` (mirrors `setServiceWeekCancelled` in
      `app/api/service-weeks/[id]/handler.ts`).
    - Only when `recipientIds.length > 0`, inserts one `notifications` row per
      recipient (`type: "setlist_released"`, `title: "Setlist published"`,
      `body` = the "still being added" copy iff `songCount === 0` else
      `null`, `link_entity_type: "setlist"`, `link_entity_id: id`). Insert
      error -> `500`. Left a `// TODO(#67/#68): SMS/email fan-out for
      confirmed members.` comment at the fan-out site (out of scope here).
    - Returns `ok({ setlist: toSetlistResponse(updated) })`.
    - Same `try/catch` -> `ApiException` mapping / `500` fallback as the
      other handlers in this file.
  - Added `unlockSetlist(req, id, lookup?)`:
    - Same auth/JWT setup and tenant-scoped load; `status !== "published"` ->
      `409 "Setlist is not published; nothing to unlock."`.
    - Updates `status: "draft"`, `published_at: null`; error/`!updated` ->
      `500`.
    - Returns `ok({ setlist: toSetlistResponse(updated) })`. No request body,
      no notifications.

- **`app/api/setlists/[id]/publish/route.ts`** — replaced the
  `notImplemented` stub with `POST` wired to `publishSetlist`, mirroring
  `app/api/service-weeks/[id]/cancel/route.ts`.

- **`app/api/setlists/[id]/unlock/route.ts`** — same shape, wired to
  `unlockSetlist`.

- **`tests/unit/app/api/setlists-publish-route.test.ts`** (new) — stateful
  in-memory fake `from()` covering `setlists`, `setlist_songs`,
  `invitations`, and `notifications` (captures inserted rows). 23 tests
  across both endpoints:
  - Happy path (songs + confirmed members -> notified once per user,
    `body: null`), admin role allowed.
  - BR-01 zero songs -> `200`, notification body has the "still being added"
    copy.
  - Zero confirmed members -> `200`, no notification rows inserted.
  - Duplicate accepted invitations for the same user -> notified once (`Set`
    dedupe), verified via the happy-path test's recipient assertion.
  - Already-published setlist -> `409 CONFLICT`, no notifications inserted.
  - Missing / other-tenant setlist -> `404 NOT_FOUND`.
  - `member`/`guest` roles -> `403 FORBIDDEN` (no Supabase call).
  - Missing JWT -> `401 UNAUTHENTICATED` (no Supabase call).
  - `500 INTERNAL` for DB errors at load, update, song-count, invitations
    lookup, and notification insert.
  - Unlock: happy path (published -> draft, `publishedAt: null`, no
    notifications), admin role allowed, unlock-a-draft -> `409 CONFLICT`,
    404/403/401 parity with publish, `500` at load/update.

## Verification

Ran and confirmed green:
- `bun run lint` — clean.
- `bun run typecheck` — clean.
- `bun run test` — 67 suites / 853 tests passed, including the new 23-test
  file.

## Notes for the Tester

- `:id` in both routes is the **setlist** id, not the service_week id —
  confirm request wiring in the route files matches this.
- The "zero songs" and "zero confirmed members" BR-01 edge cases are
  independent axes; worth double-checking a case with zero songs AND zero
  confirmed members together (no notification rows, but still `200`
  published) if you want an extra combination beyond what's in the test
  file.
- Unlock takes no request body and sends no notifications by design (the
  re-notify happens on the *next* publish) — this is a spec Decision, not an
  oversight, so don't flag it as missing behavior.
- `published_at` is null iff status is `draft`, non-null iff `published` —
  both transitions maintain this invariant; worth a direct assertion if not
  already covered.
