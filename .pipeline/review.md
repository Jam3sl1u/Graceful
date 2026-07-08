# Review — Issue #33: RLS cross-tenant bypass tests

## VERDICT: SHIP

## Basis
Reviewed the full `git diff main...HEAD` firsthand (not just the summaries), re-ran
`bun run typecheck` (clean), `bun run lint` (clean), and `bun run test:rls`
(8 suites / 227 tests skipped, 0 failed — new file is picked up by the glob and the
skip guard works).

## Assessment against spec
- **`setup.ts` IDS**: All 15 new/promoted UUIDs match the spec's exact table, placed in
  the correct new sub-objects (`memberInstruments`, `songDocuments`,
  `notificationPreferences`, `eventAttendees`) and extended sub-objects. The three
  promoted inline literals keep identical values. Every id referenced by the new test
  (including pre-existing `setlists.publishedB`, `setlistSongs.publishedB`, `songs.B1`,
  `events.B`, `instruments.drumsB`) exists.
- **`seedViaServiceClient()`**: Church-B rows added for all specified tables with the
  exact column sets; new `event_attendees` A+B block placed after events/users. The
  matching Church-B rows for setlists/setlist_songs/songs/events already existed, so
  all UPDATE/DELETE targets are seeded.
- **`seed-rls-test.sql`**: Mirrors the TS seed row-for-row with identical UUIDs/columns.
- **`helpers.ts`**: `assertUpdateNoOp` / `assertDeleteNoOp` implement the spec's ground-
  truth pattern correctly — read-before via service client, ignore the attacker write's
  error (tolerating both silent 0-row no-op and hard privilege error), re-read, assert
  patched columns unchanged / row survives. This is meaningful, not superficial: it
  verifies actual DB state via an RLS-bypassing client rather than trusting a null error.
- **`cross-tenant-bypass.test.ts`**: One describe per all 19 tables, SELECT/INSERT/
  UPDATE/DELETE from Church A memberA against Church B rows; the four role-gated tables
  additionally repeat writes as adminA. SELECT filters use `church_group_id` for Tier-1
  and `id` for Tier-2/Tier-3 exactly as specified. All patches target columns that
  differ from the seeded value, so a successful mutation would be detected (no trivial
  passes).
- **`rls.test.ts`**: Three inline→IDS refactors, same UUID values, no behavior change.
- **`README.md`**: Documents the canonical file and the CI skip≠block limitation per the
  spec's open-question resolution.

## Notes (not blockers)
- The `notification_preferences` INSERT collides on `user_id` unique → may surface as
  `23505` rather than `42501`; `assertInsertDenied` only requires *an* error. This is an
  explicit spec choice, called out by both coder and tester, not an oversight.
- The `supabase-js` HTTP path was not exercised end-to-end (needs a full Supabase stack).
  The tester ran an independent raw-SQL harness applying all migrations + the SQL seed and
  executing the exact 19×4 matrix (+ adminA repeats), confirming SELECT=0 rows,
  INSERT=RLS denial, UPDATE/DELETE=silent no-op (audit_logs=hard privilege error), plus a
  positive-control sanity check. Strong proxy; the untested plumbing predates this issue.
- CI required-status-check + secrets is a repo-settings action, correctly left out of scope.

Green tests here reflect correct behavior. No correctness, security, or performance
issues found.
