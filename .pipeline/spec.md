# Spec — Issue #70: Notification preferences API (BR-14 minimum-channel guard)

## OPEN QUESTIONS

None blocking. Three judgement calls are recorded under **Decisions** (partial-merge
PUT semantics, `reminderHoursBefore` accepted range, `chat_preference` deliberately
excluded from the API). All are resolved below — the Coder must not deviate from
them, and must not stop for a human.

## Goal

Replace the 501 stub at `app/api/notifications/preferences/route.ts` with a real
implementation:

- `GET /api/notifications/preferences` — returns the caller's own channel settings.
- `PUT /api/notifications/preferences` — updates them (invitation/reminder/setlist
  channels, reminder lead time, GCal sync toggle).
- BR-14: reject any save whose resulting state has all three invitation channels
  (`invitation_sms`, `invitation_email`, `invitation_inapp`) disabled.
- Defaults per PRD: invitation channels all `true`, `reminder_sms` `true` /
  `reminder_email` `false`, `reminder_hours_before` `24`, setlist channels both
  `true`, `gcal_sync_enabled` `false`.

PRD refs: Phase 1 PRD §6.9.1 (table), §7 BR-14, §22.12 (endpoint table, auth = Any).

## Current state (verified in this worktree)

- `app/api/notifications/preferences/route.ts` — stub, both `GET` and `PUT` return
  `notImplemented(...)` (501). No `handler.ts` exists in that directory.
- `supabase/migrations/20260702000005_cluster_5_partial.sql` already creates the
  `notification_preferences` table with exactly the PRD defaults:
  `invitation_sms/email/inapp` default `true`; `reminder_sms` `true`;
  `reminder_email` `false`; `reminder_hours_before` `24`; `setlist_sms/email`
  `true`; `chat_preference` `chat_pref` default `'mentions'`;
  `gcal_sync_enabled` `false`. `user_id` is `not null unique` FK → `users(id)`.
  **No migration change is needed and none may be added.**
- `supabase/migrations/20260704000001_rls_policies.sql` already has user-scoped
  RLS (`select/insert/update/delete own`, `user_id = auth_user_id()`). **No RLS
  change is needed.**
- `lib/supabase/types.ts` has **no** `notification_preferences` entry — it must be
  added or the handler will not typecheck.
- `schemas/notifications.ts` is a placeholder (`notificationsSchema = z.object({})`)
  with a TODO referencing BR-14. Nothing imports it.
- `types/domain.ts` exports `ChatPref = "sms" | "email" | "in_app"`, which does
  **not** match the DB enum `chat_pref ('all','mentions')`. Do not touch
  `types/domain.ts` — see Decisions.
- Repo convention for business-rule violations: HTTP **422** with
  `ErrorCode.VALIDATION_FAILED` (see `app/api/church-group/members/[id]/role/handler.ts`
  BR-12 branch). Schema/shape failures are 400 with the same code.

## Files to create / modify

### 1. MODIFY `lib/supabase/types.ts`

Add a row type next to `NotificationsRow` (around line 199-210):

```ts
// Added for #70 (notification preferences API).
// chat_preference is deliberately omitted: it is a Phase 2 chat concern and the
// `ChatPref` union in types/domain.ts does not match the DB enum
// chat_pref ('all','mentions'). Omitting it from the Insert payload means the
// column keeps its value on update and its DB default on insert.
type NotificationPreferencesRow = {
  id: string;
  user_id: string;
  invitation_sms: boolean;
  invitation_email: boolean;
  invitation_inapp: boolean;
  reminder_sms: boolean;
  reminder_email: boolean;
  reminder_hours_before: number;
  setlist_sms: boolean;
  setlist_email: boolean;
  gcal_sync_enabled: boolean;
};
```

And register the table inside `Database["public"]["Tables"]`, immediately after
the `notifications` entry, following the existing shape exactly:

```ts
      notification_preferences: {
        Row: NotificationPreferencesRow;
        Insert: Omit<NotificationPreferencesRow, "id"> & { id?: string };
        Update: Partial<NotificationPreferencesRow>;
        Relationships: [];
      };
```

Do not modify any other table entry.

### 2. MODIFY `schemas/notifications.ts`

Leave the existing `notificationsSchema` / `NotificationsInput` placeholder
exports untouched (other Sprint 4 issues own them). Append:

```ts
// PRD §6.9.1 defaults — used when the caller has no notification_preferences
// row yet, and as the merge base for a partial PUT.
export const NOTIFICATION_PREFERENCE_DEFAULTS = {
  invitationSms: true,
  invitationEmail: true,
  invitationInapp: true,
  reminderSms: true,
  reminderEmail: false,
  reminderHoursBefore: 24,
  setlistSms: true,
  setlistEmail: true,
  gcalSyncEnabled: false,
} as const;

export const MIN_REMINDER_HOURS_BEFORE = 1;
export const MAX_REMINDER_HOURS_BEFORE = 168; // 1 week

// PUT /api/notifications/preferences body. Every field is optional: omitted
// fields keep their current stored value (partial merge, see spec Decisions).
// BR-14 is NOT enforced here — it is enforced in the handler against the
// MERGED state, because a partial body alone cannot express the final state.
export const updateNotificationPreferencesSchema = z.object({
  invitationSms: z.boolean().optional(),
  invitationEmail: z.boolean().optional(),
  invitationInapp: z.boolean().optional(),
  reminderSms: z.boolean().optional(),
  reminderEmail: z.boolean().optional(),
  reminderHoursBefore: z
    .number()
    .int()
    .min(MIN_REMINDER_HOURS_BEFORE)
    .max(MAX_REMINDER_HOURS_BEFORE)
    .optional(),
  setlistSms: z.boolean().optional(),
  setlistEmail: z.boolean().optional(),
  gcalSyncEnabled: z.boolean().optional(),
});

export type UpdateNotificationPreferencesInput = z.infer<
  typeof updateNotificationPreferencesSchema
>;
```

Zod's default object behavior (strip unknown keys) is intended — extra keys such
as `userId` or `chatPreference` are silently ignored, never written.

### 3. CREATE `app/api/notifications/preferences/handler.ts`

Pattern to copy verbatim for boilerplate: **`app/api/profile/handler.ts`**
(same auth → JWT → `getSupabaseClient` → `maybeSingle` / `upsert(..., { onConflict: "user_id" })`
→ `ok(...)` / `fail(...)` → `ApiException` catch structure). No role gate
(PRD auth = Any, exactly like `/api/profile`).

Exports:

```ts
export type NotificationPreferencesResponse = {
  userId: string;
  invitationSms: boolean;
  invitationEmail: boolean;
  invitationInapp: boolean;
  reminderSms: boolean;
  reminderEmail: boolean;
  reminderHoursBefore: number;
  setlistSms: boolean;
  setlistEmail: boolean;
  gcalSyncEnabled: boolean;
};

export async function getNotificationPreferences(
  req: NextRequest,
  lookup?: UserLookup,
): Promise<Response>;

export async function updateNotificationPreferences(
  req: NextRequest,
  lookup?: UserLookup,
): Promise<Response>;
```

Selected columns (both handlers, one shared constant string):
`"invitation_sms, invitation_email, invitation_inapp, reminder_sms, reminder_email, reminder_hours_before, setlist_sms, setlist_email, gcal_sync_enabled"`.
Never select or write `chat_preference`.

`getNotificationPreferences` logic:

1. `const ctx = await requireAuth(req, lookup);`
2. Get the Clerk Supabase JWT (`auth()` → `getToken({ template: "supabase" })`);
   missing → `fail("Authentication required", ErrorCode.UNAUTHENTICATED, 401)`
   before creating any Supabase client.
3. `supabase.from("notification_preferences").select(COLUMNS).eq("user_id", ctx.userId).maybeSingle()`.
4. `error` → `fail("Internal error", ErrorCode.INTERNAL, 500)`.
5. `!data` → return `ok({ preferences: { userId: ctx.userId, ...NOTIFICATION_PREFERENCE_DEFAULTS } })`.
   **Do not insert a row on GET** (mirrors the synthesized-defaults branch of
   `getProfile`).
6. Otherwise map snake_case → camelCase and return `ok({ preferences })`.
7. `catch`: `ApiException` → `fail(err.message, err.code, err.status)`, else 500 INTERNAL.

`updateNotificationPreferences` logic:

1. `requireAuth`.
2. `const body = await req.json().catch(() => null);` then
   `updateNotificationPreferencesSchema.safeParse(body)`; failure →
   `fail("Validation failed", ErrorCode.VALIDATION_FAILED, 400)`.
3. JWT (401 as above), then Supabase client.
4. Read the caller's current row with the same select as GET.
   `error` → 500 INTERNAL. Build
   `const current = data ? mapRow(data) : { ...NOTIFICATION_PREFERENCE_DEFAULTS }`.
5. `const merged = { ...current, ...parsed };` (Zod's optional fields are absent,
   not `undefined`-valued keys, when omitted — spreading is safe. If the Coder
   prefers explicitness, apply each field with `parsed.x ?? current.x`.)
6. **BR-14 guard**, before any write:
   ```ts
   if (!merged.invitationSms && !merged.invitationEmail && !merged.invitationInapp) {
     return fail(
       "At least one invitation channel (SMS, email, or in-app) must stay enabled",
       ErrorCode.VALIDATION_FAILED,
       422,
     );
   }
   ```
7. Upsert the complete merged row (snake_case, `user_id: ctx.userId`) with
   `{ onConflict: "user_id" }`, `.select(COLUMNS).maybeSingle()`. The payload
   contains every column in `NotificationPreferencesRow` except `id` and
   `chat_preference`, so no `as unknown as ...Insert` cast should be needed —
   only add one if `bun run typecheck` demands it, and comment why (as
   `app/api/profile/handler.ts` does).
8. `error || !data` → `fail("Internal error", ErrorCode.INTERNAL, 500)`.
9. Return `ok({ preferences: { userId: ctx.userId, ...mapRow(data) } })`.
10. Same `catch` block as GET.

`user_id` always comes from `ctx.userId` — never from the request body or a query
param. Ownership is additionally enforced by the existing RLS policies.

### 4. MODIFY `app/api/notifications/preferences/route.ts`

Replace the stub with the thin-delegation shape of `app/api/profile/route.ts`
(drop the `notImplemented` import):

```ts
import { NextRequest } from "next/server";
import { getNotificationPreferences, updateNotificationPreferences } from "./handler";

export async function GET(req: NextRequest): Promise<Response> {
  return getNotificationPreferences(req);
}

export async function PUT(req: NextRequest): Promise<Response> {
  return updateNotificationPreferences(req);
}
```

### 5. CREATE `tests/unit/app/api/notification-preferences-route.test.ts`

Mirror `tests/unit/app/api/profile-route.test.ts` exactly in structure:
top-of-file `jest.mock("@clerk/nextjs/server", ...)` and
`jest.mock("@/lib/supabase/client", ...)`, plus the `makeReq` / `makeLookup` /
`setUpAuth` / `makeSupabaseClient` helpers (adapted to a single
`notification_preferences` table fixture, with an `onUpsert` capture callback so
the written payload can be asserted).

Cover at minimum: GET with an existing row; GET with no row (defaults, and assert
no upsert was issued); PUT happy path (captured payload is the merged snake_case
row, response is 200); PUT BR-14 direct (`invitationSms/Email/Inapp` all `false`
in one body) → 422 and **no upsert issued**; PUT BR-14 via merge (stored row has
sms+email already `false`, body sets `invitationInapp: false`) → 422; PUT that
leaves one channel true → 200; malformed body → 400; out-of-range
`reminderHoursBefore` → 400; missing JWT → 401; DB error → 500.

## Edge cases the implementation MUST handle

1. **No row yet, GET** → 200 with the PRD defaults and `userId`; no row created.
2. **No row yet, PUT** → merge onto the PRD defaults, then insert via upsert; the
   BR-14 check runs against that merged state.
3. **BR-14, explicit** → body disables all three invitation channels → 422
   `VALIDATION_FAILED`, nothing written.
4. **BR-14, via merge** → body disables the last remaining enabled invitation
   channel (others already `false` in the DB) → 422, nothing written. This is the
   case a body-only check would miss.
5. **BR-14 not violated** → any one invitation channel still `true` → 200.
6. **Re-enabling** → a body that turns a previously-disabled channel back on is
   always allowed.
7. **Empty object body `{}`** → valid; 200 returning the current (unchanged)
   effective preferences.
8. **Malformed body** (`null`, array, non-JSON, wrong field types) → 400
   `VALIDATION_FAILED`.
9. **`reminderHoursBefore`** must be an integer within
   `[MIN_REMINDER_HOURS_BEFORE, MAX_REMINDER_HOURS_BEFORE]` = `[1, 168]`; `0`,
   `169`, `1.5`, `"24"` → 400.
10. **Unknown keys** (e.g. `userId`, `chatPreference`, `id`) are stripped, never
    written; a body carrying another user's `userId` cannot retarget the write.
11. **`chat_preference` is never read or written** — an existing row's value must
    survive a PUT untouched, and a newly inserted row gets the DB default.
12. **No JWT from Clerk** → 401 `UNAUTHENTICATED` before any Supabase client is
    constructed (assertable via `getSupabaseClient` not being called).
13. **Unauthenticated (Clerk `userId` null)** → 401, `lookup` never consulted.
14. **DB error** on the select or the upsert → 500 `INTERNAL` (never leak the
    driver message).
15. Response envelope is `{ data: { preferences: NotificationPreferencesResponse } }`
    via `ok(...)`; errors are `{ error, code }` via `fail(...)`.

## Decisions (do not deviate)

- **PUT is a partial merge, not a full replace.** All body fields are optional;
  omitted fields keep their stored value. Rationale: BR-14 must be judged on the
  resulting state, and a client that only knows a subset of fields must not
  silently reset the rest. This is the one intentional divergence from
  `PUT /api/profile` (full replace) — everything else copies that handler.
- **`reminderHoursBefore` range is `[1, 168]`.** The column is an integer count of
  hours, so the PRD's "30 minutes" option is not representable and is out of scope
  here; 168 caps the value at one week. Constants live in `schemas/notifications.ts`
  so a later issue can widen them in one place.
- **`chat_preference` is out of the API surface** (Phase 2 chat, and
  `types/domain.ts`'s `ChatPref` contradicts the DB enum). Do **not** "fix"
  `types/domain.ts` — that is a separate concern and out of scope for #70.
- **Scope guardrails**: no migration, no RLS change, no UI/settings screen, no
  changes to notification *trigger* logic (#69 consumes these preferences later),
  no changes to any other route, no service-role client.

## Verification before finishing (Coding stage)

Run `bun run lint`, `bun run typecheck`, and `bun run test`. All must pass.
