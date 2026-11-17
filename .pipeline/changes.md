# Changes — issue #82 (remediation of review BLOCK)

Operator decision applied (passed by orchestrator): Option A, disposable test users; operator creates two throwaway staging sign-in accounts and adds E2E_SETUP_ADMIN_EMAIL / E2E_GUEST_EMAIL as GitHub Actions secrets.

NOT executed against staging: none of these assertions has been run against staging (no secrets locally). Verified only via lint, typecheck, Jest (147 suites), and `playwright test --list` (15 tests / 11 files).

## Files
- `tests/e2e/guest-invitation.spec.ts` (B1): re-claim from same session now asserts 201 + `alreadyClaimed`, `invitationId`, `guest.userId`. Relied on migration `20260805000001_guest_invitation_flow.sql` step 4 (~lines 131-139, idempotent already_claimed return) before the step-6 ALREADY_CLAIMED raise, and step 9 (~line 170, clerk_id set); handler `app/api/invitations/handler.ts:658-666` returns 201. Added failure case: schema-valid unknown token (`generateResponseToken()`) -> exactly 404 (migration step 2 NOT_FOUND).
- `tests/e2e/support/fixtures.ts` (N1): `resetDisposablePersona` guard now throws only for the stable fixture users (adminUserId/memberUserId) or an admin of FIXTURE.churchGroupId; member/guest rows in the fixture group are deleted, so a crashed Test B does not poison the next run. Comment updated.
- `tests/e2e/week-setup-flow.spec.ts` (N2, B2): `expect(joinerName).toBeTruthy()`; roster slot located via `[class*="rosterSlot"]` filtered by `has:` exact-name child, with `toHaveCount(1)`. Header comment reworded to state only the dependency.

Tester focus: guard ordering in resetDisposablePersona; unknown-token 404.
