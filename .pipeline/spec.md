# Spec — Issue #80: Full auth-bypass & RLS-bypass test suite (all Phase 1 tables)

## OPEN QUESTIONS

None blocking. Three planner decisions are recorded below as **Assumptions**;
they are resolved, not open.

**Assumptions**

1. **"Job-submission-style endpoints" (AC-4).** Phase 1 has no audio-pipeline /
   job-submission endpoint (the issue says so itself under Out of Scope). The
   closest real analogues in `lib/api/rate-limit.ts` are the `invite` tier
   (`POST /api/invitations`, a roster-sized burst submission) and the `write`
   tier (generic mutating submissions). AC-4 is implemented against the
   `auth`, `sms`, `invite`, and `write` tiers.
2. **RLS integration tests skip without env vars.** `tests/integration/rls/*`
   already self-skips when `SUPABASE_TEST_URL` / `SUPABASE_JWT_SECRET` are
   unset (see `tests/integration/rls/setup.ts`). New integration tests follow
   that same precedent — they will skip in a plain `bun run test` run. Do not
   change that.
3. **This issue adds tests only.** Do NOT modify anything under `app/`, `lib/`,
   `schemas/`, `middleware.ts`, or `supabase/`. If a test written to this spec
   goes red, that is a real finding: leave it red and write it up under a
   `## SECURITY FINDINGS` heading in `.pipeline/changes.md`. Never weaken an
   assertion or patch production code to make it green.

---

## Current state (verified — do not re-derive)

- **AC-2 is already largely satisfied.** `tests/integration/rls/tables/cross-tenant-bypass.test.ts`
  already sweeps a Church A persona (memberA, plus adminA on role-gated tables)
  against Church B rows across SELECT/INSERT/UPDATE/DELETE for all **19** Phase 1
  tables. **No table has been added since** — every `create table` in
  `supabase/migrations/` predates it; migrations after `20260704000001` add only
  columns and RPCs. The remaining AC-2 work is (a) a mechanical *coverage pin* so
  a future table cannot be added without coverage, and (b) the token-level bypass
  vectors that suite does not cover (anon, expired, wrong-signature JWTs).
- **AC-1 is only partially satisfied.** `tests/unit/app/api/auth-matrix.test.ts`
  (#32) covers 5 Sprint-1 handlers out of ~60 exported handlers, and only the
  unauth/member/admin cases — never "expired token" or "admin of another church
  group".
- **AC-3 is only partially satisfied.** `tests/unit/app/api/songs-search-injection-tester-supplement.test.ts`
  covers PostgREST-filter breakout for `GET /api/songs?q=` only.
- **AC-4 is only partially satisfied.** `tests/unit/middleware.test.ts` covers
  the `sms` tier via one deny route; no coverage of `auth`, `invite`, or `write`.

Shared harness that already exists and must be reused, not reinvented:
`tests/support/api-auth.ts`, `tests/integration/rls/{jwt,client,helpers,setup}.ts`.

---

## Files

| Action | Path |
| ------ | ---- |
| MODIFY | `tests/support/api-auth.ts` |
| CREATE | `tests/support/recording-supabase.ts` |
| CREATE | `tests/support/admin-route-registry.ts` |
| CREATE | `tests/unit/app/api/auth-bypass-matrix.test.ts` |
| CREATE | `tests/unit/schemas/input-validation-injection.test.ts` |
| CREATE | `tests/unit/middleware-rate-limit-matrix.test.ts` |
| MODIFY | `tests/integration/rls/jwt.ts` |
| MODIFY | `tests/integration/rls/client.ts` |
| CREATE | `tests/integration/rls/tables/phase1-token-bypass.test.ts` |

---

## 1. `tests/support/api-auth.ts` (MODIFY)

Keep every existing export unchanged. Add:

```ts
export const DEFAULT_USER_ID = "user-1";
export const DEFAULT_CHURCH_GROUP_ID = "group-1";

/** The "victim" tenant. Must never appear in any handler's DB interaction
 *  when the caller's AuthContext belongs to DEFAULT_CHURCH_GROUP_ID. */
export const VICTIM_CHURCH_GROUP_ID = "group-victim-2";
export const VICTIM_USER_ID = "user-victim-2";

/** Models an expired/absent Supabase template JWT: the Clerk session resolves
 *  but the DB-backed lookup yields no AuthContext -> requireAuth throws 401. */
export function makeNullLookup(): UserLookup;

/** NextRequest double covering the three things handlers read. */
export function makeApiReq(opts?: {
  query?: Record<string, string>;
  body?: unknown;
  headers?: Record<string, string>;
}): NextRequest;
```

`makeApiReq` must return an object with `nextUrl: { searchParams: URLSearchParams,
pathname: "/api/test" }`, `json: jest.fn().mockResolvedValue(opts?.body)`,
`headers: new Headers(opts?.headers ?? {})`, and `method: "GET"`. When `body` is
omitted, `json()` resolves `undefined` (the existing `makeJsonReq(undefined)`
malformed-body convention).

`makeLookup` already accepts `overrides?: Partial<AuthContext>` — use that for
the foreign-group persona; do not add a second lookup factory.

The two constants `DEFAULT_USER_ID` / `DEFAULT_CHURCH_GROUP_ID` are currently
module-private; promote them to exports and keep `makeLookup` using them, so
registry assertions and the harness cannot drift apart.

---

## 2. `tests/support/recording-supabase.ts` (CREATE)

A generic Supabase client double that records every interaction, so one
data-driven sweep can cover ~60 handlers with different query-chain shapes.

```ts
export type RecordingSupabase = {
  /** Pass this as the getSupabaseClient mock's return value. */
  client: unknown;
  /** Table names passed to .from(). */
  tables: string[];
  /** Function names passed to .rpc(). */
  rpcs: string[];
  /** Every string that reached the client as (or inside) an argument. */
  seenValues: string[];
  /** True once .from() or .rpc() has been called at least once. */
  touched: boolean;
};

export function makeRecordingSupabase(result?: {
  data?: unknown;
  error?: unknown;
  count?: number | null;
}): RecordingSupabase;
```

Implementation requirements:

- `client` is a `Proxy`. Any property access that is not a reserved name returns
  a recording function which (a) pushes every argument's strings into
  `seenValues`, and (b) returns the same proxy so chains of arbitrary depth work.
- Argument flattening: for a `string` push it; for an array push each string
  element; for a plain object push each string **value** (keys are ignored);
  recurse at most 2 levels deep; ignore everything else.
- The proxy is thenable: `then` must resolve to `result`, defaulting to
  `{ data: [], error: null, count: 0 }`. This is what makes
  `await supabase.from(t).select(...).eq(...)` destructure correctly.
- `from(table)` additionally pushes `table` to `tables` and sets `touched = true`.
- `rpc(name, args)` additionally pushes `name` to `rpcs`, sets `touched = true`,
  and flattens `args` into `seenValues`.
- Reserved names that must NOT be turned into recorders (they are probed by
  `await`, Jest, and `expect`): `then`, `catch`, `finally`, `constructor`,
  `toJSON`, `nodeType`, `$$typeof`, `asymmetricMatch`, `Symbol.toStringTag`,
  `Symbol.iterator`, `Symbol.asyncIterator`, and any other `symbol` key.
  Return `undefined` for those (except `then`, handled above).
- `touched` must be readable after the call — expose it via a getter on the
  returned object, not a captured-by-value boolean.

Because it is itself non-obvious infrastructure, add a small self-test
`describe` block for `makeRecordingSupabase` at the top of
`tests/unit/app/api/auth-bypass-matrix.test.ts`: a chained
`await client.from("songs").select("id").eq("church_group_id", "g1")` records
`tables === ["songs"]`, `seenValues` containing `"g1"`, and destructures to
`{ data: [], error: null }`.

---

## 3. `tests/support/admin-route-registry.ts` (CREATE)

The single source of truth for the sweep. Non-test module under `tests/`
(precedent: `tests/support/api-auth.ts`).

```ts
import type { UserLookup } from "@/lib/api/auth";
import type { UserRole } from "@/types/domain";

export type RouteEntry = {
  /** Stable label used in test names, e.g. "PATCH /api/church-group/members/:id/role". */
  name: string;
  /** Roles that pass requireRole. null = authenticated, no role gate. */
  allowedRoles: UserRole[] | null;
  /** What the handler must scope its DB access by. */
  scope: "group" | "user";
  /** Invokes the handler with the given lookup. */
  invoke: (lookup: UserLookup) => Promise<Response>;
  /** Optional result override handed to makeRecordingSupabase(). */
  result?: { data?: unknown; error?: unknown; count?: number | null };
};

export const ADMIN_ROUTE_REGISTRY: RouteEntry[];
```

`invoke` builds its own request via `makeApiReq(...)` and passes a valid-shaped
body/params so the handler gets past its own Zod validation. Path params and
body ids must address **the victim tenant** — use fixed UUID constants
(e.g. victim service week `"22222222-2222-2222-2222-222222222222"`).

### Registry contents (complete — every exported handler)

`allowedRoles` below is authoritative; it is the `requireRole(...)` argument in
each handler. `A = admin`, `L = set_leader`, `M = member`, `G = guest`.

| Module | Export | Extra params | allowedRoles | scope |
| --- | --- | --- | --- | --- |
| `app/api/_examples/admin-only/handler` | `adminOnlyExample` | — | A | group |
| `app/api/availability/handler` | `getAvailability` | — | null | user |
| `app/api/availability/handler` | `getAvailability` with `?user_id=<victim>` | — | A,L | user |
| `app/api/availability/handler` | `setAvailability` | — | null | user |
| `app/api/availability/handler` | `deleteAvailability` | `date` | null | user |
| `app/api/availability/team/handler` | `getTeamAvailability` | — | A,L | group |
| `app/api/church-group/audit-log/handler` | `getAuditLog` | — | A | group |
| `app/api/church-group/members/handler` | `getChurchGroupMembers` | — | A,L,M | group |
| `app/api/church-group/members/[id]/handler` | `deleteMember` | `targetUserId` | A | group |
| `app/api/church-group/members/[id]/role/handler` | `patchMemberRole` | `targetUserId` | A | group |
| `app/api/conflicts/handler` | `getOpenConflicts` | — | A,L | group |
| `app/api/conflicts/handler` | `resolveConflict` | `id` | A,L | group |
| `app/api/events/handler` | `listEvents` | — | null | group |
| `app/api/events/handler` | `createEvent` | — | A,L | group |
| `app/api/events/[id]/handler` | `updateEvent` | `id` | A,L | group |
| `app/api/events/[id]/handler` | `deleteEvent` | `id` | A,L | group |
| `app/api/events/[id]/attendees/handler` | `assignAttendee` | `eventId` | A,L | group |
| `app/api/events/[id]/attendees/handler` | `removeAttendee` | `eventId`,`userId` | A,L | group |
| `app/api/events/[id]/ics/handler` | `exportEventIcs` | `id` | null | group |
| `app/api/events/ics/handler` | `exportEventsIcs` | — | null | user |
| `app/api/google-calendar/callback/handler` | `callback` | — | null | user |
| `app/api/google-calendar/connect/handler` | `connect` | — | null | user |
| `app/api/google-calendar/disconnect/handler` | `disconnect` | — | null | user |
| `app/api/instruments/handler` | `listInstruments` | — | null | group |
| `app/api/instruments/handler` | `addInstrument` | — | A | group |
| `app/api/instruments/handler` | `submitCustomInstrument` | — | null | group |
| `app/api/instruments/handler` | `promoteInstrument` | `id` | A | group |
| `app/api/instruments/handler` | `deleteInstrument` | `id` | A | group |
| `app/api/invitations/handler` | `listInvitations` | — | A,L | group |
| `app/api/invitations/handler` | `createInvitation` | — | A,L | group |
| `app/api/invitations/handler` | `createGuestInvitation` | — | A,L | group |
| `app/api/invitations/handler` | `withdrawInvitation` | `id` | A,L | group |
| `app/api/invitations/handler` | `denyInvitation` | `id` | null | group |
| `app/api/invitations/handler` | `acceptInvitation` | `id` | null | group |
| `app/api/notifications/preferences/handler` | `getNotificationPreferences` | — | null | user |
| `app/api/notifications/preferences/handler` | `updateNotificationPreferences` | — | null | user |
| `app/api/profile/handler` | `getProfile` | — | null | user |
| `app/api/profile/handler` | `updateProfile` | — | null | user |
| `app/api/service-weeks/handler` | `listServiceWeeks` | — | null | group |
| `app/api/service-weeks/handler` | `createServiceWeek` | — | A,L | group |
| `app/api/service-weeks/[id]/handler` | `getServiceWeek` | `id` | null | group |
| `app/api/service-weeks/[id]/handler` | `updateServiceWeek` | `id` | A,L | group |
| `app/api/service-weeks/[id]/handler` | `deleteServiceWeek` | `id` | A | group |
| `app/api/service-weeks/[id]/handler` | `cancelServiceWeek` | `id` | A | group |
| `app/api/service-weeks/[id]/handler` | `reactivateServiceWeek` | `id` | A | group |
| `app/api/service-weeks/[id]/member-view/handler` | `getMemberWeekView` | `id` | A,L,M,G | group |
| `app/api/service-weeks/[id]/setlist/handler` | `getSetlist` | `id` | null | group |
| `app/api/service-weeks/[id]/setlist/handler` | `createSetlist` | `id` | A,L | group |
| `app/api/service-weeks/overview/handler` | `getServiceWeeksOverview` | — | A,L | group |
| `app/api/setlists/[id]/handler` | `getSetlistWithSongs` | `id` | A,L | group |
| `app/api/setlists/[id]/handler` | `reorderSetlist` | `id` | A,L | group |
| `app/api/setlists/[id]/handler` | `addSetlistSong` | `id` | A,L | group |
| `app/api/setlists/[id]/handler` | `publishSetlist` | `id` | A,L | group |
| `app/api/setlists/[id]/handler` | `unlockSetlist` | `id` | A,L | group |
| `app/api/setlists/[id]/handler` | `removeSetlistSong` | `id`,`songId` | A,L | group |
| `app/api/songs/handler` | `listSongs` | — | A,L,M | group |
| `app/api/songs/handler` | `createSong` | — | A,L | group |
| `app/api/songs/[id]/documents/handler` | `createUploadUrl` | `songId` | A,L | group |
| `app/api/songs/[id]/documents/handler` | `registerDocument` | `songId` | A,L | group |
| `app/api/songs/[id]/documents/handler` | `listDocuments` | `songId` | A,L,M | group |
| `app/api/songs/[id]/documents/handler` | `deleteDocument` | `songId`,`docId` | A,L | group |

Exact parameter order for the multi-arg handlers (verified against source):
`removeAttendee(req, eventId, userId, lookup?)`,
`removeSetlistSong(req, setlistId, songId, lookup?)`,
`deleteDocument(req, songId, docId, lookup?)`,
`deleteAvailability(req, date, lookup?)`.

**Deliberately excluded from the registry** (each gets its own explicitly-named
test in the same file — see §4, "Non-registry routes"):

- `getInvitationByToken(token)` — public token route, takes no `lookup`.
- `claimGuestInvitation(req)` — session-only, takes no `lookup`.
- `app/api/church-group/route.ts` `PUT`, `app/api/church-group/join/route.ts`
  `POST` — deliberately bypass `requireAuth` (caller has no `users` row yet);
  they gate on `auth()` + Supabase-template JWT directly.
- `app/api/cron/invitation-reminders/route.ts` `GET` — `CRON_SECRET` bearer, not
  a Clerk session.
- `app/api/webhooks/**` and the `notImplemented` stubs
  (`app/api/notifications/{route,[id]/read,mark-all-read,unread-count}`,
  `GET /api/church-group`) — no auth surface to bypass.

---

## 4. `tests/unit/app/api/auth-bypass-matrix.test.ts` (CREATE) — AC-1

Follow the file layout of `tests/unit/app/api/auth-matrix.test.ts`: `jest.mock`
calls at the very top, then imports.

```ts
jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn(), currentUser: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({
  getSupabaseClient: jest.fn(),
  getAnonSupabaseClient: jest.fn(),
}));
```

Also `jest.mock` every side-effecting external client the registry's handler
modules pull in at import time, so importing ~19 handler modules in one file
cannot fail on missing env: `@/lib/r2/client`, `@/lib/pingram/client`,
`@/lib/resend/client`, `@/lib/upstash/qstash`, `@/lib/upstash/redis`,
`@/lib/spotify/client`, `@/lib/google-calendar/oauth`,
`@/lib/google-calendar/sync`, `@/lib/google-calendar/token-crypto`. If a module
still needs an env var at import time, set it in the test file (do not drop the
registry entry).

`describe.each(ADMIN_ROUTE_REGISTRY)` with these cases per entry:

1. **No token** — `mockClerkAnonymous()`; invoke with a `jest.fn()` lookup.
   Assert: `status === 401`, `body.code === "UNAUTHENTICATED"`, the lookup was
   never called, and `getSupabaseClient` was never called.
2. **Expired token** — two variants:
   - `mockClerkAuthed()` + `makeNullLookup()` (Clerk session resolves, the
     Supabase-template JWT is gone/expired so the DB lookup yields nothing).
   - `mockClerkAuthed(null)` + `makeLookup("admin")` (session present,
     `getToken` resolves `null`).
   Both assert `status === 401` and `body.code === "UNAUTHENTICATED"`. The
   first also asserts `getSupabaseClient` was never called.
3. **Valid token, insufficient role** — skip when `allowedRoles` is `null`.
   For each role in `["member", "guest"]` that is NOT in `allowedRoles`:
   `mockClerkAuthed()` + `makeLookup(role)`. Assert `status === 403`,
   `body.code === "FORBIDDEN"`, and `getSupabaseClient` was never called.
4. **Valid admin token from a different church group** — `mockClerkAuthed()` +
   `makeLookup("admin")` (which yields `DEFAULT_USER_ID` /
   `DEFAULT_CHURCH_GROUP_ID`), with `getSupabaseClient` returning
   `makeRecordingSupabase(entry.result).client`. The request built by `invoke`
   addresses **the victim tenant's** resources. Assert:
   - `recording.touched === true` — the handler actually reached the DB layer
     (otherwise the assertion below is vacuous).
   - `recording.seenValues` does **not** contain `VICTIM_CHURCH_GROUP_ID` and
     does **not** contain `VICTIM_USER_ID`.
   - `recording.seenValues` **does** contain `DEFAULT_CHURCH_GROUP_ID` when
     `scope === "group"`, or `DEFAULT_USER_ID` when `scope === "user"`.

   This is the load-bearing assertion for cross-tenant admin: the app layer
   cannot 403 a foreign admin (they are a legitimate admin *of their own*
   group), so the security property under test is that the handler derives its
   tenant scope solely from the server-side `AuthContext` and never from
   caller-supplied ids. Put exactly that reasoning in a comment above the case.

`beforeEach` must `mockReset()` both mocks, mirroring `auth-matrix.test.ts`.

**Non-registry routes** — same file, separate `describe` blocks:

- `claimGuestInvitation`: `mockClerkAnonymous()` -> 401 `UNAUTHENTICATED`;
  `mockClerkAuthed(null)` -> 401 `UNAUTHENTICATED`.
- `PUT /api/church-group` and `POST /api/church-group/join` (import the route
  modules directly): `mockClerkAnonymous()` -> 401 `UNAUTHENTICATED`;
  `mockClerkAuthed(null)` -> 401 `UNAUTHENTICATED`. Mock `currentUser` to
  resolve `null`.
- `GET /api/cron/invitation-reminders`: no `authorization` header -> 401;
  `Bearer wrong` -> 401; `CRON_SECRET` unset -> 500. Set/restore
  `process.env.CRON_SECRET` around these.

---

## 5. `tests/unit/schemas/input-validation-injection.test.ts` (CREATE) — AC-3

Directory precedent: `tests/unit/schemas/events.test.ts`.

Define the payload corpus once. **Never paste a raw non-printable, bidi, or
astral character into the source file** — a literal NUL byte makes the file
binary to git and grep. Build them with `String.fromCharCode` /
`String.fromCodePoint`:

```ts
const NUL  = String.fromCharCode(0x0000);      // null byte
const RTL  = String.fromCharCode(0x202e);      // right-to-left override
const BOM  = String.fromCharCode(0xfeff);      // byte-order mark
const IDSP = String.fromCharCode(0x3000);      // ideographic space
const LONE = String.fromCharCode(0xd800);      // lone surrogate
const ACUTE = String.fromCharCode(0x0301);     // combining acute accent
const ASTRAL = String.fromCodePoint(0x1d518);  // astral-plane letter

const SQLI = [
  "'; DROP TABLE users; --",
  "' OR '1'='1",
  "1; SELECT pg_sleep(10)--",
  '" OR ""="',
  "admin'--",
];

const XSS = [
  "<script>alert(1)</script>",
  "javascript:alert(1)",
  "<img src=x onerror=alert(1)>",
  '"><svg/onload=alert(1)>',
  "&lt;script&gt;alert(1)&lt;/script&gt;",
];

// Null bytes: leading, embedded, trailing.
const NULL_BYTES = [NUL + "lead", "ok" + NUL + "injected", "trail" + NUL];

const UNICODE = [
  RTL + "gnp.exe",
  ASTRAL + ASTRAL,
  "e" + ACUTE,   // combining form
  "é",      // precomposed form: same glyph, different bytes
  BOM + "bom",
  IDSP,
  LONE,
];

const ALL_PAYLOADS = [...SQLI, ...XSS, ...NULL_BYTES, ...UNICODE];
```

**Part A — schema sweep.** Build a table of `{ label, schema, field, max, trims,
baseValid }` for every string field of every exported Zod object schema in
`schemas/*.ts`. Read each schema file and enumerate the fields and their `.max(n)`
values — do not guess. `baseValid` is a minimal valid object for that schema so
only the field under test varies.

For each `(field, payload)` in `ALL_PAYLOADS` assert **exactly one** of:

- `safeParse` fails, **or**
- `safeParse` succeeds and the parsed field equals `payload.trim()` when the
  field declares `.trim()`, else equals `payload` — i.e. the value survives
  byte-for-byte and is therefore handed to a parameterized query, never
  partially "sanitized" into a different-but-still-dangerous string.

Express that as a single assertion helper (`expectRejectedOrVerbatim`) so the
failure message names the schema, field, and payload.

Assert failure (never success) for:

- **Oversized**: `"a".repeat(max + 1)` for every field with a `.max(n)`.
- **Empty / whitespace-only** on every field with `.min(1)` after `.trim()`.

Also assert the enum-typed fields (e.g. `vocalCapability` in `schemas/profile.ts`,
`role` in `schemas/role.ts`, and `default_key` membership via `isValidSongKey`
in `schemas/songs.ts`) reject every payload in `ALL_PAYLOADS`.

**Part B — filter-escaping.** Direct unit tests on `escapePostgrestFilterValue`
from `@/lib/api/postgrest`, over `ALL_PAYLOADS` plus the reserved characters
`,` `(` `)` `.` `"` `\`:

- Round-trip: reversing the escaping (`\\` then `\"`) recovers the input exactly.
- The escaped result contains no `"` that is not preceded by a `\`.

`tests/unit/lib/api/postgrest.test.ts` already exists — extend the corpus here;
do not duplicate its existing cases.

**Part C — handler-level escaping** (the only two places user input is
interpolated into a PostgREST filter string):

- `GET /api/songs?q=` — already covered by
  `tests/unit/app/api/songs-search-injection-tester-supplement.test.ts`. Do not
  duplicate; reference it in a comment.
- `POST /api/invitations/guest` (`createGuestInvitation`) — the
  `.ilike("email", ...)` lookup uses a module-private `escapeLikePattern`
  (`app/api/invitations/handler.ts:285`). Test it behaviorally: drive the
  handler with an email containing `%`, `_`, and `\`, capture the argument
  passed to `.ilike`, and assert each of those three characters is
  backslash-escaped in it. Mirror the mock style of
  `songs-search-injection-tester-supplement.test.ts`.

---

## 6. `tests/unit/middleware-rate-limit-matrix.test.ts` (CREATE) — AC-4

Copy the mocking/harness preamble verbatim from `tests/unit/middleware.test.ts`
(`jest.mock("@clerk/nextjs/server", ...)`, the `MiddlewareHandler` recast,
`makeReq`, `makeAuthFn`, `beforeEach(resetRateLimitStore)`).

For each tier/route pair below, assert: the first `RATE_LIMIT_POLICIES[tier].limit`
requests are not 429; the very next one is `429` with
`body.code === "RATE_LIMITED"` and a `Retry-After` header that is an integer
`>= 1` and `<= RATE_LIMIT_POLICIES[tier].windowMs / 1000`.

| Tier | Route under test |
| --- | --- |
| `auth` | `POST /api/church-group/join` |
| `auth` | `GET /api/invitations/respond/<token>` |
| `auth` | `POST /api/invitations/<uuid>/accept` |
| `sms` | `POST /api/invitations/<uuid>/deny` |
| `sms` | `POST /api/setlists/<uuid>/publish` |
| `sms` | `GET /api/cron/invitation-reminders` |
| `invite` | `POST /api/invitations` |
| `write` | `PUT /api/profile` |

Plus these isolation cases:

- Tiers are bucketed independently: exhausting `sms` for one identifier leaves
  that same identifier's `auth` budget intact.
- Two different `x-forwarded-for` first hops get independent budgets.
- A signed-in caller (`userId` non-null) and an anonymous caller from the same
  IP get independent budgets.
- **Failure case (required by the pipeline contract):** exhausting a tier for
  one identifier must NOT 429 a different identifier — assert the second
  identifier's very next request is not 429.

Use a distinct `x-forwarded-for` per test so tests cannot cross-contaminate even
if `resetRateLimitStore` ordering changes. Derive every loop bound from
`RATE_LIMIT_POLICIES[tier].limit`, never a hardcoded number.

---

## 7. `tests/integration/rls/jwt.ts` (MODIFY)

Keep `mintJwt`'s existing behavior byte-identical when the new options are
absent. Extend `TestClaims`:

```ts
export interface TestClaims {
  clerkId: string;
  churchGroupId?: string;
  appRole?: AppRole;
  /** Seconds from now until exp. Default 3600. Negative -> already expired. */
  expiresInSeconds?: number;
  /** Sign with this secret instead of SUPABASE_JWT_SECRET (forged-signature tests). */
  signingSecret?: string;
}
```

`exp` becomes `Math.floor(Date.now() / 1000) + (claims.expiresInSeconds ?? 3600)`.
When `expiresInSeconds` is negative, also set `iat` to that same past second so
the token is not "issued in the future". `signingSecret` replaces the
`SUPABASE_JWT_SECRET` lookup; the "secret missing" throw still applies when
neither is available.

## 8. `tests/integration/rls/client.ts` (MODIFY)

Add alongside the existing exports (do not change `getUserClient`):

```ts
/** Anon-key client with NO Authorization header — the unauthenticated caller. */
export function getAnonClient(): SupabaseClient<any>;
```

## 9. `tests/integration/rls/tables/phase1-token-bypass.test.ts` (CREATE) — AC-2

Same skip-gate and `beforeAll` seeding preamble as
`tests/integration/rls/tables/cross-tenant-bypass.test.ts` (copy it).

Define the canonical table list at the top of the file:

```ts
export const PHASE1_TABLES = [
  "church_groups", "users", "member_profiles", "instruments",
  "member_instruments", "service_weeks", "setlists", "setlist_songs",
  "events", "invitations", "event_attendees", "conflicts", "songs",
  "song_documents", "availability", "notification_preferences",
  "notifications", "google_calendar_tokens", "audit_logs",
] as const; // 19 tables — matches supabase/migrations/20260704000001_rls_policies.sql
```

Blocks:

**A. Coverage pin.** Put this in a plain `describe` that runs even when the RLS
env vars are absent. Read
`tests/integration/rls/tables/cross-tenant-bypass.test.ts` from disk with
`fs.readFileSync` (resolve via
`path.resolve(__dirname, "./cross-tenant-bypass.test.ts")`) and assert every
name in `PHASE1_TABLES` appears in it. Also assert
`PHASE1_TABLES.length === 19`. This is the mechanical guarantee that AC-2's
"every table" claim stays true when a table is added later.

**B. Unauthenticated caller (`getAnonClient()`), per table** — `SELECT id` must
return zero rows or an error. Use `assertSelectBlocked` from `../helpers`.

**C. Expired Church A JWT, per table** — `getUserClient({ clerkId: IDS.clerkIds.memberA,
expiresInSeconds: -60 })`; `SELECT id` must return zero rows or an error.

**D. Wrong-signature JWT, per table** — `getUserClient({ clerkId: IDS.clerkIds.adminA,
signingSecret: "not-the-real-secret-not-the-real-secret" })`; `SELECT id` must
return zero rows or an error.

Drive B/C/D with `it.each(PHASE1_TABLES)` so adding a table to the list
automatically adds coverage.

**E. Trust-boundary characterization (3 tests, NOT a sweep).**
`public.auth_church_group_id()` (`supabase/migrations/20260704000001_rls_policies.sql:29-38`)
and `public.auth_user_role()` (lines 42-53) read the `church_group_id` / `role`
JWT claims *first*, falling back to the DB only when the claim is absent — so a
JWT signed by the trusted issuer with a forged claim is authoritative. Pin that
behavior explicitly so #79 (OWASP review) inherits an accurate picture:

- Church A member JWT carrying `churchGroupId: IDS.churches.B` — assert what it
  can read from `songs`.
- Church A member JWT carrying `appRole: "admin"` — assert whether it can read
  `audit_logs` (an admin-only table).
- A JWT whose `church_group_id` claim is not a valid uuid must error, not
  silently fall through to the DB value.

Name these tests so the trust assumption is unmistakable (e.g.
`"church_group_id JWT claim overrides the DB value (trusted-issuer assumption)"`),
and add a file-header comment stating that the security of this path rests
entirely on only Clerk being able to mint these claims. **Record the outcome of
block E in `.pipeline/changes.md` under `## SECURITY FINDINGS`.** Do not change
any migration.

---

## Edge cases the implementation must handle

1. Importing ~19 handler modules into one test file — module-level env
   requirements must be mocked/stubbed, not worked around by dropping entries.
2. `getAvailability` is gated **conditionally** (`requireRole` only fires when
   `?user_id=` differs from `ctx.userId`) — it appears twice in the registry,
   once with and once without the query param.
3. Handlers that bail early on falsy `data` (`.single()` / `.maybeSingle()`)
   may never reach a later group-scoped query. If `recording.touched` or the
   "own group id present" assertion fails for such an entry, set `entry.result`
   to a shape that lets the handler proceed — do not delete the assertion.
4. `denyInvitation` / `acceptInvitation` accept a token path *or* a session
   path; their registry entries must exercise the session path (no token in the
   body/query) so `requireAuth` is actually reached.
5. `expectRejectedOrVerbatim` must treat a documented schema `.transform()`
   (e.g. `schemas/profile.ts` maps empty/whitespace `bio` to `null`) as a
   transform, not a sanitization failure — allow `null` for that specific field
   when the input trims to empty.
6. Rate-limit tests share one module-level store — `resetRateLimitStore()` in
   `beforeEach` plus a unique IP per test.
7. The lone surrogate can throw when round-tripped through
   `JSON.stringify`/`JSON.parse`. Keep it in the schema sweep (Zod handles it)
   and out of any test that serializes.
8. The RLS files must remain skip-safe: no top-level code that requires
   `SUPABASE_TEST_URL`, except block A which must run unconditionally.
9. No source file may contain a raw NUL / bidi / astral character — always
   construct them with `String.fromCharCode` / `String.fromCodePoint`.

---

## Verification

Run and report in `.pipeline/changes.md`:

- `bun run lint`
- `bun run typecheck`
- `bun run test`
- `bun run test:rls` (will skip without Supabase env vars — say so explicitly)

Do not use npm/yarn/pnpm/npx.
