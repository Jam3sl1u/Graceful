# Changes — Issue #80: Full auth-bypass & RLS-bypass test suite (all Phase 1 tables)

Test-only change (per spec Assumption 3): nothing under `app/`, `lib/`,
`schemas/`, `middleware.ts`, or `supabase/` was touched.

## Files changed

- `tests/support/api-auth.ts` (MODIFY) — promoted `DEFAULT_USER_ID` /
  `DEFAULT_CHURCH_GROUP_ID` to exports; added `VICTIM_CHURCH_GROUP_ID` /
  `VICTIM_USER_ID` constants, `makeNullLookup()` (models an expired/absent
  Supabase-template JWT), and `makeApiReq()` (generic `NextRequest` double
  covering query params, JSON body, headers).
- `tests/support/recording-supabase.ts` (CREATE) — generic Supabase client
  double (`Proxy`-based) that records every table/rpc/argument string that
  reaches it, used to sweep ~60 handlers without per-handler chain mocks.
  Self-tested at the top of `auth-bypass-matrix.test.ts`.
- `tests/support/admin-route-registry.ts` (CREATE) — single source of truth
  for the AC-1 sweep: every exported handler that takes a `UserLookup`
  (`ADMIN_ROUTE_REGISTRY`), with `allowedRoles`, `scope`, and an `invoke()`
  that addresses another tenant's resources. Also carries three optional,
  per-entry, documented escape hatches discovered while making the sweep
  green against real handler behavior — see "Registry exceptions" below.
- `tests/unit/app/api/auth-bypass-matrix.test.ts` (CREATE, AC-1) —
  `describe.each(ADMIN_ROUTE_REGISTRY)` sweep: no-token (401), two
  expired-token variants (401), insufficient-role (403) for every
  disallowed role, and the cross-tenant-admin case (tenant scope must come
  from `ctx`, never the request). Plus explicit coverage for the
  non-registry routes (`claimGuestInvitation`, `PUT /api/church-group`,
  `POST /api/church-group/join`, `GET /api/cron/invitation-reminders`).
- `tests/unit/schemas/input-validation-injection.test.ts` (CREATE, AC-3) —
  Part A: every free-text string field of every exported Zod object schema
  in `schemas/*.ts`, swept against a SQLi/XSS/null-byte/Unicode payload
  corpus, asserting reject-or-verbatim-survival plus oversized/empty
  rejection and enum-field rejection. Part B: extends
  `escapePostgrestFilterValue`'s existing test corpus. Part C: behavioral
  test of `createGuestInvitation`'s `escapeLikePattern` use.
- `tests/unit/middleware-rate-limit-matrix.test.ts` (CREATE, AC-4) — sweeps
  the `auth`, `sms`, `invite`, and `write` tiers (see spec Assumption 1 for
  why not a job-submission tier) across 8 representative routes, plus four
  budget-isolation cases including the pipeline-contract-required failure
  case (exhausting one identifier's budget must not affect another's).
- `tests/integration/rls/jwt.ts` (MODIFY) — `TestClaims` gained
  `expiresInSeconds` (negative → already-expired token, also back-dates
  `iat`) and `signingSecret` (forged-signature tests). `mintJwt`'s existing
  behavior is byte-identical when both are omitted.
- `tests/integration/rls/client.ts` (MODIFY) — added `getAnonClient()`, an
  anon-key client with no `Authorization` header.
- `tests/integration/rls/tables/phase1-token-bypass.test.ts` (CREATE, AC-2)
  — `PHASE1_TABLES` (19 tables). Block A (coverage pin) runs unconditionally
  without RLS env vars: asserts the list has exactly 19 entries and that
  every one is referenced in `cross-tenant-bypass.test.ts`. Blocks B/C/D
  (each `it.each(PHASE1_TABLES)`, gated behind the existing RLS skip guard):
  unauthenticated caller, expired Church-A JWT, wrong-signature JWT — all
  must be blocked on every table. Block E: three named trust-boundary
  characterization tests (not a sweep) — see SECURITY FINDINGS.

## Registry exceptions (tests/support/admin-route-registry.ts)

While wiring the sweep against real handler behavior, three classes of
handler turned out not to fit the generic sweep's implicit assumptions.
Each is called out with a `RouteEntry` field and an inline comment at the
specific entry (not applied blanket) — the negative "no victim id ever
leaks" assertion always still runs for every entry that touches Supabase,
and is a live, reachable check (see "Reviewer fix-up" below for why); only
inapplicable positive assertions are skipped, each with a stated, verified
reason:

- `touchesSupabase: false` — `adminOnlyExample` and `google-calendar/connect`
  never call `getSupabaseClient`/`getAnonSupabaseClient` on any path
  (verified by reading the handler source), so there is no tenant-scoped DB
  call to inspect and no stale-JWT re-check to break.
- `authFailureIsRedirect: true` — `google-calendar/callback` always responds
  with an HTTP redirect, never JSON, on any failure (its own file-header
  comment says so explicitly); the sweep asserts a 3xx redirect instead of a
  401 JSON body for that entry's auth-failure cases.
- `ownScopeAssertion: false` — `getAuditLog`, `deleteMember`, and
  `acceptInvitation` scope entirely via RLS and/or a SECURITY DEFINER RPC
  that derives identity from the JWT server-side, with no literal
  `ctx.churchGroupId`/`ctx.userId` argument in the call for the positive
  "own scope id present" check to find. See SECURITY FINDINGS below.
- `GET /api/availability?user_id=<other>` also gets `ownScopeAssertion: false`
  — not a defense-in-depth gap, see SECURITY FINDINGS item 2.

These exceptions were only added after every one of the 60 registry entries
was run and each failure traced back to actual handler source, not assumed.

## SECURITY FINDINGS

### 1. Some admin routes rely solely on RLS/RPC-derived identity, with no app-layer defense-in-depth filter

`getAuditLog` (`GET /api/church-group/audit-log`), `deleteMember`
(`DELETE /api/church-group/members/:id`, via the `remove_church_group_member`
RPC), and `acceptInvitation` (`POST /api/invitations/:id/accept`, via the
`accept_invitation` RPC) never pass `ctx.churchGroupId` or `ctx.userId` as a
literal query/RPC argument — tenant/user scoping for these three is enforced
entirely by RLS reading the caller's JWT (`auth_church_group_id()`) or by a
SECURITY DEFINER RPC that reads `auth.uid()`/the JWT `sub` claim internally.
This is architecturally sound (identity can't be spoofed by an app-layer bug
passing a caller-supplied id) and is exactly the trust boundary Block E below
pins — but unlike sibling routes such as `denyInvitation` (which explicitly
`.eq("church_group_id", ctx.churchGroupId).eq("user_id", ctx.userId)`
*before* mutating, as a second layer beyond RLS), these three routes have no
redundant application-layer check. Not a fix-now bug (RLS is confirmed
enforcing the boundary by `tests/integration/rls/tables/cross-tenant-bypass.test.ts`
and this issue's own `phase1-token-bypass.test.ts`), but worth #79's
attention as a defense-in-depth gap: if RLS on `audit_logs`, `users`, or
`invitations` were ever misconfigured or bypassed (e.g. a future code path
that reaches for the service-role client by mistake), these three routes
have no second layer to catch it.

### 2. `GET /api/availability?user_id=` intentionally has no literal `ctx.userId` scope on the cross-user path

Not a vulnerability — documented for completeness. When an admin/leader
supplies `?user_id=<other>`, the handler substitutes that id for
`ctx.userId` entirely (that's the endpoint's purpose: letting a leader look
up a specific teammate's availability). Cross-group isolation is enforced
by RLS via the caller's own JWT, not by an explicit `church_group_id`
filter in this handler — consistent with `tests/integration/rls`.

### 3. `escapeLikePattern` is defense-in-depth that the schema layer already makes unreachable for `%`/`\`

`POST /api/invitations/guest`'s `.ilike("email", ...)` lookup uses a
module-private `escapeLikePattern` (`app/api/invitations/handler.ts:285`).
Zod's `.email()` format check in `createGuestInvitationSchema` rejects any
local-part containing `%` or `\` before the handler body ever runs, so those
two characters never reach `escapeLikePattern` through this endpoint today
— only `_` does (proven correct in `input-validation-injection.test.ts`).
This is real, if incidental, defense-in-depth: `escapeLikePattern` itself
still correctly escapes all three characters (verified directly), so the
route is safe either way, but the schema is the layer actually carrying the
weight for `%`/`\`.

### 4. Block E — trust-boundary characterization (`phase1-token-bypass.test.ts`)

Per the migration's own design (`public.auth_church_group_id()` /
`public.auth_user_role()`, `supabase/migrations/20260704000001_rls_policies.sql:29-53`),
a validly-signed JWT's `church_group_id`/`role` claims are read *before* the
DB fallback (`COALESCE`). All three characterization tests are **expected
from the migration source on inspection, but unverified** — Block E has not
executed in this environment (see Verification below), so treat the
following as the documented design, not a confirmed test result, until it's
run against a live Supabase instance:

- A Church-A member's JWT carrying a forged `church_group_id` claim
  pointing at Church B is treated as scoped to Church B — the claim wins
  over the DB row for that `clerk_id`.
- A Church-A member's JWT carrying a forged `appRole: "admin"` claim is
  treated as an admin for RLS purposes (e.g. can read the admin-only
  `audit_logs` table) — the claim wins over the DB `role` column.
- A JWT whose `church_group_id` claim is present but not a valid UUID
  **errors** (the `::uuid` cast throws before `COALESCE` can fall back to
  the DB value) rather than silently granting DB-derived scope — this is
  the safe failure mode.

**The entire path's security rests on only Clerk being able to mint these
claims in production.** If a future change ever lets JWT custom claims be
influenced by anything other than the trusted Clerk issuer (e.g. a
client-settable value, a misconfigured JWT template, or a second issuer),
this fast path becomes a direct tenant/role-escalation bypass. #79 should
treat this as the accurate picture of the current trust boundary, not
something to "fix" by itself.

(Block E, like blocks B–D, only ever runs against a live Supabase instance
and is skipped in a plain `bun run test` run, per spec Assumption 2 — it was
not executed in this environment; see Verification below.)

## Reviewer fix-up (`.pipeline/review.md` NEEDS WORK — addressed)

Test-only follow-up fixing all five findings from the first review pass; no
file under `app/`, `lib/`, `schemas/`, `middleware.ts`, or `supabase/` was
touched in this pass either.

1. **BLOCKING — the cross-tenant negative assertion was vacuous.**
   `VICTIM_CHURCH_GROUP_ID`/`VICTIM_USER_ID` (`tests/support/api-auth.ts`)
   are now real UUID-shaped constants, and `makeApiReq` unconditionally
   merges them into every request's query string — and, when a body object
   is already present, the body too — under
   `churchGroupId`/`church_group_id`/`userId`/`user_id` keys (explicit
   call-site values always win, so legitimate fields like `assignAttendee`'s
   `userId: R2` attendee target are untouched). No schema declares those
   keys and none use `.strict()`, so every real handler silently strips
   them; the negative "no victim id ever leaks" assertion in
   `auth-bypass-matrix.test.ts` case 4 is now a live, reachable check for
   every entry that touches Supabase, including 3 of the 6
   previously-flagged highest-risk entries (`getAuditLog`, `deleteMember`,
   `acceptInvitation`) that have no literal `.eq()` scope call. One entry —
   plain `GET /api/availability` — opts out of the `userId`/`user_id` probe
   keys via a new `excludeProbeKeys` option, because
   `getAvailabilityQuerySchema.user_id` is presence-sensitive (any value
   switches the handler into the cross-user admin-lookup branch), so
   injecting one would have silently changed which code path that entry
   exercises rather than testing it.
2. **AC-3 schema sweep gaps.** Added the missing `FIELD_CASES` entries in
   `input-validation-injection.test.ts`: `updateEventSchema.{name,location,
   notes}`, `updateServiceWeekSchema.{title,sermonTopic,sermonScripture,
   speakerName}`, `reorderSetlistSchema.songs[0].{keyOverride,notes}`, and
   `createSongSchema.tags[0]`. The last two needed new optional
   `buildInput`/`readValue` overrides on `FieldCase` since the field lives
   inside an array, not at the payload's top level.
3. **`createGuestInvitationSchema.email` field case tested the wrong thing.**
   Added `transform: (t) => t.toLowerCase()` (the schema lowercases) and a
   new `oversizedValue` override (`"a".repeat(250) + "@example.com"`) so the
   oversized-rejection case is actually driven by `.max(255)` instead of
   `.email()` rejecting a bare repeated-character string first.
4. **AC-2 coverage pin didn't pin what it claimed.** Added a new assertion
   in `phase1-token-bypass.test.ts` block A that parses every `create table`
   statement out of `supabase/migrations/*.sql` and asserts the resulting
   set is exactly `PHASE1_TABLES` — this is the actual "a future table can't
   silently skip the sweep" guarantee the file header claims. Also fixed the
   existing `cross-tenant-bypass.test.ts` reference check, which used a raw
   `toContain` substring match (e.g. `"songs"` is a substring of the
   unrelated `"setlist_songs"` literal) — replaced with a quoted-match regex.
5. **Block E summary overclaimed "confirmed."** Reworded SECURITY FINDINGS
   §4 above to say "expected from the migration source on inspection, but
   unverified" rather than "confirm," since Block E has still never executed
   in this environment (see Verification).

## Verification

Re-run after the reviewer fix-up above:

- `bun run lint` — pass, no errors (one pre-existing warning in the
  generated `coverage/` directory, unrelated to this change).
- `bun run typecheck` — pass, no errors.
- `bun run test` — pass: **112 suites, 2754 tests, 0 failures** (up from
  2535 — the new AC-3 FIELD_CASES account for the difference).
- `bun run test:rls` — pass: 1 suite (this issue's coverage-pin block A, now
  3 tests — the new migration cross-check added one) ran; 11 suites (294
  tests) skipped — `SUPABASE_TEST_URL` / `SUPABASE_TEST_ANON_KEY` /
  `SUPABASE_TEST_SERVICE_ROLE_KEY` / `SUPABASE_JWT_SECRET` are unset in this
  environment, so blocks B–E of `phase1-token-bypass.test.ts` (and all of
  `cross-tenant-bypass.test.ts`) did not execute here, per spec Assumption
  2. They should be run against a live local Supabase instance before this
  is treated as verified beyond the mechanical coverage pin.
- `git diff origin/main...HEAD --stat` — confirmed still confined to
  `tests/` and `.pipeline/`; no `app/`, `lib/`, `schemas/`, `middleware.ts`,
  or `supabase/` file touched.

## What the Tester should focus on

1. Re-run `bun run test` cold to confirm the full 2535-test count and zero
   failures independently.
2. Spot-check a few `ADMIN_ROUTE_REGISTRY` entries against their real
   handler source (especially the ones with `ownScopeAssertion: false` /
   `touchesSupabase: false` / `authFailureIsRedirect: true`) to confirm the
   documented reasoning is accurate, not a rationalization for a weakened
   test — this is the area most likely to hide a real gap if wrong.
3. If a local Supabase instance is available, run `bun run test:rls` with
   the required env vars set and confirm blocks B–E of
   `phase1-token-bypass.test.ts` pass for real (this run only executed the
   coverage pin, block A).
4. Confirm no file under `app/`, `lib/`, `schemas/`, `middleware.ts`, or
   `supabase/` was touched: `git diff origin/main...HEAD --stat`.
5. Run `bun run test` and independently verify the schema sweep
   (`input-validation-injection.test.ts`) actually enumerates every string
   field with a `.max()`/`.trim()` in `schemas/*.ts` — this file was hand-
   built by reading each schema, not generated, so it's the one most prone
   to a silently-missing field.
