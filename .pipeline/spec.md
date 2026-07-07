# Spec — Issue #30: Member profile CRUD (`GET`/`PUT /api/profile`)

## OPEN QUESTIONS

None blocking. Two deliberate scoping decisions the Coder must honor (not ambiguities):

1. **Profile row may not exist yet.** The join RPC (`join_church_group`) and create-group RPC
   both create a `users` row but **no** `member_profiles` row (verified in
   `supabase/migrations/20260706000002_church_group_join_rpc.sql` and
   `20260706000001_church_group_create_rpc.sql`). PRD §13.4 onboarding step 4 is what first
   creates it. Therefore:
   - `GET` must tolerate a missing row and return synthesized defaults (do **not** auto-create).
   - `PUT` must **upsert** (insert if absent, update if present), keyed on the unique `user_id`.
2. **Instruments are read-only here.** PRD §22.2 lists instrument selection under `PUT /api/profile`,
   but Issue #30 explicitly defers that to #31. So: `GET` **returns** the joined instrument list;
   `PUT` **ignores / does not touch** `member_instruments`. Do not add instrument write logic.

## Goal (scope of THIS issue)

Implement `GET /api/profile` (caller's own `member_profiles` record + selected instruments) and
`PUT /api/profile` (update `vocal_capability`, `bio`). Own-profile only — no `:id` param; identity
comes from the auth context (`ctx.userId`). Validated with Zod; `vocal_capability` restricted to the
enum. Do not touch any other route.

## Current state (already done — do NOT redo)

- `app/api/profile/route.ts` exists as a scaffold: an ad-hoc `GET` returning `{ userId }` and a
  `PUT` that returns `notImplemented(...)`. **Replace both.**
- `schemas/profile.ts` is an empty-object placeholder (`z.object({})`). **Replace it.**
- Schema and RLS already exist — **no new migration**:
  - `member_profiles` (`20260702000001_cluster_1_organization.sql`):
    `id`, `user_id` (unique FK → users.id), `vocal_capability`
    (enum `'none'|'lead'|'harmony'|'both'`, NOT NULL default `'none'`), `bio text` (nullable),
    `created_at`. **There is no `updated_at` column.**
  - RLS (`20260704000001_rls_policies.sql`): `member_profiles_select_tenant` (group-scoped read),
    `member_profiles_insert_own` and `member_profiles_update_own` (allow when
    `user_id = auth_user_id()`). `member_instruments_select_tenant` and `instruments_select_tenant`
    are group-scoped reads. All are already in place.
- `lib/supabase/types.ts` already types `member_profiles`, `instruments`, `member_instruments`
  (Row/Insert/Update). **No changes needed there.**
- `types/domain.ts` already exports `VocalCapability = "lead" | "harmony" | "both" | "none"`.

## Files to create / modify

### 1. REWRITE `schemas/profile.ts`

Replace the placeholder stub entirely:

```ts
import { z } from "zod";

export const VOCAL_CAPABILITY_VALUES = ["lead", "harmony", "both", "none"] as const;

// PUT /api/profile body. Full replace of the two editable profile fields.
// bio: optional/nullable free text; empty/whitespace-only is normalized to null.
export const updateProfileSchema = z.object({
  vocalCapability: z.enum(VOCAL_CAPABILITY_VALUES),
  bio: z
    .string()
    .trim()
    .max(2000)
    .nullish()
    .transform((v) => (v && v.length > 0 ? v : null)),
});

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
```

Notes:
- Enum values match the Postgres `vocal_capability` enum and `VocalCapability` in `types/domain.ts`.
- `2000` char cap is a defensive default (PRD §20.2 lists `bio` as plain `text`, no length given).
  Keep it; do not invent other fields.

### 2. CREATE `app/api/profile/handler.ts`

Follow the exact structure of `app/api/church-group/members/handler.ts` (auth → JWT → RLS client →
queries → map → `ok(...)`; single `try/catch` converting `ApiException` to `fail`, else 500).

Exports:

```ts
import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireAuth, type UserLookup } from "@/lib/api/auth";
import { ok, fail } from "@/lib/api/response";
import { ApiException, ErrorCode } from "@/lib/api/errors";
import { getSupabaseClient } from "@/lib/supabase/client";
import type { VocalCapability } from "@/types/domain";
import { updateProfileSchema } from "@/schemas/profile";

export type ProfileResponse = {
  userId: string;                              // users.id (the caller)
  vocalCapability: VocalCapability;            // 'none' when no profile row exists yet
  bio: string | null;
  instruments: { id: string; name: string }[]; // read-only; [] when no profile / no instruments
};

export async function getProfile(req: NextRequest, lookup?: UserLookup): Promise<Response>;
export async function updateProfile(req: NextRequest, lookup?: UserLookup): Promise<Response>;
```

Do **not** call `requireRole`. Ownership is enforced by RLS (`user_id = auth_user_id()`) and by
querying `ctx.userId`; there is no role gate in the AC. (A `guest` would pass auth but has no
meaningful profile — acceptable, out of scope.)

**`getProfile`:**
1. `const ctx = await requireAuth(req, lookup);` — throws 401 `UNAUTHENTICATED` when no Clerk
   session or no `users` row.
2. Build the Supabase client from the Clerk JWT (same as the members handler):
   `const { getToken } = await auth();`
   `const jwt = await getToken({ template: "supabase" });`
   if `!jwt` → `return fail("Authentication required", ErrorCode.UNAUTHENTICATED, 401);`
   `const supabase = getSupabaseClient(jwt);`
3. Fetch the caller's profile:
   `supabase.from("member_profiles").select("id, vocal_capability, bio").eq("user_id", ctx.userId).maybeSingle();`
   - On `.error` → `return fail("Internal error", ErrorCode.INTERNAL, 500);`
   - If `data` is null → return
     `ok({ profile: { userId: ctx.userId, vocalCapability: "none", bio: null, instruments: [] } })`.
     Do **not** query instruments in this branch.
4. If a profile row exists, load its instruments via the shared helper (below) and return
   `ok({ profile })` with the assembled `ProfileResponse`
   (`vocalCapability = data.vocal_capability`, `bio = data.bio`).

**`updateProfile`:**
1. `const ctx = await requireAuth(req, lookup);`
2. Parse body defensively (mirror `app/api/church-group/join/route.ts`):
   `const body = await req.json().catch(() => null);`
   `const parsedResult = updateProfileSchema.safeParse(body);`
   if `!parsedResult.success` → `return fail("Validation failed", ErrorCode.VALIDATION_FAILED, 400);`
   `const parsed = parsedResult.data;`
3. Get the JWT (401 if none) and `getSupabaseClient(jwt)` as in `getProfile`.
4. Upsert the profile (row may not exist — OPEN QUESTION 1):
   ```ts
   const { data, error } = await supabase
     .from("member_profiles")
     .upsert(
       { user_id: ctx.userId, vocal_capability: parsed.vocalCapability, bio: parsed.bio },
       { onConflict: "user_id" },
     )
     .select("id, vocal_capability, bio")
     .maybeSingle();
   ```
   - RLS `member_profiles_insert_own` / `_update_own` permit this because `user_id = auth_user_id()`.
   - Do **not** set `id`, `created_at`, or any `updated_at` (no such column; DB defaults handle `id`/`created_at`).
   - On `error` → `return fail("Internal error", ErrorCode.INTERNAL, 500);`
5. Load instruments for the returned profile row via the shared helper, and return `ok({ profile })`
   (status 200) with the identical `ProfileResponse` shape as `getProfile`.

**Shared private helper** (factor out to avoid drift; used by both handlers):
```ts
async function loadInstruments(
  supabase: /* SupabaseClient<Database> */,
  memberProfileId: string,
  churchGroupId: string,
): Promise<{ id: string; name: string }[]>
```
Implementation mirrors the instrument name-mapping in `app/api/church-group/members/handler.ts`:
- `supabase.from("member_instruments").select("member_profile_id, instrument_id").eq("member_profile_id", memberProfileId)`
- `supabase.from("instruments").select("id, name").eq("church_group_id", churchGroupId)`
- Build a `Map<instrument_id, name>`; map the member's rows to `{ id, name }`, **skipping** any
  `instrument_id` with no matching instrument.
- If either query `.error` is non-null, throw `new ApiException("Internal error", ErrorCode.INTERNAL, 500)`
  so the outer `try/catch` returns 500 (or return `fail(...)` from the caller — either is fine as long
  as errors become 500 INTERNAL).

**Catch block** (copy from members handler):
```ts
} catch (err) {
  if (err instanceof ApiException) return fail(err.message, err.code, err.status);
  return fail("Internal error", ErrorCode.INTERNAL, 500);
}
```

### 3. REWRITE `app/api/profile/route.ts`

Reduce to thin delegators, mirroring `app/api/church-group/members/route.ts`:

```ts
import { NextRequest } from "next/server";
import { getProfile, updateProfile } from "./handler";

export async function GET(req: NextRequest): Promise<Response> {
  return getProfile(req);
}

export async function PUT(req: NextRequest): Promise<Response> {
  return updateProfile(req);
}
```

### 4. CREATE `tests/unit/app/api/profile-route.test.ts`

Copy the mocking harness from `tests/unit/app/api/church-group-members-route.test.ts`
(`jest.mock("@clerk/nextjs/server")`, `jest.mock("@/lib/supabase/client")`, `makeLookup(role)`,
`setUpAuth()`, a `makeSupabaseClient(overrides)` fixture builder). Extend the fixture builder so the
mocked `from(table)` supports the chains this handler uses:
- `.select(...).eq(...).maybeSingle()` → resolves to the configured `member_profiles` result.
- `.select(...).eq(...)` → resolves to the configured `member_instruments` / `instruments` result.
- `.upsert(payload, opts).select(...).maybeSingle()` → records `payload` and resolves to the
  configured `member_profiles` result.

Cases to cover (map 1:1 to acceptance criteria + edge cases):
- `GET` 401 when Clerk `userId` is null (lookup never consulted).
- `GET` 401 when `getToken` yields no JWT.
- `GET` 200 with an existing profile → `{ profile: { userId, vocalCapability, bio, instruments } }`,
  instruments correctly name-mapped.
- `GET` 200 when **no** `member_profiles` row → `vocalCapability: "none"`, `bio: null`,
  `instruments: []`.
- `GET` skips a `member_instruments` row whose `instrument_id` has no matching instrument.
- `GET` 500 when the `member_profiles` query returns an error.
- `PUT` 400 `VALIDATION_FAILED` when `vocalCapability` is not lead/harmony/both/none.
- `PUT` 400 `VALIDATION_FAILED` when body is malformed / missing `vocalCapability`.
- `PUT` 200 updates an existing profile and returns the updated `ProfileResponse`.
- `PUT` 200 creates (upserts) a profile for a member who had none, returning the new values.
- `PUT` normalizes empty/whitespace `bio` to `null` (assert the recorded upsert payload / response `bio`).
- `PUT` 500 when the upsert returns an error.
- `PUT` 401 when `getToken` yields no JWT.

## Response contract (both routes)

Success: `ok({ profile: ProfileResponse })` → `{ "data": { "profile": { ... } } }` via
`lib/api/response.ts`. Errors via `fail(message, code, status)` with `ErrorCode` from
`lib/api/errors.ts`. No new error codes needed.

## Edge cases the implementation must handle

- Unauthenticated / unprovisioned user (no `users` row) → 401 (handled by `requireAuth`).
- Missing supabase JWT despite a Clerk session → 401.
- Missing `member_profiles` row: `GET` → synthesized defaults; `PUT` → insert via upsert.
- `member_instruments` referencing a missing / other-group instrument → skipped in mapping.
- Invalid `vocal_capability` value → 400 `VALIDATION_FAILED`.
- Malformed JSON body on `PUT` → 400 (never throw; use `.catch(() => null)`).
- Empty/whitespace `bio` → stored as `null`.
- Any DB error → 500 `INTERNAL`.
- No `updated_at` column on `member_profiles` — do **not** attempt to set one.

## Patterns to follow (name the file)

- Handler structure, auth+JWT flow, instrument name-mapping, error handling:
  `app/api/church-group/members/handler.ts`.
- Thin route delegation: `app/api/church-group/members/route.ts`.
- Zod `safeParse` on request body + 400 mapping: `app/api/church-group/join/route.ts`.
- Zod schema style: `schemas/church-group.ts`.
- Success/error envelope: `lib/api/response.ts` (`ok`, `fail`); shape in `types/api.ts`.
- Unit test harness / Supabase mock: `tests/unit/app/api/church-group-members-route.test.ts`.

## Explicitly out of scope

- Instrument selection writes (`member_instruments` mutations) — Issue #31.
- Song familiarity — Phase 2.
- Any `:id`-parameterized route or admin-edits-another-member profile.
- New migrations — schema and RLS already exist
  (`20260702000001_cluster_1_organization.sql`, `20260704000001_rls_policies.sql`).
- Changes to `lib/supabase/types.ts` — the needed tables are already typed.
