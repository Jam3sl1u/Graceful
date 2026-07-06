# Changes for Issue #24 — Implement church group creation

`PUT /api/church-group` now creates a church group, assigns the creator as
`admin`, auto-generates a unique invite code, and seeds the 9 default
instruments — all atomically inside a new `SECURITY DEFINER` Postgres RPC.

## Files modified

1. **`supabase/migrations/20260705000001_church_group_create_fn.sql`** (new) —
   `public.create_church_group(p_name, p_timezone, p_denomination, p_logo_url,
   p_user_name, p_user_email) returns public.church_groups`, `LANGUAGE plpgsql
   SECURITY DEFINER SET search_path = ''`.
   - Reads `v_clerk_id := auth.jwt() ->> 'sub'`; raises `GR000` if null.
   - Already-a-member guard: raises `GR001` (`'user already belongs to a
     church group'`) if a `public.users` row already exists for that
     `clerk_id`.
   - Generates an 8-character invite code from the unambiguous alphabet
     `23456789ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz`, one char per
     `gen_random_bytes(1)` byte (crypto-random). Inserts into
     `church_groups` inside a `begin … exception when unique_violation`
     loop so an invite-code collision retries transparently and never
     surfaces to the client.
   - Inserts the creator into `public.users` with `role = 'admin'`,
     `name = p_user_name`, `email = p_user_email` (nullable), capturing the
     new `users.id`.
   - Seeds exactly 9 rows into `public.instruments`
     (`Acoustic guitar`, `Electric guitar`, `Bass guitar`,
     `Piano / keyboard`, `Violin`, `Vocalists`, `Drums`, `Cajon`, `Other`)
     with `is_default = true` and `created_by` = the new user id.
   - `grant execute ... to authenticated;` after the function; commented
     `drop function` in the DOWN block.
   - Follows the `-- ============ UP ============` / commented DOWN
     convention and the `auth_*` SECURITY DEFINER pattern from
     `20260704000001_rls_policies.sql`.

2. **`schemas/church-group.ts`** (modified) — added
   `createChurchGroupSchema` / `CreateChurchGroupInput`:
   `name` (trimmed, 1–100 chars), `timezone` (trimmed, 1–50 chars, defaults
   to `America/Chicago`, `.refine`d against `Intl.supportedValuesOf("timeZone")`
   so non-IANA values fail validation), optional `denomination` (1–100
   chars) and optional `logo_url` (must be a URL). The pre-existing empty
   `churchGroupSchema`/`ChurchGroupInput` stub was left in place unchanged
   (nothing imports it; spec allowed leaving it).

3. **`app/api/church-group/route.ts`** (modified) — `GET` unchanged
   (`notImplemented` stub). `PUT` implemented per spec:
   - Uses Clerk `auth()` directly (NOT `requireAuth`, which would 401 a
     brand-new user with no `users` row) → 401 `UNAUTHENTICATED` if no
     `clerkId`.
   - Parses the body defensively (`req.json().catch(() => null)`), then
     `createChurchGroupSchema.safeParse` → 400 `VALIDATION_FAILED` on
     failure.
   - `getToken({ template: "supabase" })` → 401 `UNAUTHENTICATED` if no JWT.
   - `currentUser()` derives `name` (first+last, else username, else
     `"Admin"`) and `email` (primary email, else first email, else null).
   - Calls `supabase.rpc("create_church_group", { p_name, p_timezone,
     p_denomination, p_logo_url, p_user_name, p_user_email })` via
     `getSupabaseClient(jwt)`.
   - `error?.code === "GR001"` → 409 `CONFLICT` (`"You already belong to a
     church group"`); any other RPC error → thrown `ApiException` → 500
     `INTERNAL`.
   - Success → `ok(data, 201)`.
   - Whole handler wrapped in try/catch mirroring
     `app/api/_examples/admin-only/route.ts` (`ApiException` → `fail`,
     else generic 500).

4. **`lib/supabase/types.ts`** (modified) — added `ChurchGroupsRow` and
   `InstrumentsRow` types, `church_groups` and `instruments` entries under
   `Tables` (existing `users` entry untouched), and replaced
   `Functions: Record<string, never>` with a `create_church_group` entry
   (`Args` matching the RPC's `p_*` params, `Returns: ChurchGroupsRow`) so
   the typed client + `.rpc(...)` call compile under `bun run typecheck`.

5. **`supabase/README.md`** (modified) — added one row to the Migrations
   table for `20260705000001_church_group_create_fn.sql` (Issue #24).

## Verification performed

- `bun install` — clean.
- `bun run lint` — passes, no errors.
- `bun run typecheck` — passes, no errors.
- `bun run check:service-role` — passes (`OK: no service-role key
  references found outside comments in app/ or lib/.`); no service-role key
  referenced anywhere in this change.
- `bun run test` — all 4 existing suites / 17 tests pass unchanged (no new
  unit tests were added by the coder per the spec's tester notes — the
  Tester stage owns writing route/schema unit tests; the RPC itself is
  exercised by the live-DB RLS integration suite, out of scope here).
- `bun run format:check` — pre-existing failures on `README.md`,
  `supabase/README.md`, and `tests/integration/rls/**` were already present
  before this change (confirmed via `git stash` + rerun); none of the files
  I touched introduced *new* formatting violations beyond what was already
  flagged for `supabase/README.md` (that file was already failing
  `format:check` prior to my one-line addition).

## What the Tester should focus on

- Unit tests for `PUT /api/church-group` mocking `@clerk/nextjs/server`
  (`auth`, `currentUser`) and `@/lib/supabase/client` (`getSupabaseClient`
  returning an object with a `rpc` mock), following
  `tests/unit/lib/api/lookup-user.test.ts` and
  `tests/unit/app/api/admin-only-route.test.ts` patterns named in the spec.
- Edge cases: missing/blank `name` (400), non-IANA `timezone` (400),
  omitted `timezone` defaults to `America/Chicago`, omitted
  `denomination`/`logo_url` → nulls, malformed/empty JSON body (400, no
  throw), no Clerk session (401), missing Supabase JWT template (401),
  RPC returns `{ code: "GR001" }` → 409 `CONFLICT`, any other RPC error →
  500 `INTERNAL`, success → `ok(data, 201)`.
- The SQL migration itself (invite-code collision retry, atomicity of
  group+user+9-instruments, `GR000`/`GR001` error codes) is intended to be
  covered by the live-DB RLS integration suite (`bun run test:rls`), not
  unit tests — per the spec's "Notes for the tester" section.

## Note on `.pipeline/spec.md`

`.pipeline/spec.md` showed as modified in the working tree (Planner's #24
spec replacing the prior #23 spec content) but was deliberately **not**
included in the code commit — per `.pipeline/README.md` (`spec.md` is
Planner→Coder handoff only, overwritten each pipeline run) and prior repo
precedent (commit `8b1915a`, "Revert unrelated .pipeline/spec.md change
swept into previous commit"). I initially committed it by mistake in
`13366ac` and reverted it in a follow-up commit (`83c32cb`); the working
tree still has the current #24 spec content on disk (only the git-tracked
version was rolled back), so nothing downstream is affected.
