# Test Results — Issue #62: Google Calendar event sync

This overwrites the stale `test-results.md` for issue #61 that was still
sitting at this path (per AGENTS.md, `.pipeline/` files reflect only the most
recent run).

## Verdict: PASS

All independently-run verification commands are clean, and new tests written
by this stage (independent of the coder's own suite) pass, including the two
"ordering-dependent path" checks the coder's changes.md flagged as needing
integration-style (not just mock-argument) proof.

## Commands re-run independently

- `bun run lint` — clean, no errors/warnings.
- `bun run typecheck` — clean, no errors.
- `bun run check:service-role` — `OK: no service-role key references found
  outside comments in app/ or lib/.` Confirms the OQ-1 = A design never
  introduces a service-role client; cross-user token reads go only through
  the new `SECURITY DEFINER` RPCs called via the acting user's own client.
- `bun run test` (full suite, including new tests below): **70 suites / 880
  tests pass** (coder's baseline was 67 suites / 873 tests; this stage added
  3 suites / 7 tests, all passing).

## New tests written this stage

### `tests/unit/app/api/events-id-route-tester-supplement.test.ts` (2 tests)
Independently proves the delete-ordering claim in changes.md item #1 ("worth
an integration-style check that the RPC call genuinely happens first, not
just that the mocked function was called with the right arguments"). Uses a
shared `callOrder` marker array pushed to by both `unsyncEventFromAttendees`
and the real `events.delete()` call inside a hand-built fake Supabase client,
so the assertion is about *real invocation order*, not just call arguments.
- Confirms `unsyncEventFromAttendees` is invoked strictly before
  `events.delete()` is issued.
- Confirms the same ordering holds, and the DB delete still proceeds (200,
  `{ deleted: true }`), even when `unsyncEventFromAttendees` rejects
  (graceful degradation under real ordering, not just "sync mocked to
  resolve").

### `tests/unit/app/api/events-id-attendees-route-tester-supplement.test.ts` (3 tests)
Same ordering concern for `removeAttendee` (unsync must happen before the
`event_attendees` row is deleted, since `get_event_sync_targets` joins on
that table).
- Confirms `unsyncEventFromUser` is invoked strictly before
  `event_attendees.delete()` is issued.
- Independently re-verifies the spec-deviation signature documented in
  changes.md — `unsyncEventFromUser(supabase, eventId, userId,
  googleEventId)` — is exactly what the handler passes (a real call-shape
  check, distinct from the coder's own suite asserting the same thing).
- Confirms the ordering + 200 response hold even when `unsyncEventFromUser`
  rejects.

### `tests/unit/lib/google-calendar/sync-tester-supplement.test.ts` (2 tests)
Independently covers spec edge case #10 ("Missing TOKEN_ENCRYPTION_KEY /
Google env vars — existing helpers throw; the per-attendee try/catch
swallows it (logged), request still succeeds. Never log token plaintext or
the key.") via a corrupted `access_token_encrypted` value (a plain decrypt
error, distinct from the `GoogleTokenInvalidError`/5xx-shaped failures the
coder's own `sync.test.ts` exercises) — this is the genuine failure case for
this stage:
- A corrupted ciphertext causes `decryptToken` to throw; `syncEventToAttendees`
  swallows it, never calls Google, and — critically — **never calls
  `flag_calendar_token_invalid`** (a corrupt DB value is not the same failure
  mode as a revoked refresh token; flagging it would incorrectly prompt the
  member to reconnect Google Calendar when the real bug is elsewhere).
  Also asserts the logged `console.error` output never contains the
  plaintext access/refresh token or the encryption key.
- Per-attendee isolation re-verified independently: one corrupted target and
  one healthy target in the same `syncEventToAttendees` call — only the
  healthy target's calendar actually receives the Google API call.

## Coverage against the spec / changes.md checklist

1. **Ordering-dependent paths** (delete/remove before DB write) — independently
   verified with real call-order tracking, not just mock-argument assertions.
   PASS.
2. **`syncEventToUser`/`unsyncEventFromUser` signature deviation** (added
   `eventId` param) — independently re-confirmed at the handler call site;
   matches `lib/google-calendar/sync.ts`'s actual exported signatures. No
   conflict found with the spec's literal snippet beyond what changes.md
   already discloses as a documented, necessary deviation. PASS.
3. **Graceful degradation** — spot-checked with a real rejection
   (`unsyncEventFromAttendees`/`unsyncEventFromUser` throwing) at both
   ordering-sensitive call sites: HTTP status stays 200 in both cases. Also
   independently exercised a genuinely different failure mode (decrypt
   failure, not the coder's already-covered `GoogleTokenInvalidError`/5xx
   cases) in `sync.ts` directly. PASS.
4. **RLS/security boundary** — read
   `supabase/migrations/20260716000001_google_calendar_sync.sql` in full.
   `get_event_sync_targets` checks caller role (`admin`/`set_leader`) and
   that the event's `church_group_id` matches the caller's group before
   returning any token row; `get_user_sync_targets` scopes strictly to the
   caller's own `user_id`; `flag_calendar_token_invalid` requires either
   self or admin/set_leader-in-same-group, and is idempotent (no-op + no
   duplicate notification when already invalid). All three use `SECURITY
   DEFINER`, `SET search_path = ''`, and `GRANT EXECUTE ... TO authenticated`,
   consistent with the `record_availability_conflict` pattern cited in the
   spec. Not covered by `bun run test` (this is SQL, not executed against a
   real DB per the spec's own instruction) — this is a static read-through,
   not a live-DB verification.
5. **Token refresh / invalid_grant path** — confirmed `sync.test.ts` mocks
   `refreshAccessToken` (unit-level), and the 400/`invalid_grant` →
   `GoogleTokenInvalidError` mapping itself is separately covered in
   `oauth.test.ts`; spot-checked `oauth.ts`'s `refreshAccessToken` reads as
   claimed (throws `GoogleTokenInvalidError` specifically on
   `error === "invalid_grant"`, a plain `Error` otherwise).

## Files independently re-read (not just changes.md's claims about them)

- `lib/google-calendar/sync.ts`, `lib/google-calendar/oauth.ts`,
  `lib/google-calendar/token-crypto.ts`
- `app/api/events/handler.ts`, `app/api/events/[id]/handler.ts`,
  `app/api/events/[id]/attendees/handler.ts`,
  `app/api/google-calendar/callback/handler.ts`
- `supabase/migrations/20260716000001_google_calendar_sync.sql`
- Existing test suites: `tests/unit/lib/google-calendar/sync.test.ts`,
  `tests/unit/app/api/events-id-route.test.ts`,
  `tests/unit/app/api/events-id-attendees-route.test.ts`

## Not independently verified (documented limitation, matches spec instruction)

- The migration was not run against a real Postgres/Supabase instance (per
  the spec's explicit instruction not to). SQL correctness is judged by
  static read-through only, same limitation the coder's own changes.md
  discloses.
- `lib/supabase/types.ts` hand-updated types were spot-checked for the three
  new RPC names and the `is_valid` column, but their exact `Args`/`Returns`
  shapes were not checked against a live-generated Supabase type dump (none
  exists in this repo's tooling to diff against).

## Conclusion

No failing tests. No regressions. The two explicitly-flagged
ordering-dependent paths now have real integration-style ordering proof (not
just mock-argument assertions), and one additional genuine failure mode
(corrupted-ciphertext decrypt failure) was exercised beyond what the coder's
own suite covers. Ready for Review.
