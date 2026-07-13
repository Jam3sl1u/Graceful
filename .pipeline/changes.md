# Changes — Issue #44: Token-based public invitation lookup

## Summary

Implemented `GET /api/invitations/respond/:token`, a no-session, no-Clerk-auth
read-only endpoint that returns an invitation's details (plus its service week
and events) to someone tapping an SMS/email link. Token possession is the only
credential. Follows the exact pattern the accept-invitation flow (#41) uses for
its no-session path: a `SECURITY DEFINER` RPC authenticated by the token,
invoked through `getAnonSupabaseClient()`.

## Files changed

- **`supabase/migrations/20260712000002_get_invitation_by_token_rpc.sql`** (new)
  — `public.get_invitation_by_token(p_response_token text)`, a `STABLE`
  (read-only) `SECURITY DEFINER` function. Looks up the invitation by
  `response_token`, raises `NOT_FOUND` (`P0001`) if no row matches, and
  otherwise returns a jsonb payload with the invitation, its service week, and
  its events (empty array via `coalesce` when the week has no events yet).
  Computes an API-only `"expired"` status when a still-`pending` invitation is
  past its `response_deadline`; already-responded rows (accepted/denied/
  withdrawn) keep their real status. Granted to `anon` and `authenticated`.
  Includes the commented `DROP FUNCTION` DOWN line matching the
  `accept_invitation` migration's style.

- **`lib/supabase/types.ts`** — added `EventType` to the existing
  `@/types/domain` import, and added a `get_invitation_by_token` entry to
  `Database["public"]["Functions"]` alongside `accept_invitation`, typed with
  the RPC's snake_case `Args`/`Returns` shape.

- **`schemas/invitations.ts`** — added `respondTokenParamSchema`, the same
  64-char-hex `z.string().length(64).regex(/^[0-9a-f]{64}$/)` shape as
  `acceptInvitationParamSchema`'s token, used to validate the route param
  before ever calling the RPC.

- **`app/api/invitations/handler.ts`** — added `EventType` to the existing
  `@/types/domain` type import and `respondTokenParamSchema` to the existing
  `@/schemas/invitations` import block. Added:
  - `export type PublicInvitationLookup` — the camelCase response shape
    (`invitationId`, `status`, `roleNote`, `responseDeadline`, `serviceWeek`,
    `events[]`).
  - `export async function getInvitationByToken(token: string): Promise<Response>`
    — validates the token format first (anti-enumeration: a malformed token
    returns the byte-identical 404 as an unknown-but-well-formed one, without
    ever calling the RPC or `getAnonSupabaseClient`); on valid format, calls
    `get_invitation_by_token` via `getAnonSupabaseClient()`, maps `NOT_FOUND`
    RPC errors to 404, any other RPC error to 500 `INTERNAL`, and on success
    maps the snake_case RPC payload to `PublicInvitationLookup`. Does **not**
    call `requireAuth`, `auth()`, or `getSupabaseClient` — no session by
    design.

- **`app/api/invitations/respond/[token]/route.ts`** — replaced the
  `notImplemented` stub with a thin `GET` handler that awaits `params` and
  delegates to `getInvitationByToken`.

- **`tests/unit/app/api/invitations-respond-route.test.ts`** (new) — mirrors
  `invitations-accept-route.test.ts`'s mocking style (`jest.mock` on
  `@/lib/supabase/client`, a `makeRpcClient({ data, error })` helper). No
  Clerk/`auth()` mocking (this route never touches it). Covers every edge case
  from the spec:
  1. Happy path (pending) — 200, full camelCase body, asserts
     `getAnonSupabaseClient` was called with the right RPC args.
  2. Expired (still-pending, RPC-computed `status: "expired"`) — 200, not an
     error code.
  3. Already responded — parameterized over `accepted`/`denied`/`withdrawn` —
     200 with the real status.
  4. Unknown token (valid format, RPC raises `NOT_FOUND`) — 404
     `{ error: "Not found", code: "NOT_FOUND" }`.
  5. Malformed token, two variants (wrong length; non-hex) — asserts the
     **identical** 404 body as case 4, and that `getAnonSupabaseClient` is
     never called.
  6. Empty events (`events: []` from RPC) — still 200, `events: []` in the
     response.
  7. Unexpected RPC error message — 500 `INTERNAL`.

- **`.pipeline/spec.md`** — carried forward as-is from the Planning stage's
  output for issue #44 (not authored by this stage).

## Out of scope (per spec, not touched)

- No changes to `acceptInvitation`/`denyInvitation` (#41/#42).
- No Clerk/session handling added to this route.
- Did not add `events` to `Database["public"]["Tables"]` — the RPC returns
  events as jsonb, so only the `Functions` entry was needed.
- No notification/SMS dispatch.

## Verification

- `bun run lint` — clean, no errors.
- `bun run typecheck` (`tsc --noEmit`) — clean, no errors.
- `bun run test` (Jest) — full suite: **28 suites / 363 tests passed**,
  including the new 10-test file for this route. Per the spec, the RPC body
  itself has no live-DB test harness in this repo (same as
  `accept_invitation`) — correctness is verified via the route tests that
  mock its return values.

## What the Tester should focus on

- The anti-enumeration guarantee: cases 4 and 5 in the new test file assert
  byte-identical response bodies (`{ error: "Not found", code: "NOT_FOUND" }`,
  status 404) for both a well-formed-but-unknown token and a malformed one —
  worth double-checking this holds if the route or handler is touched again.
- The `"expired"` status is intentionally HTTP 200, not a 4xx/5xx — confirm no
  downstream assumption treats it as an error.
- The RPC's own logic (expiry computation, `coalesce` to `'[]'` for no events,
  `SECURITY DEFINER`/`STABLE`/`search_path` hardening) is not exercised by any
  automated test in this repo — it was checked by direct code review against
  the `accept_invitation` migration's established pattern.
