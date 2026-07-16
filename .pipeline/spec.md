# Spec — Issue #56: Publish setlist (BR-01 zero-song publish)

## OPEN QUESTIONS

None. This issue is fully specified by the existing code patterns. Two design
decisions that the issue left implicit are resolved below under **Decisions**;
follow them exactly rather than re-deriving.

## Summary

Implement two setlist state-transition endpoints that currently return `501 notImplemented`:

- `POST /api/setlists/:id/publish` — draft → published, set `published_at`,
  notify confirmed members (BR-01: zero songs is a valid publishable state).
- `POST /api/setlists/:id/unlock` — published → draft so the setlist can be
  edited again.

`:id` is the **setlist** id (not the service_week id).

The in-app `notifications` row IS the "queued/stubbed" notification for this
issue. The actual SMS/email send is #67/#68 and is OUT OF SCOPE — add a
`// TODO(#67/#68)` comment at the fan-out site, matching how
`app/api/service-weeks/[id]/handler.ts` leaves TODOs.

## Decisions (implement exactly)

1. **Publishing an already-published setlist → `409 CONFLICT`.** The
   re-notify flow is unlock → edit → publish, so `publish` only ever acts on a
   `draft`. Message: `"Setlist is already published."`
2. **Unlock sets `published_at` back to `null`** (invariant: `published_at` is
   non-null iff `status = 'published'`). A subsequent publish sets a fresh
   timestamp.
3. **Unlock itself sends no notifications and requires no request body.** The
   "confirmation step that warns saving will re-notify" is a Setlist Builder
   (#64) UI concern; the re-notification actually happens on the next
   `publish`. Do not add a `confirm` flag to the API.

## "Confirmed members" definition

Confirmed members = rows in `invitations` where `service_week_id =
setlist.service_week_id` AND `status = 'accepted'`. De-duplicate `user_id`
with a `Set` (a user may have >1 accepted invitation), exactly like
`setServiceWeekCancelled` in `app/api/service-weeks/[id]/handler.ts:249`.

## Files to modify

### 1. `app/api/setlists/[id]/handler.ts` (add two exported functions)

Add `publishSetlist` and `unlockSetlist` alongside the existing song
functions. Import the existing response helper rather than re-declaring it:

```ts
import {
  toSetlistResponse,
  type SetlistResponse,
} from "@/app/api/service-weeks/[id]/setlist/handler";
```

(`SetlistResponse` is only needed if you annotate a local; importing
`toSetlistResponse` is the required part.)

Signatures (mirror the existing handlers in this file):

```ts
export async function publishSetlist(
  req: NextRequest,
  id: string,
  lookup?: UserLookup,
): Promise<Response>

export async function unlockSetlist(
  req: NextRequest,
  id: string,
  lookup?: UserLookup,
): Promise<Response>
```

**`publishSetlist` logic (in order):**

1. `const ctx = await requireAuth(req, lookup);` then
   `requireRole(ctx, ["admin", "set_leader"]);`
2. Get JWT via `auth()` → `getToken({ template: "supabase" })`; if falsy →
   `fail("Authentication required", ErrorCode.UNAUTHENTICATED, 401)`.
   `const supabase = getSupabaseClient(jwt);`
3. Load the setlist tenant-scoped:
   `supabase.from("setlists").select("*").eq("id", id).eq("church_group_id", ctx.churchGroupId).maybeSingle()`.
   - DB error → `500 INTERNAL`.
   - `!data` → `fail("Setlist not found", ErrorCode.NOT_FOUND, 404)`.
   - `data.status !== "draft"` → `fail("Setlist is already published.", ErrorCode.CONFLICT, 409)`.
4. Update status/timestamp (the shared `setlists` `Update` type is
   `Partial<SetlistsRow>`, so **no cast is needed**):
   ```ts
   const { data: updated, error } = await supabase
     .from("setlists")
     .update({ status: "published", published_at: new Date().toISOString() })
     .eq("id", id)
     .eq("church_group_id", ctx.churchGroupId)
     .select("*")
     .maybeSingle();
   ```
   error or `!updated` → `500 INTERNAL`.
5. Count songs (drives notification copy, does NOT block):
   `supabase.from("setlist_songs").select("id").eq("setlist_id", id)` → error →
   `500`; `const songCount = (rows ?? []).length;`
6. Load confirmed members:
   `supabase.from("invitations").select("user_id").eq("service_week_id", updated.service_week_id).eq("status", "accepted")`
   → error → `500`. `const recipientIds = [...new Set((rows ?? []).map(r => r.user_id))];`
7. **Only if `recipientIds.length > 0`**, insert notifications (copy the cast +
   insert shape from `app/api/service-weeks/[id]/handler.ts:252-268`):
   - `type: "setlist_released"`
   - `title: "Setlist published"`
   - `body: songCount === 0 ? "The setlist has been published — songs are still being added." : null`
   - `link_entity_type: "setlist"`, `link_entity_id: id`
   - `church_group_id: ctx.churchGroupId`, `user_id: <each recipient>`
   - Insert error → `500 INTERNAL`.
   - Add `// TODO(#67/#68): SMS/email fan-out for confirmed members.` here.
8. Return `ok({ setlist: toSetlistResponse(updated) })`.
9. Wrap the whole body in the same `try/catch` the other handlers use
   (`ApiException` → `fail(err.message, err.code, err.status)`, else `500`).

**`unlockSetlist` logic (in order):**

1. Auth + `requireRole(ctx, ["admin", "set_leader"])` (same as above).
2. JWT / supabase client (same 401 path).
3. Load setlist tenant-scoped (same query as publish step 3):
   - DB error → `500`; `!data` → `404 "Setlist not found"`;
   - `data.status !== "published"` →
     `fail("Setlist is not published; nothing to unlock.", ErrorCode.CONFLICT, 409)`.
4. Update: `.update({ status: "draft", published_at: null })` with the same
   `.eq("id", id).eq("church_group_id", ctx.churchGroupId).select("*").maybeSingle()`;
   error/`!updated` → `500`.
5. Return `ok({ setlist: toSetlistResponse(updated) })`. No notifications.
6. Same `try/catch` wrapper.

### 2. `app/api/setlists/[id]/publish/route.ts` (replace stub)

Mirror `app/api/service-weeks/[id]/cancel/route.ts` exactly:

```ts
import { NextRequest } from "next/server";
import { publishSetlist } from "../handler";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Ctx): Promise<Response> {
  const { id } = await params;
  return publishSetlist(req, id);
}
```

### 3. `app/api/setlists/[id]/unlock/route.ts` (replace stub)

Same shape, calling `unlockSetlist`.

## Do NOT touch

- `schemas/setlists.ts` — neither endpoint takes a request body.
- `types/domain.ts` — `setlist_released` NotificationType and the
  `SetlistStatus` union already exist.
- `lib/supabase/types.ts` — `setlists` `Update` already allows `status` /
  `published_at`; `notifications` `Insert` already exists.
- Any migration / RLS file — rely on the existing RLS-scoped client.

## Pattern sources to copy from

- Auth + JWT + tenant-scoped load + 404/409 + try/catch:
  `app/api/setlists/[id]/handler.ts` (`loadEditableSetlist`, `addSetlistSong`).
- Notification fan-out (dedupe with `Set`, skip when empty, cast + insert
  shape, TODO comments): `app/api/service-weeks/[id]/handler.ts:239-269`.
- `SetlistResponse` / `toSetlistResponse`:
  `app/api/service-weeks/[id]/setlist/handler.ts:11-33`.
- Route wiring: `app/api/service-weeks/[id]/cancel/route.ts`.

## Edge cases the implementation MUST handle

1. **Zero songs** → publish returns `200`, `status: "published"`,
   `publishedAt` non-null; notification `body` contains "still being added".
2. **Zero confirmed members** → publish succeeds but inserts **no**
   notification rows (guard on `recipientIds.length > 0`).
3. **Songs present + confirmed members present** → notification rows inserted,
   `body: null`.
4. **Duplicate accepted invitations for one user** → that user notified once
   (Set dedupe).
5. **Already published** → publish returns `409 CONFLICT`.
6. **Setlist missing / other tenant** → `404 NOT_FOUND` (do not leak).
7. **Role `member` / `guest`** → `403 FORBIDDEN` before any DB work.
8. **No JWT** → `401 UNAUTHENTICATED` before any Supabase call.
9. **DB error at load / update / count / invitations / notification-insert**
   → `500 INTERNAL`.
10. **Unlock a draft** → `409 CONFLICT`.
11. **Unlock a published setlist** → `200`, `status: "draft"`,
    `publishedAt: null`.

## Tests

Add `tests/unit/app/api/setlists-publish-route.test.ts`, modeled on the
stateful-fake approach in `tests/unit/app/api/setlists-songs-route.test.ts`.
The fake `from()` must additionally handle the `invitations` (select
`user_id` filtered by `service_week_id` + `status`) and `notifications`
(capture inserted rows) tables, and `setlist_songs` select for the count. Base
state needs a `service_week_id` on setlist rows. Cover every edge case above,
including the happy path, the two named BR-01 edge cases (zero songs, zero
confirmed members), and at least one `500` failure path.

## Verification

Run `bun run lint`, `bun run typecheck`, and `bun run test` before finishing.
