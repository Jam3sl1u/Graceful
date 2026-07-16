# Review — Issue #56: Publish setlist (BR-01 zero-song publish)

VERDICT: SHIP

## What was reviewed
- Read `spec.md`, `changes.md`, `test-results.md`.
- Read the real diff (`git diff main...HEAD`) for `handler.ts` and both `route.ts` files.
- Compared against the reference patterns: `service-weeks/[id]/handler.ts` notification
  fan-out, `service-weeks/[id]/setlist/handler.ts` `toSetlistResponse`, and the existing
  handlers in `setlists/[id]/handler.ts`.
- Read the test file in full (stateful fake, filters, dedupe fixture).
- Re-ran `bun run typecheck` (clean) and the two publish/unlock test suites (29 tests pass).

## Findings
- `publishSetlist` matches the spec step-for-step: auth + role gate before any DB work,
  401 on missing JWT before constructing the client, tenant-scoped load with 404/409,
  update with fresh `published_at`, non-blocking song count, `Set`-deduped accepted
  invitations, notification insert guarded on `recipientIds.length > 0`, correct
  zero-song body copy, `// TODO(#67/#68)` at the fan-out site, and the shared try/catch.
- `unlockSetlist` correctly resets `status: "draft"` + `published_at: null` (invariant
  held), sends no notifications, reads no body, and 409s on a draft.
- Route files are minimal `await params` wrappers mirroring `cancel/route.ts`. `:id` is
  threaded as the setlist id.
- The `as unknown as ...Insert[]` cast on the notification payload matches the reference
  handler's shape (not scope creep). The update omits the cast per spec (Update type is
  already `Partial<Row>`).

## Test quality (not superficial)
- The in-memory fake actually applies `.eq()` filters via `applyFilters`, so the
  `status = "accepted"` filter and tenant/id scoping are genuinely exercised, not stubbed.
- Dedupe fixture is real: 4 invitation rows (user-a x2 accepted, user-b accepted,
  user-c pending) -> asserts exactly `["user-a","user-b"]`, proving both status filtering
  and `Set` dedupe.
- Five distinct 500 paths are wired to specific step-level error controls (load, update,
  song-count, invitations, notification insert), not a single generic failure.
- Every spec edge case (1-11) is covered, plus the tester supplement adds real end-to-end
  route wiring (two rows, only the target mutated), wrong-id-family 404, combined
  zero-songs+zero-members BR-01 case, and the unprovisioned-user (lookup->null) 401 branch.

## Notes for the human
- The tester-supplement test file
  (`tests/unit/app/api/setlists-publish-route-tester-supplement.test.ts`) and the updated
  `.pipeline/test-results.md` are present in the working tree but NOT yet committed (only
  the coder's commit `a58794b` is on the branch). Ensure `git add` picks them up before/at
  PR time so the supplemental coverage actually ships.
- No security, tenancy-leak, performance, or correctness issues found. Green tests reflect
  correct behavior here.
