# Review — Issue #80: Full auth-bypass & RLS-bypass test suite

VERDICT: NEEDS WORK

Scope is clean (tests + `.pipeline/` only), lint/typecheck/test were re-run here
and match the reported numbers exactly (`112 suites / 2535 tests / 0 failures`,
eslint clean, tsc clean). The 401/403/expired-token sweep, the rate-limit tier
matrix, and the RLS token-bypass file are real, useful coverage. But the single
assertion that AC-1's cross-tenant claim rests on is provably vacuous, and the
AC-3 sweep does not meet the spec's own "every string field of every exported
schema" requirement (the tester already found part of this). Both must be fixed
before this ships as a *security* suite — it currently advertises more assurance
than it delivers.

---

## 1. BLOCKING — the cross-tenant "victim id never leaks" assertion can never fail

`tests/unit/app/api/auth-bypass-matrix.test.ts:269-270`

```ts
expect(recording.seenValues).not.toContain(VICTIM_CHURCH_GROUP_ID); // "group-victim-2"
expect(recording.seenValues).not.toContain(VICTIM_USER_ID);         // "user-victim-2"
```

`recording.seenValues` only ever contains strings that the handler passed to the
Supabase double. Those strings come from (a) the request built by
`entry.invoke()` and (b) the `AuthContext` from `makeLookup("admin")`. Grepping
the whole tree, `"group-victim-2"` / `"user-victim-2"` appear in exactly three
places: their definition in `tests/support/api-auth.ts:24-25` and these two
assertions. **No registry entry ever puts them into a request**, and
`makeLookup` uses `DEFAULT_*`. The registry even documents the tautology as if
it were a design decision (`tests/support/admin-route-registry.ts:120-124`:
"these only need to be syntactically valid and distinct from
VICTIM_CHURCH_GROUP_ID/VICTIM_USER_ID"). A handler could pass a fully
caller-controlled tenant id straight into `.eq("church_group_id", …)` and this
test would still be green.

This matters because it is exactly the assertion the code comment
(`auth-bypass-matrix.test.ts:244-248, 267-268`) and `.pipeline/changes.md` call
"the load-bearing assertion for cross-tenant admin".

What survives: the *positive* check (`seenValues` contains
`DEFAULT_CHURCH_GROUP_ID` / `DEFAULT_USER_ID`) is real and does catch a handler
that scopes by a request-supplied id instead of `ctx`. It runs for 55 of 61
entries. For the other 6 (`ownScopeAssertion: false` / `touchesSupabase: false`
— `adminOnlyExample`, `google-calendar/connect`, `getAuditLog`, `deleteMember`,
`acceptInvitation`, `GET /api/availability?user_id=`) case 4 degenerates to
`expect(recording.touched).toBe(true)` plus the two dead assertions, i.e. it
asserts nothing about tenant scope at all — and those are the highest-risk
routes in the set.

Fix (either approach, in `tests/support/admin-route-registry.ts` +
`tests/support/recording-supabase.ts` + `auth-bypass-matrix.test.ts`):

- Make the victim ids actually reachable: redefine `VICTIM_CHURCH_GROUP_ID` /
  `VICTIM_USER_ID` as UUID-shaped constants and have `invoke()` inject them into
  the caller-controlled surfaces a confused-deputy bug would read —
  `churchGroupId` / `church_group_id` / `userId` / `user_id` keys in the body and
  query string. Zod strips unknown keys by default, so the assertion then proves
  the strip actually happens end-to-end; where a schema is `.strict()` and would
  400, drop that injection for that entry and say so in a comment.
- Or (stronger, and it also fixes the 6 exception entries): have
  `makeRecordingSupabase` record `(method, args)` tuples, and assert that every
  `.eq("church_group_id", x)` / `.eq("user_id", x)` and every RPC argument whose
  name implies tenant/user identity equals the `ctx` value — never a
  request-derived one.

Also update the now-incorrect comments at `auth-bypass-matrix.test.ts:267-268`
("The negative assertion always applies") and
`admin-route-registry.ts:120-124`, and the claim in `.pipeline/changes.md`
("the negative 'no victim id ever leaks' assertion always still runs for every
entry" — it runs, but it cannot fail).

## 2. AC-3 schema sweep does not cover every exported schema (spec §5 Part A)

Confirmed independently against `schemas/*.ts` (the tester found these too;
they are not fixed):

- `schemas/events.ts` `updateEventSchema` — `name`, `location`, `notes`: absent
  from `FIELD_CASES`.
- `schemas/service-weeks.ts` `updateServiceWeekSchema` — `title`,
  `sermonTopic`, `sermonScripture`, `speakerName`: absent.
- `schemas/setlists.ts` `reorderSetlistSchema.songs[]` — `keyOverride` and
  `notes` (`.trim().max(1000)`): zero adversarial coverage anywhere in the repo.
- `schemas/songs.ts` `createSongSchema.tags` (`z.array(z.string().trim().min(1)
  .max(50))`): absent.

Add these to `FIELD_CASES` in
`tests/unit/schemas/input-validation-injection.test.ts` (array-item fields need
a small wrapper that varies one element), or amend the spec/AC. Do not leave
`.pipeline/changes.md` claiming "every genuinely free-text string field of every
exported Zod object schema".

## 3. `createGuestInvitationSchema.email` field case encodes a wrong expectation

`tests/unit/schemas/input-validation-injection.test.ts:258-265` declares
`trims: true` with no `transform`, but the schema is
`z.string().trim().toLowerCase().email().max(255)`
(`schemas/invitations.ts:70`). It only passes because every payload in
`ALL_PAYLOADS` fails `.email()` and never reaches the success branch — the same
is true of the oversized case (`"a".repeat(256)` is rejected as a non-email, not
for length). Add `transform: (t) => t.toLowerCase()` and build the oversized
value as a real over-length email (e.g. `"a".repeat(250) + "@example.com"`) so
the assertion is about the `.max(255)` it claims to test.

## 4. The AC-2 "coverage pin" does not pin what it claims

`tests/integration/rls/tables/phase1-token-bypass.test.ts:46-59` asserts
`PHASE1_TABLES.length === 19` and that each of those 19 names appears somewhere
in `cross-tenant-bypass.test.ts`. That catches "someone added a table to
`PHASE1_TABLES` without covering it", but **not** the case the file header and
`.pipeline/changes.md` claim it guards ("a future table added to the schema
cannot silently skip the cross-tenant sweep") — a new `create table` in
`supabase/migrations/` with no edit to `PHASE1_TABLES` leaves the pin green.
Derive the list from (or cross-check it against) the `create table` statements
in `supabase/migrations/*.sql`, which is what makes it mechanical; otherwise
downgrade the claim in the file header and in `changes.md`. Secondary nit:
`expect(source).toContain(table)` is a raw substring match — `"users"`,
`"songs"`, `"events"`, `"instruments"`, `"notifications"` all match as
substrings of unrelated identifiers/comments; match on a quoted-table form
instead.

## 5. `changes.md` states Block E results as confirmed, but Block E never ran

`.pipeline/changes.md` SECURITY FINDINGS §4: "All three characterization tests
confirm the documented behavior, not a bug", with a bullet list of outcomes —
then discloses at the bottom of the same section that Block E was not executed
in this environment. The findings are consistent with
`supabase/migrations/20260704000001_rls_policies.sql:29-53` on inspection, and
the seed data they depend on does exist (`tests/integration/rls/setup.ts`:
`songs` B1, `audit_logs` B/A), so I expect them to pass — but the write-up must
say "expected from the migration source, unverified" rather than "confirm",
because #79 is meant to inherit this as fact. Reword §4.

---

## Things I checked that are fine (no action)

- Registry completeness: 61 entries covering all 60 exported `UserLookup`
  handlers under `app/api/**/handler.ts` (`getAvailability` twice, per the
  conditional role gate) — enumerated independently; nothing omitted. The 5
  deliberately-excluded routes all have their own explicit tests.
- The `scope: "user"` correction for `GET /api/events/:id/ics` (spec said
  "group") is right — `exportEventIcs` only ever reads `ctx.userId`
  (`app/api/events/[id]/ics/handler.ts`). Good catch by the coder, documented.
- `touchesSupabase: false` / `authFailureIsRedirect: true` / the four
  `ownScopeAssertion: false` entries were re-checked against handler source
  (`getAuditLog` has no `.eq("church_group_id", …)`; `getAvailability`'s
  `user_id` branch replaces `ctx.userId` wholesale). Accurate, not rationalized
  — but see item 1 for what that leaves untested.
- Rate-limit matrix genuinely exercises `resolveTier` (all six tier limits are
  distinct, so a mis-mapped tier would fail), asserts `Retry-After` bounds from
  the policy, and includes the required different-identifier failure case.
  Mocking `createRouteMatcher` to always-true is safe: rate limiting runs before
  `isPublicRoute` in `middleware.ts`.
- `mintJwt` stays byte-identical when the new options are absent; `iat`
  back-dating for negative `expiresInSeconds` is handled.
- No production file touched; no network/exec/env exfiltration in the diff.

## Residual (not blocking, carry forward for a human)

RLS blocks B–E have still never executed anywhere — no Supabase env vars and no
Docker in this worktree. Run `bun run test:rls` against a live local instance
before treating AC-2's token-bypass claims (and Block E's trust-boundary
findings) as verified.
