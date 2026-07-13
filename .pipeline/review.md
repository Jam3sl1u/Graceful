# Review — Issue #41: Implement accept invitation flow

## VERDICT: SHIP

## Scope check vs. issue #41 Acceptance Criteria
- POST via response_token (no session) OR authenticated session (in-app) — done; dual path converges on one RPC.
- Token validated for expiry and "already responded" before accepting — done (already-responded returns gracefully, expiry raises EXPIRED, ordering matches AC/#51 intent).
- Status -> accepted; admin notified in-app — done (single atomic RPC; invited_by notified, or all admin/set_leader in group when null).
- Member added to event_attendees for the week's events (no-op/queued when none exist) — done (ON CONFLICT DO NOTHING; GET DIAGNOSTICS row count surfaced as attendeesAdded).
- Audit log with timestamp and time-to-respond — done (time_to_respond_seconds + via in metadata).
All five AC satisfied.

## Verification (run independently by review, not trusted from test-results.md)
- `bun run typecheck` — clean.
- `bun run lint` — clean.
- `bun run test` — 26 suites / 340 tests pass (14 new in invitations-accept-route.test.ts).
- `bun run check:service-role` — clean (getAnonSupabaseClient uses anon key, not service-role).

## SQL correctness (RPC can't be executed in-sandbox; verified by code review)
Every table/column the migration touches was checked against the real migrations:
- notifications(church_group_id, user_id, type, title, body, link_entity_type, link_entity_id) — matches 20260702000005.
- event_attendees unique(event_id, user_id) — matches 20260702000003; ON CONFLICT target correct.
- audit_logs(church_group_id, user_id, action, entity_type, entity_id, metadata) — matches 20260702000006.
- users(clerk_id, church_group_id, role, name) and invitations(response_token, response_deadline, responded_at, invited_by, service_week_id, user_id, status) — all present.
- notification_type enum contains 'invitation_accepted' — confirmed.
- SECURITY DEFINER + SET search_path='' with schema-qualified auth.jwt()/public.* — correct; GRANT to anon+authenticated; DOWN block and TODO(#62) present.

## Tests are meaningful, not superficial
Cover both happy paths (asserting the CORRECT client factory is used and the exact rpc args incl. p_response_token null vs token), already-responded pass-through, 400 (non-uuid id, wrong-length token, non-hex token), 401 (no session, and session-but-no-JWT with negative assertions that lookup/client are never called), and full error-message mapping 404/403/403-session/410/500, plus a BR-05 non-regression check (exactly one rpc call, no conflicts write).

## Advisory (non-blocking, does NOT hold up this PR)
- BR-05 conflict-on-accept is intentionally deferred (not in #41's AC or Out-of-Scope; conflict handling tracked separately). This is correctly scoped. HOWEVER a pre-existing comment in `app/api/invitations/handler.ts:52-53` states the `conflicts` row "is written at accept time (#41)", which is now stale/misleading against this implementation. It was not introduced by this diff, but a human should either fold BR-05 in or update that comment in a follow-up so it doesn't misdirect future work.
- The RPC and RLS/anon-role behavior were verified by review only; no live Postgres/test:rls run was possible in this sandbox (same limitation as coding/testing stages). Recommend running test:rls in an environment with SUPABASE_TEST_* creds before/after merge as defense-in-depth.

Non-blocking. Ship it.
