# Review — Issue #62: Google Calendar event sync

## VERDICT: SHIP

Independently verified (re-run, not trusted from test-results.md):
- `bun run typecheck` — clean
- `bun run lint` — clean
- `bun run test` — 70 suites / 880 tests pass
- `bun run check:service-role` — no service-role key usage introduced

## Assessment

The implementation faithfully realizes the spec's "Recommended design (OQ-1 = A)":
inline best-effort sync driven by three `SECURITY DEFINER` RPCs, never touching a
service-role client. Every claim in changes.md checks out against the actual diff.

Security boundary (the crux of this issue) is correct:
- `get_event_sync_targets` derives caller from `auth.jwt()->>'sub'`, requires
  `admin`/`set_leader`, and requires the event to belong to the caller's own
  group before returning any encrypted token row. All handlers that call it are
  already role-gated to admin/set_leader.
- `get_user_sync_targets` is strictly self-scoped (`user_id = v_caller_id`).
- `flag_calendar_token_invalid` requires self OR admin/set_leader-in-same-group,
  and is idempotent (no repeat notification once `is_valid = false`).
- All three use `SECURITY DEFINER`, `SET search_path = ''`, `GRANT EXECUTE ...
  TO authenticated`, mirroring `record_availability_conflict`.

Correctness details verified:
- `toGoogleEventId` output (`gr` + 32 lowercase hex chars) is a valid base32hex
  id in Google's required range.
- PATCH→404→POST-with-id fallback keeps create idempotent; DELETE treats 404/410
  as success. `invalid_grant` is the only failure that flags a token invalid;
  5xx/network/decrypt failures are logged and swallowed without flagging.
- Ordering constraints are honored: `deleteEvent` and `removeAttendee` read sync
  targets (which join `event_attendees`) BEFORE the cascading DB delete.
- `is_valid: true` on the callback upsert clears a prior revoke on reconnect,
  followed by best-effort retroactive `syncAllEventsForUser`.
- `notifications` insert shape matches the table (`link_entity_type varchar(50)`
  accepts `'google_calendar'`; `church_group_id`/`user_id`/`type` NOT NULLs all
  supplied). Enum value added via `ADD VALUE IF NOT EXISTS`, only referenced in
  deferred function bodies (not at migration time), consistent with
  20260711000002.
- Hand-maintained `lib/supabase/types.ts` matches the migration (new `is_valid`
  column + three RPC signatures); `types/domain.ts` union updated.

Tests are meaningful, not superficial: `sync.test.ts` uses a real encrypt/decrypt
round-trip, asserts exact Google REST URLs/methods/bodies/auth headers, and covers
PATCH/POST fallback, DELETE 404/410, per-attendee isolation, invalid_grant → flag +
notify, non-auth-failure → no-flag, RPC-error → no-op, and refresh gating. The
tester-supplement suites add real call-order proof for the delete/remove ordering
and a distinct corrupted-ciphertext decrypt-failure path.

## Notes for the human sign-off (non-blocking, by-design)

1. OQ-1 was a genuine BLOCKING security-posture question. changes.md states a
   human resolved it as (A). The code correctly implements (A), but confirm that
   sign-off did happen: with (A), an admin's request can reach other members'
   encrypted OAuth tokens through `get_event_sync_targets`. This is intentional
   and matches the repo's established `SECURITY DEFINER` cross-user pattern.
2. `syncAllEventsForUser` runs inline in the OAuth callback and syncs every event
   the member attends sequentially before the redirect — added latency for members
   with many events. Inline design is per spec; acceptable, worth awareness.
3. The `syncEventToUser`/`unsyncEventFromUser` signature gained an `eventId` param
   vs. the spec's literal snippet — documented and necessary given the RPC takes an
   event id; sensible.
4. The migration was not run against a real Postgres instance (per spec). SQL was
   reviewed statically only.
