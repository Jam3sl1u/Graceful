# Spec — Issue #74: [Sprint 4] Build Admin Global Dashboard screen

## OPEN QUESTIONS

**None blocking — do not stop the pipeline.** Two judgement calls the issue left
undefined are resolved below; both are implemented exactly as written here.

1. **"Roster fill rate (e.g. `5 of 7 confirmed`)" has no denominator defined in
   the issue.** Decision: denominator = number of distinct members whose *latest*
   invitation for that week is not `withdrawn`; numerator = number of distinct
   members whose *latest* invitation is `accepted`. "Latest" = max `created_at`
   per member per week, mirroring `getCurrentInvitation` in
   `app/(app)/week/[id]/week-view.tsx`. Rationale: a withdrawn invitation is a
   retracted slot (shouldn't inflate the denominator), while `denied`/`expired`/
   `pending` are real unfilled slots.
2. **Role gate: `admin` only, or `admin` + `set_leader`?** Decision: `["admin",
   "set_leader"]`, matching every other planning-side endpoint in the repo
   (`GET /api/conflicts`, `GET /api/invitations`, `GET /api/availability/team`),
   and required anyway because the conflict data this screen aggregates is
   leader/admin-gated by RLS. The screen is still the Admin persona's home; set
   leaders simply are not locked out.

## Goal

Build PRD Screen 8 (Admin Global Dashboard, `/dashboard`): one cross-week,
group-wide list of every service week — regardless of the caller's own roster
status — showing per week: publish status, roster fill rate, open-conflict
count; filterable by date range and by active/cancelled. Read-only; the only
action is navigating into the existing Week View (`/week/{id}`).

Scope guard: **no changes** to existing endpoints, handlers, RLS/migrations, or
to `app/(app)/week/**`. This issue adds one new read endpoint plus one screen.

## Current state (verified by reading the code)

- `app/(app)/dashboard/page.tsx` is a 4-line placeholder
  (`<h1>Admin Global Dashboard — coming soon</h1>`). This is the route to build.
- `GET /api/service-weeks` (`app/api/service-weeks/handler.ts`, `listServiceWeeks`)
  returns all weeks in the group ordered by `service_date` desc, but carries no
  setlist status, no invitation counts, no conflict counts, and no filters.
- `GET /api/invitations` (`app/api/invitations/handler.ts`, `listInvitations`)
  **requires** a `serviceWeekId` — per-week only, so a client-side dashboard
  would be N+1.
- `GET /api/service-weeks/:id/setlist` is likewise per-week.
- `GET /api/conflicts` (`app/api/conflicts/handler.ts`, `getOpenConflicts`)
  returns all OPEN conflicts (`resolved_at IS NULL`) group-wide with
  `serviceWeekId` — but it is a heavier per-conflict join than this screen needs.
- Cancellation flag: `service_weeks.is_cancelled` (#39), already surfaced as
  `isCancelled` in `toServiceWeekResponse`.
- Publish status: `setlists.status` (`SetlistStatus = "draft" | "published"` in
  `types/domain.ts`), one setlist row per service week. `week-view.tsx` has a
  hardcoded `TODO(Sprint 3 #64): drive from setlist status` badge — **leave that
  TODO alone**, it is a different screen.
- A static route segment living beside a dynamic one is established practice:
  `app/api/availability/team/` beside `app/api/availability/[date]/`. So
  `app/api/service-weeks/overview/` beside `app/api/service-weeks/[id]/` is fine.

Therefore: add one aggregate read endpoint (the `member-view` handler is the
pattern), then a client screen that consumes it.

## Files to create

### 1. `schemas/service-weeks.ts` (MODIFY — append only)

Add, without touching `createServiceWeekSchema` / `updateServiceWeekSchema`:

```ts
import { isValidDateString } from "@/schemas/availability";

export const serviceWeekStatusFilters = ["all", "active", "cancelled"] as const;
export type ServiceWeekStatusFilter = (typeof serviceWeekStatusFilters)[number];

// GET /api/service-weeks/overview query params (#74). All optional; date
// bounds are inclusive and validated as real calendar dates (reuses
// isValidDateString from schemas/availability.ts).
export const serviceWeeksOverviewQuerySchema: z.ZodType<{
  startDate?: string;
  endDate?: string;
  status: ServiceWeekStatusFilter;
}>;

export type ServiceWeeksOverviewQuery = z.infer<typeof serviceWeeksOverviewQuerySchema>;
```

Implement it as a `z.object({ startDate: ..., endDate: ..., status: z.enum(serviceWeekStatusFilters).default("all") })`
with a `.superRefine` that:
- rejects `startDate` / `endDate` that fail `isValidDateString` (per-field issue,
  same message style as `getTeamAvailabilityQuerySchema`);
- when both are present and valid, rejects `startDate > endDate`.
No max-range cap (unlike `MAX_TEAM_RANGE_DAYS`) — this endpoint returns weeks,
not per-day rows. Explicit type annotation above is illustrative; write it the
way `getTeamAvailabilityQuerySchema` is written (plain const + inferred type).

### 2. `app/api/service-weeks/overview/handler.ts` (NEW)

Copy the structure of `app/api/service-weeks/[id]/member-view/handler.ts`
(imports, `requireAuth`/`requireRole`, JWT fetch, `getSupabaseClient(jwt)`,
per-query `error` → `fail("Internal error", ErrorCode.INTERNAL, 500)`, trailing
`catch (err)` with `ApiException` re-mapping). All reads go through the caller's
RLS-scoped client; **no service-role client, no RPC, no migration.**

```ts
export type ServiceWeekOverviewEntry = {
  id: string;
  serviceDate: string;          // service_weeks.service_date, YYYY-MM-DD
  title: string | null;
  isCancelled: boolean;
  setlistStatus: SetlistStatus | null; // null = no setlist row for this week
  confirmedCount: number;       // numerator of the fill rate
  rosterSize: number;           // denominator of the fill rate
  openConflictCount: number;    // open (resolved_at IS NULL) conflicts for this week
};

export type ServiceWeeksOverviewResponse = {
  serviceWeeks: ServiceWeekOverviewEntry[];
};

// GET /api/service-weeks/overview (#74) — admin/set_leader only.
export async function getServiceWeeksOverview(
  req: NextRequest,
  lookup?: UserLookup,
): Promise<Response>;
```

Order of operations:

1. `const ctx = await requireAuth(req, lookup);` then
   `requireRole(ctx, ["admin", "set_leader"]);`
2. Parse `serviceWeeksOverviewQuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams))`;
   on failure `fail("Validation failed", ErrorCode.VALIDATION_FAILED, 400)`
   (identical to `getTeamAvailability`).
3. JWT via `auth()` → `getToken({ template: "supabase" })`; missing → 401
   `UNAUTHENTICATED`.
4. Weeks query: `.from("service_weeks").select("id, service_date, title, is_cancelled")
   .eq("church_group_id", ctx.churchGroupId)`, then conditionally
   `.gte("service_date", startDate)` / `.lte("service_date", endDate)` when
   present, then `.eq("is_cancelled", false)` for `status === "active"` /
   `.eq("is_cancelled", true)` for `status === "cancelled"` (no filter for
   `"all"`), then `.order("service_date", { ascending: false })` — same ordering
   as `listServiceWeeks`.
5. If zero weeks → `return ok<ServiceWeeksOverviewResponse>({ serviceWeeks: [] })`
   immediately; do **not** issue the `.in()` queries with an empty id list (same
   guard style as `getMemberWeekView` step 6).
6. Setlists: `.from("setlists").select("service_week_id, status")
   .eq("church_group_id", ctx.churchGroupId).in("service_week_id", weekIds)`.
   Build `Map<serviceWeekId, SetlistStatus>`.
7. Invitations: `.from("invitations").select("id, service_week_id, user_id, status, created_at")
   .eq("church_group_id", ctx.churchGroupId).in("service_week_id", weekIds)`.
   Select those explicit columns only — **never `select("*")` on invitations**
   (`response_token` / `denial_reason` must not leak; see the comment above
   `listInvitations`). Neither field appears in the response type.
8. Conflicts: `.from("conflicts").select("id, invitation_id")
   .eq("church_group_id", ctx.churchGroupId).is("resolved_at", null)`.
   Map each conflict to a week via the invitation rows from step 7
   (`invitationId → serviceWeekId`); a conflict whose invitation is not in that
   map (i.e. belongs to a filtered-out week) is silently ignored.
9. Aggregate per week and return
   `ok<ServiceWeeksOverviewResponse>({ serviceWeeks })`, preserving the step-4
   ordering.

Aggregation rules (exact — the tests assert these):

- Latest invitation per `(service_week_id, user_id)`: the row with the greatest
  `created_at`; on a tie keep the first one encountered (same reduce shape as
  `getCurrentInvitation` in `week-view.tsx`: replace only when strictly greater).
- `rosterSize` = count of members whose latest invitation status `!== "withdrawn"`.
- `confirmedCount` = count of members whose latest invitation status `=== "accepted"`.
- `openConflictCount` = number of open conflict rows mapped to that week (count
  rows, not distinct members).
- `setlistStatus` = map lookup, `null` when the week has no setlist row.

### 3. `app/api/service-weeks/overview/route.ts` (NEW)

Exactly the shape of `app/api/availability/team/route.ts`:

```ts
import { NextRequest } from "next/server";
import { getServiceWeeksOverview } from "./handler";

export async function GET(req: NextRequest): Promise<Response> {
  return getServiceWeeksOverview(req);
}
```

### 4. `app/(app)/dashboard/admin-dashboard.tsx` (NEW, `"use client"`)

Copy the shell of `app/(app)/conflicts/conflicts-list.tsx` (state machine, fetch
+ `cancelled` guard, the four render branches, `next/link` cards) and the
`formatServiceDate` helper verbatim from it.

```tsx
export default function AdminDashboard(): JSX.Element;
```

Local (not imported from the handler) response type, mirroring the "keep it
local/minimal" comment at the top of `week-view.tsx`:

```ts
type OverviewWeek = {
  id: string;
  serviceDate: string;
  title: string | null;
  isCancelled: boolean;
  setlistStatus: "draft" | "published" | null;
  confirmedCount: number;
  rosterSize: number;
  openConflictCount: number;
};
type StatusFilter = "all" | "active" | "cancelled";
type ViewState = "loading" | "ready" | "forbidden" | "error";
```

State: `view`, `weeks: OverviewWeek[]`, `startDate: string` (""), `endDate:
string` (""), `status: StatusFilter` ("all"), `filterError: string | null`.

Behavior:

- `useEffect` keyed on `[startDate, endDate, status]`, with the
  `let cancelled = false` / cleanup guard copied from `conflicts-list.tsx` so a
  stale response can't overwrite a newer one.
- URL: `/api/service-weeks/overview?` with `status` always set, and
  `startDate`/`endDate` appended **only when non-empty** (use `URLSearchParams`).
- Response handling: `403` → `view = "forbidden"`; `400` → keep
  `view = "ready"`, set `weeks = []` and
  `filterError = "Check the date range — the start date must be on or before the end date."`
  (the filter controls must stay on screen so the user can fix them); other
  `!res.ok` or a thrown error → `view = "error"`; success → set weeks, clear
  `filterError`, `view = "ready"`.
- Re-fetching after the first load must not blank the screen into `"loading"`
  permanently — setting `view` back to `"loading"` on each filter change is
  acceptable and is what the tests will assume.

Render (`ready`):

- `<h1>Global dashboard</h1>`.
- Filter controls, each with an associated `<label>` (accessible names are what
  the tests query on):
  - `From` — `<input type="date">` bound to `startDate`.
  - `To` — `<input type="date">` bound to `endDate`.
  - `Status` — `<select>` with options `All` (`all`), `Active` (`active`),
    `Cancelled` (`cancelled`).
- `filterError` (when set) rendered in a `<p role="alert">`.
- Empty list → `<p>No service weeks match these filters.</p>`.
- Otherwise a `<ul>` of `<li>` cards; each card is a
  `<Link href={`/week/${week.id}`}>` (import `Link` from `next/link`, same as
  `conflicts-list.tsx`) containing:
  - title: `week.title ?? "Untitled service"`;
  - `formatServiceDate(week.serviceDate)`;
  - publish badge (`Badge` from `@/components/ui/Badge`):
    `setlistStatus === "published"` → `tone="success"`, text `Published`;
    `setlistStatus === "draft"` → `tone="neutral"`, text `Draft`;
    `setlistStatus === null` → `tone="neutral"`, text `No setlist`;
  - additionally, when `week.isCancelled` → a second `Badge tone="danger"` with
    text `Cancelled`;
  - roster fill: `rosterSize === 0` → `No one invited yet`, else
    `` `${confirmedCount} of ${rosterSize} confirmed` ``;
  - when `openConflictCount > 0` → `Badge tone="danger"` with
    `` `${n} open conflict${n === 1 ? "" : "s"}` ``; render nothing when 0.

Non-`ready` branches — copy the exact markup/copy from `conflicts-list.tsx`:
`loading` → `<p>Loading…</p>`; `forbidden` → `<h1>You don&apos;t have access to
this page</h1>` + `<p>This screen is available to Set Leaders and Admins only.</p>`;
`error` → `<h1>Something went wrong</h1>` + `<p>Please try again later.</p>`.

No mutations, no buttons that write. Editing beyond navigating to `/week/{id}`
is out of scope.

### 5. `app/(app)/dashboard/admin-dashboard.module.css` (NEW)

Start from `app/(app)/conflicts/conflicts-list.module.css` (`.container`,
`.list`, `.card`, `.cardHeader`, `.weekTitle`, `.date`) and add a `.filters` row
(flex, wrap, gap) plus `.filterField` (label + control stacked) and `.cardMeta`
(flex row, gap) for the badges/fill-rate line. Widen `.container` `max-width` to
`860px` — this is a wider, table-like screen. Use existing CSS custom properties
(`--color-border`, `--color-fg`) only; no new global tokens.

### 6. `app/(app)/dashboard/page.tsx` (MODIFY — replace the placeholder)

Mirror `app/(app)/conflicts/page.tsx` exactly (server component, no `params` to
await, renders inside `AppShell` via the `(app)` layout):

```tsx
import AdminDashboard from "./admin-dashboard";

// Admin Global Dashboard (PRD wireframe screen 8 / issue #74). Cross-week,
// group-wide view; the per-week detail screen is /week/[id] (#48).
export default function Page() {
  return <AdminDashboard />;
}
```

### 7. `tests/unit/app/api/service-weeks-overview-route.test.ts` (NEW)

Copy the harness from `tests/unit/app/api/availability-team-route.test.ts`
(module mocks for `@clerk/nextjs/server` + `@/lib/supabase/client`, `makeReq({
query })` returning `{ nextUrl: { searchParams } }`, `makeLookup`, `setUpAuth`)
and the generic chainable `makeChain` mock from
`tests/unit/app/api/service-weeks-member-view-route.test.ts` (needed because
this handler chains `.eq`/`.gte`/`.lte`/`.in`/`.is`/`.order` in varying
combinations). Cover at minimum: happy path aggregation (fill rate, setlist
status, conflict count), latest-invitation-wins, withdrawn excluded, zero weeks
short-circuit, `status=active` / `status=cancelled` filter applied, invalid date
→ 400, `startDate > endDate` → 400, member role → 403, anonymous → 401, missing
JWT → 401, DB error → 500.

### 8. `tests/unit/app/admin-dashboard.test.tsx` (NEW)

`/** @jest-environment jsdom */`. Copy the `fetch`-mocking + `jsonResponse`
helpers from `tests/unit/app/member-week-view.test.tsx`. Cover at minimum:
renders a week card with `"5 of 7 confirmed"`, the `Published`/`Draft`/`No
setlist` badge, the `Cancelled` badge, the open-conflict badge and its
singular/plural forms, the `No one invited yet` case, the empty-list message,
changing the Status select re-fetches with `status=cancelled` in the URL, the
403 forbidden branch, and the 400 branch keeping the filters rendered.

## Edge cases the implementation must handle

1. Group with no service weeks, or no weeks in the requested range → `200` with
   `serviceWeeks: []`, and none of the `.in()` follow-up queries issued.
2. Week with zero invitations → `rosterSize: 0`, `confirmedCount: 0`; UI shows
   `No one invited yet`, never `0 of 0 confirmed`.
3. Re-invited member (multiple invitation rows for the same member+week) counts
   once, using the latest `created_at` only — a stale `denied`/`withdrawn` row
   must not mask a newer `accepted` one.
4. A member whose latest invitation is `withdrawn` is excluded from both
   numerator and denominator.
5. Week with no `setlists` row → `setlistStatus: null` → `No setlist` badge (not
   `Draft`).
6. `status=active` excludes cancelled weeks; `status=cancelled` returns only
   cancelled weeks; omitted/`all` returns both.
7. Date bounds are inclusive; only one of `startDate`/`endDate` supplied applies
   just that bound.
8. Malformed or non-calendar date (`2026-02-30`), or `startDate > endDate`, or an
   unknown `status` value → `400 VALIDATION_FAILED`; the screen keeps its filter
   controls usable and shows an inline `role="alert"` message.
9. An open conflict whose invitation belongs to a week outside the current filter
   is ignored (no orphan counting, no crash on the missing map entry).
10. Role gate: `member` / `guest` → `403 FORBIDDEN` → forbidden screen; no Clerk
    session → `401`; session but no Supabase JWT → `401`.
11. Any Supabase `error` on any of the four queries → `500 INTERNAL` (single
    generic message, never leak the DB error) → error screen.
12. Rapid filter changes: the in-flight `cancelled` guard prevents an older
    response from overwriting a newer one.
13. This screen is group-wide: it must never filter by the caller's own
    invitations (that is the distinction from Week View #48 / Member Week View
    #65).

## Verification

`bun run lint`, `bun run typecheck`, `bun run test` must all pass. Do not run
`npm`/`npx`. No new dependencies.
