# Changes — Issue #70: Notification preferences API (BR-14 minimum-channel guard)

## Summary

Replaced the 501 stub at `app/api/notifications/preferences/route.ts` with a real
`GET`/`PUT` implementation, following `.pipeline/spec.md` exactly (pattern copied
from `app/api/profile/handler.ts` / `route.ts`).

## Files changed

- **`lib/supabase/types.ts`** — added `NotificationPreferencesRow` type and
  registered `notification_preferences` in `Database["public"]["Tables"]`,
  immediately after the `notifications` entry. `chat_preference` is
  deliberately omitted from the row shape (see inline comment): it's a Phase 2
  chat concern, and `types/domain.ts`'s `ChatPref` union doesn't match the DB
  enum, so it's out of scope for this API surface. No other table entries were
  touched.

- **`schemas/notifications.ts`** — left the existing placeholder
  `notificationsSchema`/`NotificationsInput` untouched (owned by other Sprint 4
  issues) and appended:
  - `NOTIFICATION_PREFERENCE_DEFAULTS` (PRD §6.9.1 defaults)
  - `MIN_REMINDER_HOURS_BEFORE` (1) / `MAX_REMINDER_HOURS_BEFORE` (168)
  - `updateNotificationPreferencesSchema` (all fields optional — partial merge)
    and its inferred `UpdateNotificationPreferencesInput` type.

- **`app/api/notifications/preferences/handler.ts`** (new) — exports
  `getNotificationPreferences` and `updateNotificationPreferences`, both
  `(req: NextRequest, lookup?: UserLookup) => Promise<Response>`, matching
  `app/api/profile/handler.ts`'s auth → JWT → Supabase client → `ok`/`fail` →
  `ApiException` catch shape. No role gate (PRD auth = Any).
  - `GET`: selects the caller's row by `user_id`; returns PRD defaults (no
    insert) when no row exists; maps snake_case → camelCase.
  - `PUT`: validates body against `updateNotificationPreferencesSchema` (400 on
    failure), reads the current row (or defaults if none), merges the parsed
    partial body onto it, then runs the **BR-14 guard against the merged
    state** — rejects with 422 `VALIDATION_FAILED` if all three invitation
    channels (`invitation_sms`, `invitation_email`, `invitation_inapp`) would
    end up disabled — before issuing any write. On success, upserts the full
    merged row (`onConflict: "user_id"`, `chat_preference` never read/written)
    and returns the updated preferences.
  - `user_id` always comes from `ctx.userId` (never the request body), so a
    body carrying another user's `userId` cannot retarget the write; unknown
    keys are stripped by Zod's default strip behavior.

- **`app/api/notifications/preferences/route.ts`** — replaced the
  `notImplemented` stub with thin `GET`/`PUT` delegation to the new handler
  (same shape as `app/api/profile/route.ts`).

- **`tests/unit/app/api/notification-preferences-route.test.ts`** (new) — 22
  tests mirroring `tests/unit/app/api/profile-route.test.ts`'s structure
  (`jest.mock` for `@clerk/nextjs/server` and `@/lib/supabase/client`,
  `makeReq`/`makeLookup`/`setUpAuth`/`makeSupabaseClient` helpers). The
  Supabase fake supports an `upsertResult` fixture override so the post-upsert
  `.select().maybeSingle()` can echo back a different row than the pre-write
  select (needed for the "no row yet" PUT case) and an `onUpsert` capture
  callback to assert both the written payload and that no upsert fires when a
  request is rejected. Covers: GET with existing row / no row (defaults, no
  upsert issued) / DB error; PUT happy path (captured merged snake_case
  payload), empty-body no-op, insert-on-first-write, BR-14 direct violation
  (no upsert issued), BR-14-via-merge violation, one-channel-remains-enabled
  success, re-enabling a channel, malformed body (null/array/wrong types),
  out-of-range `reminderHoursBefore` (0, 169, 1.5, string), unknown-key
  stripping, missing JWT (401, no Supabase client built), and DB error (500).

## Verification

- `bun run lint` — clean.
- `bun run typecheck` — clean.
- `bun run test` — full suite: 82 suites / 1062 tests passed, including the 22
  new tests in `notification-preferences-route.test.ts`.

## Notes for the Tester

- No migration or RLS changes were made or are needed — the
  `notification_preferences` table and its RLS policies already existed with
  the PRD-matching defaults (verified in the spec's "Current state" section).
- `chat_preference` must never appear in a `select` or upsert payload for this
  route — worth an explicit spot-check if you write any additional tests.
- BR-14 is deliberately checked against the **merged** state, not the raw
  request body, so the interesting edge case is a body that only sets one
  field but disables the last remaining enabled invitation channel because the
  other two are already `false` in the stored row.
- `PUT` is a partial merge (not full replace) — this is the one intentional
  divergence from `PUT /api/profile`, called out explicitly in spec Decisions.
- `.pipeline/spec.md` was already updated in the working tree (issue #70's
  spec, produced by the Planning stage) before this Coding session started;
  included in this commit as part of the normal pipeline handoff. No further
  edits made to it by the Coding stage.
