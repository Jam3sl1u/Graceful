# Changes — Issue #49: Invitation Response screen (mobile, no-login)

## Human resolution applied

The planner's OPEN QUESTION ("does #49 build the no-session deny backend?")
was resolved by the human to **Option A**: build the no-session deny backend
as part of this issue (spec Section 5), overriding the spec's default of
stopping at the question. All of Sections 1-5 of `.pipeline/spec.md` are
implemented.

## Summary

Replaced the placeholder `/invite/[token]` page with the real mobile-first
Invitation Response screen: loads invitation details by `response_token`
with no session, shows the service date / role note / event list, offers a
large green Accept button and an outlined Decline button, reveals an
optional reason + confirm on Decline, shows a checkmark success state with a
link into the app, and shows a friendly "unavailable" state (never a raw
error) for expired/already-used/unknown tokens (#51). Also built the
no-session DECLINE backend (new `deny_invitation` RPC + handler token branch
+ schema field + middleware entry) that the screen's Decline button needs,
and fixed a middleware bug that blocked the no-session lookup GET.

## Files changed

### Frontend (Sections 1-3)

- **`app/(public)/invite/[token]/page.tsx`** (modified) — replaced the
  placeholder body with the `page.tsx`/client-component split used by
  `app/(public)/join/[code]/page.tsx`: awaits `params`, renders
  `<InviteResponse token={token} />`.
- **`app/(public)/invite/[token]/invite-response.tsx`** (new, `"use client"`)
  — the screen itself. View states: `loading | ready | unavailable |
  accepted-success | declined-success`.
  - On mount, `GET /api/invitations/respond/${token}`; non-2xx/network error
    or a non-`"pending"` status routes to `unavailable` with a
    status-keyed friendly message (never the raw `error`/`code`/HTTP status,
    per #51); `"pending"` renders the card + Accept/Decline.
  - Card: service date (formatted via `toLocaleDateString`), `serviceWeek.title`
    if present, `roleNote` if present, one row per event (name, formatted
    `startTime`–`endTime`, `location` if present), or "Details coming soon"
    when `events` is empty.
  - Accept: `POST /api/invitations/:id/accept` with `{ responseToken: token }`;
    200+`status==="accepted"` → `accepted-success`; `alreadyResponded` with a
    different terminal status → `unavailable`; 410/404 → `unavailable`
    (expired); other errors → inline `role="alert"` message, stays on `ready`.
  - Decline: tapping Decline reveals a `<textarea maxLength={200}>` reason
    field and a "Confirm decline" / "Keep it" pair (no submission until
    confirmed). Confirm does `POST /api/invitations/:id/deny` with
    `{ responseToken: token, reason }`; same success/expired/error handling
    as Accept, landing on `declined-success`.
  - Both action buttons disable while a request is in flight (double-tap
    guard). Uses `components/ui/Button.tsx` (44px min touch targets already
    enforced there); Accept gets a `className`-appended green background
    (`.acceptButton` in the CSS module) without touching the shared
    `--color-accent` token.
- **`app/(public)/invite/[token]/invite-response.module.css`** (new) — layout
  (mirrors `join-form.tsx`'s `padding: 3rem 1.5rem` container), card, event
  rows, full-width stacked buttons (min-height 56px), green accept button,
  decline textarea, error/checkmark/app-link styling.

### Middleware fix (Section 4)

- **`middleware.ts`** (modified) — added `"/api/invitations/respond/(.*)"`
  (the required fix: the no-session lookup GET was previously blocked by
  `auth.protect()` before ever reaching the anon-capable handler) and, for
  Section 5, `"/api/invitations/(.*)/deny"` to `isPublicRoute`'s
  `createRouteMatcher([...])` list — mirrors the existing `.../accept` entry.
  The authenticated (no-token) deny path is still enforced inside the
  handler via `requireAuth`, exactly like accept.

### No-session DECLINE backend (Section 5, built per human resolution)

- **`supabase/migrations/20260713000001_deny_invitation_rpc.sql`** (new) —
  `public.deny_invitation(p_invitation_id uuid, p_response_token text,
  p_reason text)`, `SECURITY DEFINER`, `VOLATILE`, `SET search_path = ''`.
  Mirrors `accept_invitation`'s structure: not-found → `NOT_FOUND`; authorize
  by token match or (session path) `auth.jwt()->>'sub'` → own `user_id`,
  else `FORBIDDEN`; non-`pending` status returns gracefully with
  `already_responded: true`; past-deadline pending → `EXPIRED`; computes
  BR-08 `denial_count` (prior denied rows for user+week, +1); updates status
  to `denied` with `denial_reason`/`denial_count`/`responded_at`; inserts an
  `invitation_denied` notification to `invited_by` (or all admins/set_leaders
  in the group if null); inserts an `audit_logs` row directly (no-session-safe,
  since `write_audit_log` needs a JWT) with `action='invitation.denied'`.
  `GRANT EXECUTE ... TO anon, authenticated`. Existing authenticated deny
  logic (handler.ts, pre-existing tests) is untouched — this RPC is only
  invoked from the new token branch.
- **`schemas/invitations.ts`** (modified) — added `responseToken` (optional,
  64-char `/^[0-9a-f]{64}$/`, same shape as `acceptInvitationSchema`'s) to
  `denyInvitationSchema`.
- **`app/api/invitations/handler.ts`** (modified) — `denyInvitation`
  reordered to parse the body *before* calling `requireAuth` (required so the
  no-session branch never touches Clerk auth at all, mirroring
  `acceptInvitation`'s structure). If `responseToken` is present: takes a new
  branch — `getAnonSupabaseClient()`, `supabase.rpc("deny_invitation", {
  p_invitation_id: id, p_response_token, p_reason })`, and maps errors
  exactly like `acceptInvitation` (`NOT_FOUND`→404, `FORBIDDEN`→403,
  `EXPIRED`→410, else 500 `INTERNAL`); success returns
  `{ invitationId, status, alreadyResponded }`. The existing authenticated
  (no-token) path below is otherwise byte-for-byte unchanged — same
  `requireAuth`/JWT/`getSupabaseClient`/idempotency/BR-08/audit-log logic as
  before.
- **`lib/supabase/types.ts`** (modified) — added a `deny_invitation` entry to
  the hand-rolled `Database["public"]["Functions"]` map (Args
  `p_invitation_id`/`p_response_token`/`p_reason`, Returns
  `status`/`already_responded`), alongside the existing `accept_invitation`
  and `get_invitation_by_token` entries. Not explicitly called out in the
  spec's file list, but required for `bun run typecheck` to type the new
  `supabase.rpc("deny_invitation", ...)` call, per this file's own
  "keep bun run typecheck passing" convention comment.

### Test config (Section 6)

- **`jest.config.js`** (modified):
  - Added `"**/tests/unit/**/*.test.tsx"` to `testMatch` (spec-required).
  - Added a `moduleNameMapper` entry `"\\.module\\.css$":
    "<rootDir>/tests/mocks/css-module.js"`. Not explicitly listed in the
    spec, but turned out to be required: any component test importing
    `invite-response.tsx` (or anything using `components/ui/Button.tsx`)
    fails to parse without it, since Jest has no CSS loader outside
    webpack/Next — this was verified against the spec's own stated goal
    ("Make the minimal change so component tests can run") with a throwaway
    smoke test before being removed.
  - Changed the `@swc/jest` transform entry from a bare string to
    `[..., { jsc: { transform: { react: { runtime: "automatic" } } } }]` —
    also required: without it, `.tsx` test files transform JSX assuming a
    global `React` identifier (old transform), which doesn't exist under
    React 19's automatic runtime, and `render(<Component />)` throws
    `ReferenceError: React is not defined`. Verified the same way.
- **`tests/mocks/css-module.js`** (new) — a `Proxy` that echoes back the
  requested class name, mirroring the existing `tests/mocks/server-only.js`
  mock-via-`moduleNameMapper` pattern already used in this config.

### Carried forward, not authored by this stage

- **`.pipeline/spec.md`** — the Section 1-9 spec for #49 plus the resolved
  OPEN QUESTION note at the top, as written by the Planning stage before
  this Coding run started.

## Out of scope (per spec Section 9, not touched)

- In-app accept/deny from the notification inbox (#71/#73).
- SMS/email dispatch of the invitation (#67/#68 — still TODO'd in the
  handler, unchanged).
- Any change to the existing authenticated in-app deny/accept behavior
  beyond the additive token branch.

## Verification

- `bun run lint` (`eslint .`) — clean, no errors.
- `bun run typecheck` (`tsc --noEmit`) — clean, no errors.
- `bun run test` (Jest) — full existing suite: **31 suites / 380 tests
  passed**, unchanged pass count from before this change (no existing test
  was modified) — confirms the `denyInvitation` reordering did not regress
  any of the 13 existing tests in
  `tests/unit/app/api/invitations-deny-route.test.ts`.
- Manually verified the new component-test toolchain (jsdom environment,
  `.tsx` `testMatch`, CSS module mock, automatic JSX runtime) with a
  throwaway smoke test rendering `InviteResponse` and asserting the Accept
  button appears; deleted before committing since the actual component test
  file is the Tester's to write per spec Section 6
  (`tests/unit/app/invite-response.test.tsx`).
- No RPC/migration test harness exists in this repo for live SQL (same
  situation as `accept_invitation`/`get_invitation_by_token` before it); the
  `deny_invitation` migration was reviewed by hand against
  `accept_invitation_rpc.sql`'s established pattern line-for-line.

## What the Tester should focus on

- **New `deny_invitation` RPC branch in `denyInvitation`** — no existing test
  covers the no-session path; needs new tests mirroring
  `invitations-accept-route.test.ts`'s no-session cases (happy path via
  `getAnonSupabaseClient`, `NOT_FOUND`→404, `FORBIDDEN`→403, `EXPIRED`→410,
  already-responded, malformed/non-hex `responseToken`→400). Also confirm
  the *reordering* (body-parse-before-`requireAuth`) didn't change any
  session-path behavior — the 13 existing deny tests already pass unchanged,
  but worth an explicit look since the diff touches control flow shared by
  both paths.
- **The component itself** (`invite-response.tsx`) — no automated test
  exists yet; per spec Section 6 the Tester places
  `tests/unit/app/invite-response.test.tsx`. Edge cases named in spec
  Section 7 to prioritize: empty `events`, null `roleNote`/`serviceWeek.title`/
  event `location`, already-responded on load vs. re-tap after responding,
  expired via lookup vs. via a 410 on submit, double-tap/in-flight button
  disabling, reason >200 chars.
- **Middleware**: confirm both new public routes
  (`/api/invitations/respond/(.*)`, `/api/invitations/(.*)/deny`) don't
  inadvertently open anything beyond what's intended — the authenticated
  deny path still self-enforces via `requireAuth` inside the handler, same
  as the pre-existing `.../accept` pattern.
- **Jest config changes** (`moduleNameMapper` CSS mock, automatic JSX
  runtime) are new infrastructure with no prior precedent in this repo —
  worth confirming they don't affect the existing 380 non-component tests
  (verified green in this run, but flagging since it's shared global config).
