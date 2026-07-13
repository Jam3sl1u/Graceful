# Spec — Issue #44: Token-based public invitation lookup

`GET /api/invitations/respond/:token` — a **no-session, no-Clerk-auth** read-only
endpoint that returns an invitation's details to someone tapping an SMS/email
link. Token possession is the only credential (per #40).

## No OPEN QUESTIONS

The design is fully determined by existing patterns. In particular the "clear
expired state, not a generic error" criterion is satisfied by returning HTTP 200
with a computed `status: "expired"` (the `expired` value already exists in the
`InvitationStatus` union in `types/domain.ts` even though it is not a DB enum
value — it is an API-only, derived state). Do not invent a new error code for it.

## Background the coder must know

- Direct table reads are impossible here: RLS on `invitations`, `service_weeks`,
  and `events` grants SELECT only `TO authenticated`, tenant-scoped
  (`supabase/migrations/20260704000001_rls_policies.sql`). A no-session caller is
  the Postgres `anon` role and can read none of it.
- The accept path solved the identical problem: a `SECURITY DEFINER` RPC
  authenticated by the token, invoked through `getAnonSupabaseClient()`. Copy that
  pattern. Reference files:
  - RPC to copy from: `supabase/migrations/20260712000001_accept_invitation_rpc.sql`
  - Handler to copy from: `acceptInvitation` in `app/api/invitations/handler.ts`
    (the `responseToken !== undefined` / `getAnonSupabaseClient()` branch and the
    RPC-error-message → HTTP mapping).
  - Route to copy from: `app/api/invitations/[id]/accept/route.ts`.
  - Test to copy from: `tests/unit/app/api/invitations-accept-route.test.ts`.

## Files to create / modify

### 1. `supabase/migrations/20260712000002_get_invitation_by_token_rpc.sql` (CREATE)

A new `SECURITY DEFINER` function, structured exactly like
`accept_invitation` (same header comment style, `SET search_path = ''`, `P0001`
error via `RAISE EXCEPTION 'NOT_FOUND'`, and a matching `-- ============ DOWN`
section). Differences: it is read-only, so mark it `STABLE` (not `VOLATILE`) and
do NOT mutate anything.

```sql
CREATE OR REPLACE FUNCTION public.get_invitation_by_token(p_response_token text)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  STABLE
  SET search_path = ''
AS $$
DECLARE
  v_inv    public.invitations%ROWTYPE;
  v_week   public.service_weeks%ROWTYPE;
  v_events jsonb;
  v_status text;
BEGIN
  SELECT * INTO v_inv FROM public.invitations WHERE response_token = p_response_token;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_week FROM public.service_weeks WHERE id = v_inv.service_week_id;

  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id',         e.id,
        'type',       e.type,
        'name',       e.name,
        'location',   e.location,
        'start_time', e.start_time,
        'end_time',   e.end_time
      ) ORDER BY e.start_time
    ),
    '[]'::jsonb
  )
  INTO v_events
  FROM public.events e
  WHERE e.service_week_id = v_inv.service_week_id;

  -- Computed "expired" state: only a still-pending invitation past its deadline.
  -- Already-responded rows keep their real status (accepted/denied/withdrawn).
  IF v_inv.status = 'pending'
     AND v_inv.response_deadline IS NOT NULL
     AND now() > v_inv.response_deadline THEN
    v_status := 'expired';
  ELSE
    v_status := v_inv.status;
  END IF;

  RETURN jsonb_build_object(
    'invitation_id',     v_inv.id,
    'status',            v_status,
    'role_note',         v_inv.role_note,
    'response_deadline', v_inv.response_deadline,
    'service_week', jsonb_build_object(
      'id',           v_week.id,
      'service_date', v_week.service_date,
      'title',        v_week.title
    ),
    'events', v_events
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_invitation_by_token(text) TO anon, authenticated;
```

Include the commented DOWN line:
`-- DROP FUNCTION IF EXISTS public.get_invitation_by_token(text);`

### 2. `lib/supabase/types.ts` (MODIFY)

Add one entry to `Database["public"]["Functions"]` (alongside `accept_invitation`).
The RPC returns `jsonb`; type its `Returns` as the snake_case shape above:

```ts
get_invitation_by_token: {
  Args: { p_response_token: string };
  Returns: {
    invitation_id: string;
    status: InvitationStatus;
    role_note: string | null;
    response_deadline: string | null;
    service_week: { id: string; service_date: string; title: string | null };
    events: Array<{
      id: string;
      type: EventType;
      name: string;
      location: string | null;
      start_time: string;
      end_time: string;
    }>;
  };
};
```

`InvitationStatus` is already imported at the top of this file. Add `EventType`
to that same import from `@/types/domain`.

### 3. `app/api/invitations/handler.ts` (MODIFY — add one exported function)

Add a response type and handler. Do NOT call `requireAuth`, `auth()`, or
`getSupabaseClient` — this path has no session by design.

```ts
export type PublicInvitationLookup = {
  invitationId: string;
  status: InvitationStatus;
  roleNote: string | null;
  responseDeadline: string | null;
  serviceWeek: { id: string; serviceDate: string; title: string | null };
  events: Array<{
    id: string;
    type: EventType;
    name: string;
    location: string | null;
    startTime: string;
    endTime: string;
  }>;
};

export async function getInvitationByToken(token: string): Promise<Response> {
  // Anti-enumeration: a malformed token must return the SAME 404 as an unknown
  // one, so an attacker cannot distinguish "wrong format" from "not found".
  const parsed = respondTokenParamSchema.safeParse(token);
  if (!parsed.success) {
    return fail("Not found", ErrorCode.NOT_FOUND, 404);
  }

  try {
    const supabase = getAnonSupabaseClient();
    const { data, error } = await supabase.rpc("get_invitation_by_token", {
      p_response_token: parsed.data,
    });

    if (error) {
      if ((error.message ?? "").includes("NOT_FOUND")) {
        return fail("Not found", ErrorCode.NOT_FOUND, 404);
      }
      return fail("Internal error", ErrorCode.INTERNAL, 500);
    }

    return ok<PublicInvitationLookup>({
      invitationId: data.invitation_id,
      status: data.status,
      roleNote: data.role_note,
      responseDeadline: data.response_deadline,
      serviceWeek: {
        id: data.service_week.id,
        serviceDate: data.service_week.service_date,
        title: data.service_week.title,
      },
      events: data.events.map((e) => ({
        id: e.id,
        type: e.type,
        name: e.name,
        location: e.location,
        startTime: e.start_time,
        endTime: e.end_time,
      })),
    });
  } catch {
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}
```

Add `EventType` to the existing `import type { InvitationStatus } from "@/types/domain"`
line, and import `respondTokenParamSchema` from `@/schemas/invitations` (add it to
the existing schema import block). `getAnonSupabaseClient`, `ok`, `fail`,
`ErrorCode` are already imported in this file.

### 4. `schemas/invitations.ts` (MODIFY)

Add, next to `acceptInvitationParamSchema` (reuse its exact token shape):

```ts
// GET /api/invitations/respond/:token param (#44). Same 64-char hex shape as the
// response_token. On mismatch the route returns 404 (NOT 400) — see handler note.
export const respondTokenParamSchema = z
  .string()
  .length(64)
  .regex(/^[0-9a-f]{64}$/);
```

### 5. `app/api/invitations/respond/[token]/route.ts` (REPLACE the stub)

```ts
import { NextRequest } from "next/server";
import { getInvitationByToken } from "../../handler";

type Ctx = { params: Promise<{ token: string }> };

export async function GET(_req: NextRequest, { params }: Ctx): Promise<Response> {
  const { token } = await params;
  return getInvitationByToken(token);
}
```

Remove the `notImplemented` import.

### 6. `tests/unit/app/api/invitations-respond-route.test.ts` (CREATE)

Mirror `invitations-accept-route.test.ts`: mock `@/lib/supabase/client`
(`getAnonSupabaseClient`) and use a `makeRpcClient({ data, error })` helper.
Import `getInvitationByToken` from `@/app/api/invitations/handler`. Do NOT mock
or expect `@clerk/nextjs/server` auth to be called. Use a valid token
`"a".repeat(64)`. Cover every edge case below.

## Edge cases the implementation MUST handle

1. **Happy path (pending):** RPC returns `status: "pending"` with a populated
   `service_week` and `events` array → 200; body maps to camelCase
   (`serviceWeek.serviceDate`, `events[].startTime`, etc.); uses
   `getAnonSupabaseClient`.
2. **Expired (>72h, still pending):** RPC returns `status: "expired"` → HTTP 200
   (NOT an error code), with the invitation details still present.
3. **Already responded:** RPC returns the real `status` (`"accepted"` /
   `"denied"` / `"withdrawn"`) → 200 with that status (per #51 semantics).
4. **Unknown token (valid format, no row):** RPC raises `NOT_FOUND` →
   404 `{ error: "Not found", code: "NOT_FOUND" }`.
5. **Malformed token (bad length / non-hex):** handler returns the **identical**
   404 `{ error: "Not found", code: "NOT_FOUND" }` WITHOUT calling the RPC or
   `getAnonSupabaseClient`. The message/code/status must be byte-identical to
   case 4 so format-validity is not leaked (acceptance criterion).
6. **Empty events:** week with no events yet → `events: []` (RPC `coalesce` to
   `'[]'`), still 200.
7. **Unexpected RPC error:** any non-`NOT_FOUND` error message → 500
   `INTERNAL`.

## Explicitly OUT OF SCOPE (do not implement)

- Accept/deny mutations (#41/#42 — already done in `acceptInvitation` /
  `denyInvitation`; this issue is read-only).
- Any Clerk/session handling on this route.
- Adding the `events` table to `Database["public"]["Tables"]` — the RPC returns
  events as JSON, so only the `Functions` entry is needed. Do not widen types
  beyond what is specified.
- Notification/SMS dispatch.

## Verification before finishing (Coding stage)

Run `bun run lint`, `bun run typecheck`, and `bun run test` (Jest). The RPC
itself has no DB test harness in this repo (the `accept_invitation` RPC is
likewise only exercised through mocked-client route tests), so RPC-body
correctness is verified by review + the route tests that mock its return values —
do not add a live-DB test.
