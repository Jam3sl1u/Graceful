# Spec — Issue #49: Invitation Response screen (mobile, no-login)

## OPEN QUESTION (BLOCKING — human decision required)

**The no-session DECLINE path does not exist in the backend, so "decline
without login" cannot be wired as the issue asks.**

- Accept already supports no-session: `POST /api/invitations/[id]/accept`
  accepts a `{ responseToken }` body and runs as the anon role through the
  `accept_invitation` SECURITY DEFINER RPC. (`app/api/invitations/handler.ts`
  lines 398-463; `supabase/migrations/20260712000001_accept_invitation_rpc.sql`).
- Deny does **not**: `denyInvitation` (`app/api/invitations/handler.ts` lines
  199-296) calls `requireAuth` + `getSupabaseClient(jwt)` and has no token
  branch. `denyInvitationSchema` (`schemas/invitations.ts`) has no
  `responseToken` field. There is **no `deny_invitation` RPC** in
  `supabase/migrations/`. The deny route is also absent from the middleware
  public allowlist.
- Issue #49 says "wire directly to #42 (deny)" and lists #42 as a resolved
  dependency, but #42 as merged is authenticated-only. AC "Tapping Decline
  reveals an optional reason field and a confirm button ... works with no
  session" and "On success: checkmark state" cannot be met without a new
  no-session deny backend.

**Decision needed:** does #49 build the no-session deny backend (new RPC +
handler token branch + schema field + middleware entry — Section 5 below), or
is that split back into #42 and #49 blocked until it lands?

Everything in Sections 1-4 (the screen itself, the accept wiring, the
middleware fix for the token lookup) is unblocked and correct regardless.
Section 5 (decline submission) is contingent on the answer above. Per the
pipeline contract, downstream stages stop until this is resolved — but the
spec is written so a one-line answer unblocks the coder immediately.

**Recommended resolution:** Option A — build the no-session deny in this issue
(Section 5). It is small, mirrors accept exactly, and the screen is dead
without it.

---

## 1. Summary

Replace the placeholder invite-response page with a real mobile-first screen
that: loads invitation details by `response_token` with no session, shows the
service date / role note / event list, offers a large Accept (green) and
Decline (outlined) button, reveals an optional reason + confirm on Decline,
shows a checkmark success state with a link into the app, and gracefully
handles expired / already-used / unknown tokens by showing a friendly state
with a link into the app instead of a raw error (#51).

The backend read + accept endpoints already exist. This issue is primarily
frontend, plus one required middleware fix (Section 4) and — pending the OPEN
QUESTION — the no-session deny backend (Section 5).

## 2. Files

Create:
- `app/(public)/invite/[token]/invite-response.tsx` — client component (the UI).
- `app/(public)/invite/[token]/invite-response.module.css` — styles (green
  accept button, layout, spacing, ≥44px targets).

Modify:
- `app/(public)/invite/[token]/page.tsx` — replace placeholder body; render the
  client component with the token.
- `middleware.ts` — add the token-lookup route to `isPublicRoute` (Section 4).
- `jest.config.js` — allow component tests (Section 6).

Modify only if OPEN QUESTION resolves to Option A (Section 5):
- `schemas/invitations.ts`, `app/api/invitations/handler.ts`, `middleware.ts`
  (deny route), and a new `supabase/migrations/<timestamp>_deny_invitation_rpc.sql`.

## 3. Frontend

### 3.1 `page.tsx` (server component)

Follow the exact shape of `app/(public)/join/[code]/page.tsx`:

```tsx
import InviteResponse from "./invite-response";

export default async function InviteResponsePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <InviteResponse token={token} />;
}
```

### 3.2 `invite-response.tsx` (`"use client"`)

Follow `app/(public)/join/[code]/join-form.tsx` for the fetch/state style.

Signature: `export default function InviteResponse({ token }: { token: string })`.

Data shape returned by the lookup (from `PublicInvitationLookup` in
`app/api/invitations/handler.ts` lines 465-479, wrapped in `{ data }` per
`types/api.ts`):

```ts
type Lookup = {
  invitationId: string;
  status: "pending" | "accepted" | "denied" | "withdrawn" | "expired";
  roleNote: string | null;
  responseDeadline: string | null;
  serviceWeek: { id: string; serviceDate: string; title: string | null };
  events: Array<{
    id: string;
    type: "pre_practice" | "rehearsal" | "sound_check" | "service";
    name: string;
    location: string | null;
    startTime: string; // ISO
    endTime: string;   // ISO
  }>;
};
```

Reuse types where possible: import `InvitationStatus`, `EventType` from
`@/types/domain` rather than re-declaring the unions.

Behavior:

1. On mount (`useEffect`), `GET /api/invitations/respond/${token}`. Track a
   view state: `loading | ready | unavailable | accepted-success |
   declined-success`.
2. Parse `res.json()`; success body is `{ data: Lookup }`, error body is
   `{ error, code }` (`types/api.ts`).
3. Branch on the result:
   - HTTP 404 or network error → `unavailable` view (Section 3.4).
   - `data.status === "pending"` → `ready` view: render the card + Accept/Decline.
   - `data.status` is `expired`, `accepted`, `denied`, or `withdrawn` →
     `unavailable` view with a status-appropriate message (#51 — expired /
     already-used never shows a raw error).
4. Store `invitationId` and keep `token` for the accept/decline POSTs.

Card contents (`ready` view):
- Service date: format `serviceWeek.serviceDate` (a `YYYY-MM-DD` date string)
  as a human date. Show `serviceWeek.title` if non-null.
- Role note: `roleNote` if non-null (label it, e.g. "Your role").
- Events list: one row per `events[]`, showing time (format `startTime`–
  `endTime`) and `location` (omit location line when null). Events already
  arrive ordered by start time. If `events` is empty, render a neutral
  "Details coming soon" line — do not crash (the week may have no events yet;
  see the RPC note at `accept_invitation_rpc.sql` line 94).

Buttons (`ready` view): use the existing `Button` component
(`components/ui/Button.tsx`), which already enforces `min-height`/`min-width`
44px (satisfies A-08 / AC touch-target sizing — verify in the CSS module you
do not shrink below 44px).
- Accept: `variant="primary"`, but must render **green** (AC). The shared
  `--color-accent` is indigo (`app/globals.css`), so add a green background in
  `invite-response.module.css` and pass it via `className` (the `Button`
  component appends `className` after its variant class). Do not change the
  global token.
- Decline: `variant="secondary"` (already outlined).
- The two buttons must be visually large and clearly separated (AC "two
  large, separated buttons").

### 3.3 Accept + Decline actions

Accept:
- `POST /api/invitations/${invitationId}/accept`, headers
  `{ "Content-Type": "application/json" }`, body
  `JSON.stringify({ responseToken: token })`.
- Disable both buttons while the request is in flight.
- HTTP 200: read `{ data: { status, alreadyResponded } }`. If `status ===
  "accepted"` → `accepted-success` view. If `alreadyResponded` is true with a
  terminal non-accepted status (`denied`/`withdrawn`) → `unavailable` view.
- HTTP 410 (`code: "EXPIRED"`) or 404 → `unavailable` view (#51: into the app,
  not a raw error).
- Other/network error → inline retryable error message (`role="alert"`), stay
  on `ready`.

Decline (reveal-then-confirm):
- Tapping Decline does NOT submit. It reveals: an optional reason
  `<textarea>` (maxLength 200 — matches `denyInvitationSchema` max) and a
  "Confirm decline" button, plus a way to back out (e.g. a "Keep it" /
  cancel control returning to the two-button state).
- Confirm submits (endpoint/body per Section 5; blocked by OPEN QUESTION).
  On success → `declined-success` view. On expired/used → `unavailable`.

### 3.4 Success + unavailable views

- `accepted-success` / `declined-success`: a checkmark/confirmation message
  ("You're on the schedule" / "Response recorded") plus a prominent link into
  the full app: link to `/dashboard`. Use `next/link` or a plain anchor as in
  `join-form.tsx`.
- `unavailable`: a friendly message keyed to why (expired, already responded,
  or not found) and the same link into the app (`/dashboard`). Never surface
  the raw `error`/`code` string or an HTTP status to the user (#51).

Mobile-first: single-column, generous padding (mirror `join-form.tsx`'s
`padding: "3rem 1.5rem"` container), full-width stacked buttons. Wrap the page
in a `<main>`.

## 4. Middleware fix (REQUIRED, unblocked)

`middleware.ts` `isPublicRoute` currently lists `/invite(.*)` and
`/api/invitations/(.*)/accept` but NOT the token-lookup route. A no-session
user's `GET /api/invitations/respond/<token>` is therefore blocked by
`auth.protect()` before it reaches the (correctly anon-capable) handler — the
screen cannot load its data. Add:

```
"/api/invitations/respond/(.*)",
```

to the `createRouteMatcher([...])` list. (This is a latent #44 bug; it is a
required part of making #49 function no-session, with an unambiguous fix.)

## 5. No-session DECLINE backend — CONTINGENT on OPEN QUESTION (Option A)

Only implement if the human resolves the OPEN QUESTION to "build it here."
Mirror the accept path exactly; do NOT touch the existing authenticated deny
logic — add the token path alongside it so existing deny tests stay green.

1. New migration `supabase/migrations/<YYYYMMDDHHMMSS>_deny_invitation_rpc.sql`.
   Copy the structure of `20260712000001_accept_invitation_rpc.sql`. Signature
   `public.deny_invitation(p_invitation_id uuid, p_response_token text,
   p_reason text)`, SECURITY DEFINER, `SET search_path = ''`,
   `GRANT EXECUTE ... TO anon, authenticated`. Logic:
   - Load invitation; not found → `RAISE EXCEPTION 'NOT_FOUND'`.
   - Authorize: if `p_response_token` non-null, it must equal
     `response_token` else `FORBIDDEN`; else derive caller from
     `auth.jwt()->>'sub'` and require `= user_id` else `FORBIDDEN`.
   - If `status <> 'pending'`: return current status gracefully
     (`already_responded: true`), matching accept's idempotency (handler lines
     239-241 today already do this for the auth path).
   - Expiry: if pending and past `response_deadline` → `RAISE EXCEPTION 'EXPIRED'`.
   - Compute `denial_count` = existing denied rows for (user, service_week) + 1
     (same as handler lines 245-254).
   - `UPDATE ... SET status='denied', denial_reason=<coalesced null>,
     denial_count=..., responded_at=now()`.
   - Insert an `invitation_denied` notification to `invited_by` if set, else to
     all admins/set_leaders in the group (mirror accept's notify block).
   - Insert an `audit_logs` row `action='invitation.denied'` (no-session-safe,
     as accept does — cannot use `write_audit_log` which needs a JWT).
   - Return `jsonb_build_object('status','denied','already_responded',false)`.

2. `schemas/invitations.ts`: add `responseToken` (optional, 64-char
   `/^[0-9a-f]{64}$/`) to `denyInvitationSchema`, matching
   `acceptInvitationSchema`.

3. `app/api/invitations/handler.ts` `denyInvitation`: at the top, parse the
   body with the updated schema. If `responseToken` is present, take a
   no-session branch — `getAnonSupabaseClient()`, call
   `supabase.rpc("deny_invitation", { p_invitation_id: id, p_response_token,
   p_reason })`, and map errors like `acceptInvitation` does
   (`NOT_FOUND`→404, `FORBIDDEN`→403, `EXPIRED`→410, else 500). Leave the
   existing authenticated (no-token) path untouched.

4. `middleware.ts`: also add `"/api/invitations/(.*)/deny"` to `isPublicRoute`.

5. Frontend Decline confirm (Section 3.3): `POST
   /api/invitations/${invitationId}/deny` with body `{ responseToken: token,
   reason }` (omit/empty reason is valid → treated as no reason).

## 6. Test config (REQUIRED to test the component)

`jest.config.js` currently sets `testEnvironment: "node"` and
`testMatch: ["**/tests/unit/**/*.test.ts"]` (`.ts` only). A React component
test must be `.tsx` under jsdom. Make the minimal change so component tests can
run without disturbing the node-env API tests:

- Add `"**/tests/unit/**/*.test.tsx"` to `testMatch`.
- Keep the global `testEnvironment: "node"`; the component test file should opt
  into jsdom with a top-of-file docblock: `/** @jest-environment jsdom */`.

Testing-library (`@testing-library/react`, `jest-environment-jsdom`) and
`@testing-library/jest-dom` (loaded in `jest.setup.ts`) are already installed.
The tester will place the component test at
`tests/unit/app/invite-response.test.tsx` and mock `fetch`.

## 7. Edge cases the implementation must handle

- No session at all — the entire happy path (load + accept, and decline once
  Section 5 lands) must work with no Clerk session. Do not import anything that
  forces auth in the client component.
- Malformed/unknown token → lookup returns 404 → `unavailable` view, never a
  raw error (anti-enumeration is already handled server-side; the client just
  must not leak it).
- Expired token: lookup returns `status: "expired"`; accept returns 410. Both
  → `unavailable`/into-app, per #51.
- Already responded (`accepted`/`denied`/`withdrawn`) on load OR a re-tap after
  responding (accept returns `alreadyResponded: true`) → graceful
  already-responded state, no double side effects.
- `events` empty → render without crashing.
- `roleNote` null, `serviceWeek.title` null, event `location` null → omit those
  lines cleanly.
- Double-tap / in-flight: disable buttons while a POST is pending.
- Reason > 200 chars: enforce `maxLength={200}` on the textarea (server also
  caps at 200).

## 8. Patterns to copy (name the file)

- Page + client-component split, fetch/`useState` flow, `role="alert"` errors,
  success view: `app/(public)/join/[code]/page.tsx` + `join-form.tsx`.
- Button + 44px targets + variants: `components/ui/Button.tsx` /
  `Button.module.css`.
- No-session accept request shape and error mapping: `acceptInvitation` in
  `app/api/invitations/handler.ts` (lines 398-463).
- (Section 5) new RPC structure, auth-by-token, notify + audit inserts:
  `supabase/migrations/20260712000001_accept_invitation_rpc.sql`.
- API envelope (`{ data }` / `{ error, code }`): `types/api.ts`.

## 9. Out of scope (do not build)

- In-app accept/deny from the notification inbox (Sprint 4, #71/#73).
- SMS/email dispatch of the invitation (#67/#68 — already TODO'd in the handler).
- Any change to the existing authenticated in-app deny/accept behavior beyond
  the additive token branch in Section 5.
