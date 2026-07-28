# Test Results — Issue #65: Build Member Week View screen

This overwrites the stale `test-results.md` for issue #63 that was still
sitting at this path (per AGENTS.md, `.pipeline/` files reflect only the most
recent run).

## Verdict: ALL PASS

## Summary

All checks pass. Two new test files were written (as named in `.pipeline/spec.md`
under "Tests for the Testing stage") and independently verify the coder's
claims — the coder's `changes.md` explicitly deferred writing these to this
stage, which matches the pipeline contract.

## Commands run

- `bun run typecheck` — clean, no errors.
- `bun run lint` — clean, no errors/warnings.
- `bun run test` — **79 suites / 1004 tests pass**, 0 failures (77 suites /
  968 tests pre-existing per the coder's baseline + 2 new suites / 36 new
  tests added by this stage). No regressions in any pre-existing suite.

## New test files written

### `tests/unit/app/api/service-weeks-member-view-route.test.ts` (20 tests)

Mirrors `tests/unit/app/api/song-documents-route.test.ts` / the setlist route
test's `makeChain`/`makeLookup`/`setUpAuth` helpers, with a per-table
`from(table)` dispatcher covering all 12 tables the handler touches
(`service_weeks`, `invitations`, `setlists`, `setlist_songs`, `songs`,
`events`, `event_attendees`, `users`, `member_profiles`, `member_instruments`,
`instruments`, `song_documents`).

Covers:
- Auth/authz: 401 (no Clerk user, no JWT), 403 for guest (and confirms
  `getSupabaseClient` is never constructed for a rejected role), 200 for each
  of admin/set_leader/member.
- Happy path: full aggregate payload — `serviceWeek` summary, `confirmationStatus`,
  `setlist.songs` with correct `effectiveKey` resolution and ordering, `events`
  with per-event `assigned`, `team` sorted by name with correct
  `vocalCapability`/`instruments` per member (including the "no profile" →
  `vocalCapability: "none"`, `instruments: []` case), `documents` with a
  freshly-minted `downloadUrl` and **no `file_key` anywhere in the response**
  (spec edge case 13).
- Edge case 1 (404 for missing/other-tenant week) + a 500 path when the
  `service_weeks` query itself errors.
- Edge case 2 (no setlist row → `null`; **draft** setlist row → `null`, as a
  defense-in-depth check beyond RLS).
- Edge case 3 (published setlist, zero songs → `{status:"published",songs:[]}`,
  distinct from `null`).
- Edge case 4 (`effectiveKey` null when both `key_override` and `default_key`
  are null).
- Edge case 5 / 8 (no events → `events: []`, `team: []`, and — verified via a
  `from` spy — the handler never calls `.from("event_attendees")` or
  `.from("users")` when there are no events, i.e. the empty-`.in()` guard is
  real, not just claimed).
- Edge case 6 (member assigned to only some events — per-event `assigned`
  differs, but `team` still reflects the full attendee set across all events).
- Edge case 9 (`getDownloadUrl` rejecting → `documents: []`, endpoint still
  200) plus an additional case: documents query is skipped entirely (`from`
  never called with `"song_documents"`) when the published setlist has zero
  songs.
- Edge case 10 (no invitation row → `confirmationStatus: null`, still 200).
- Edge case 11 (cancelled week → `isCancelled: true` passed through).
- Re-invite safety: multiple `invitations` rows for the caller → the one with
  the latest `created_at` wins.
- A general 500 path (events query error) to confirm the fail-fast pattern
  holds beyond the week/setlist checks already covered by the sibling tests.

### `tests/unit/app/member-week-view.test.tsx` (16 tests)

Mirrors `tests/unit/app/week-view.test.tsx` (jsdom, `fetch` mocked and keyed
by URL).

Covers:
- Loading state before the fetch resolves.
- Happy path: header (title/date), confirmation badge, setlist list (scoped
  via `within()` to disambiguate from the Documents section's same song
  title), assigned-only events section (unassigned event correctly excluded),
  team roster (incl. an instrument-less member rendering "—"), documents
  section with a working download link, and the floating chat button present
  but `disabled`.
- Event detail panel: clicking an assigned event opens the panel with a Maps
  link built from the event's location (percent-encoded), and the close
  button clears it (edge case 7's positive case).
- Edge case 7: an event with `location: null` opens a detail panel with **no**
  Maps link.
- Edge case 3 vs 2: zero-songs published setlist renders "No songs added yet"
  and explicitly asserts the "not yet released" copy is absent (and vice
  versa for a null setlist).
- Empty-state messages for events, team, and documents sections.
- Edge case 10: `confirmationStatus: null` renders the "Not invited" badge and
  the rest of the screen still renders (not gated on confirmation).
- Edge case 11: cancelled week renders the Cancelled badge.
- View-state branches: 404 → not-found, 403 → forbidden, network throw →
  error, unexpected 500 → error.

## Notes for the Reviewer

- No failures were found; nothing was patched around. The implementation
  matches every edge case named in `.pipeline/spec.md`'s "Edge cases the
  implementation MUST handle" list (1–11 directly tested here; 12 — guest
  403 — is covered; 13 — no `file_key` leakage / fresh signed URL per request
  — is asserted via `JSON.stringify` + a `getDownloadUrl` call-argument check).
- One thing worth a second look in review, not a test failure: the spec's
  Decisions section already flags that a member confirmed for a week with no
  events yet won't show in `team` — this is by design (documented limitation),
  and the "no events" test in this suite confirms that behavior is what's
  actually implemented, not accidental.
- Test-file-only fix made during this stage: the component test's fixture
  data originally had an event named "Sunday Service" that collided with the
  service week's title "Sunday Service", making some queries ambiguous
  (`getByText`/`getByRole` matching two elements). Renamed the fixture event
  to "Sunday Gathering" and scoped the setlist-song assertions with
  `within()` to avoid a separate collision with an identically-titled
  Documents heading. This was a test-fixture naming fix only — no production
  code was touched.

## Files added by this stage (Testing)

- `/Users/jamesliu/Documents/Graceful/.claude/worktrees/issue-65/tests/unit/app/api/service-weeks-member-view-route.test.ts`
- `/Users/jamesliu/Documents/Graceful/.claude/worktrees/issue-65/tests/unit/app/member-week-view.test.tsx`

No implementation files were modified. Ready for Review.
