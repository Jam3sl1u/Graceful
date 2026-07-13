# Changes — Issue #41: Implement accept invitation flow

Implements `POST /api/invitations/:id/accept` for both the no-session
(SMS/email `responseToken`) and in-app (Clerk session) paths, converging on a
single `SECURITY DEFINER` Postgres RPC that does all validation/mutation
atomically.

## Files changed

- **`supabase/migrations/20260712000001_accept_invitation_rpc.sql`** (new)
  `public.accept_invitation(p_invitation_id uuid, p_response_token text)`:
  - Looks up the invitation; `NOT_FOUND` if missing.
  - Authorizes via token match (no-session) or Clerk JWT `sub` resolved to
    `users.id` matching `invitations.user_id` (in-app); otherwise `FORBIDDEN`.
  - If already responded (not `pending`), returns gracefully
    `{status, already_responded: true, attendees_added: 0}` — not an error.
  - If `pending` but past `response_deadline`, raises `EXPIRED`.
  - Otherwise: flips `status` to `accepted`, sets `responded_at`; inserts
    `event_attendees` rows for every event of the service week
    (`ON CONFLICT DO NOTHING`, so a week with no events yet is a no-op);
    notifies `invited_by` (or, if null, every `admin`/`set_leader` in the
    group) via a `notifications` row (`type = 'invitation_accepted'`);
    appends an `audit_logs` row with `time_to_respond_seconds` and `via`
    (`'token'` or `'session'`) in `metadata`.
  - `GRANT EXECUTE ... TO anon, authenticated` (anon needed for the no-session
    path). Has the `-- TODO(#62)` GCal-sync stub comment and a commented DOWN
    block, matching `20260711000001_availability_conflict_rpc.sql` /
    `20260707000001_audit_log_write_rpc.sql`.

- **`lib/supabase/client.ts`** — added `getAnonSupabaseClient()`, identical
  env-var resolution/guard to `getSupabaseClient` but with no `Authorization`
  header, so it runs as the `anon` Postgres role. Used only by the
  no-session accept path.

- **`lib/supabase/types.ts`** — added `accept_invitation` to
  `public.Functions` (`Args: { p_invitation_id, p_response_token }`,
  `Returns: { status: InvitationStatus; already_responded: boolean;
  attendees_added: number }`).

- **`lib/api/errors.ts`** — added `EXPIRED: "EXPIRED"` to `ErrorCode` (used
  for the 410 expired-invitation response).

- **`schemas/invitations.ts`** — added `acceptInvitationParamSchema`
  (`z.string().uuid()`) and `acceptInvitationSchema` (optional
  `responseToken`: 64-char lowercase hex string) plus the
  `AcceptInvitationInput` type export.

- **`app/api/invitations/handler.ts`** — added `acceptInvitation(req, id,
  lookup?)`:
  1. Validates `id` (400 on non-uuid) and body (400 on malformed
     `responseToken`).
  2. If `responseToken` present → `getAnonSupabaseClient()`, no `requireAuth`
     call, `p_response_token = responseToken`. Else → `requireAuth` (401 if
     no session), then the same `getToken({template:"supabase"})` JWT guard
     used elsewhere (401 if missing), `getSupabaseClient(jwt)`,
     `p_response_token = null`.
  3. Calls `supabase.rpc("accept_invitation", {...})`.
  4. Maps RPC error messages: `NOT_FOUND`→404, `FORBIDDEN`→403,
     `EXPIRED`→410, anything else→500 INTERNAL.
  5. On success: `ok({ invitationId, status, alreadyResponded,
     attendeesAdded })`, 200.
  Same `try/catch (err) { ApiException ? ... : INTERNAL }` envelope as
  `createInvitation`.

- **`app/api/invitations/[id]/accept/route.ts`** — replaced the
  `notImplemented` stub with the real route, mirroring
  `app/api/service-weeks/[id]/cancel/route.ts` (async `params` extraction,
  delegates to the handler).

- **`middleware.ts`** — added `"/api/invitations/(.*)/accept"` to
  `isPublicRoute`'s matcher array so the no-session SMS/email link reaches
  the handler without Clerk blocking it at the middleware layer. The in-app
  path is unaffected — Clerk still populates `auth()` from the session
  cookie on public routes, and the handler itself calls `requireAuth`
  whenever no `responseToken` is supplied.

- **`.pipeline/spec.md`** — carried forward as committed by the Planning
  stage (regenerated from scratch, scoped correctly to #41; superseded the
  prior run's stale/blocked artifacts — see `.pipeline/test-results.md`'s
  "BLOCKED" note from the pipeline run immediately before this one).

## What the Tester should focus on

- Both accept paths (token vs. session) and that the right Supabase client
  (`getAnonSupabaseClient` vs `getSupabaseClient`) is used for each, per the
  test plan in `.pipeline/spec.md`'s "Tests" section
  (`tests/unit/app/api/invitations-accept-route.test.ts`, mocking both
  client factories and Clerk `auth`).
- RPC error-message-substring mapping (`NOT_FOUND`/`FORBIDDEN`/`EXPIRED` →
  404/403/410; anything else → 500).
- 400 for non-uuid `id` and for a malformed `responseToken` (wrong length or
  non-hex).
- 401 when there's no token and no session (`requireAuth` throws before the
  RPC is ever called).
- The "already responded" graceful 200 path (`already_responded: true`,
  whatever `status` the RPC returns).
- This spec deliberately does NOT implement BR-05 conflict-row creation on
  accept (see spec.md's "Deferred / explicitly out of scope") — no test
  should expect a `conflicts` insert here.

## Verification run

- `bun run lint` — clean.
- `bun run typecheck` — clean.
- `bun run test` — all 25 suites / 326 tests pass (existing suite; no new
  test file was added by this stage per the pipeline split — the spec
  assigns `tests/unit/app/api/invitations-accept-route.test.ts` to the
  Testing stage).
- `bun run check:service-role` — clean (no service-role key references in
  `app/`/`lib/`).

## Not touched (out of scope per spec)

- Deny flow (#42).
- Google Calendar sync on accept (#62) — left a `TODO(#62)` comment only in
  the RPC.
- "Already responded" edge-case UI copy (#51).
- BR-05 conflict-on-accept row creation — explicitly deferred per spec's
  "Deferred / explicitly out of scope" section; flagged there as a
  conscious decision for a human to fold in later if desired, not an
  omission.
