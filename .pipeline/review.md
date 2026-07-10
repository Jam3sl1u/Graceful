# Review — Issue #27: Role assignment & multi-admin support

## VERDICT: SHIP

## Basis
This file previously recorded a correct **BLOCK** verdict against a prior
automated pipeline run that produced zero commits for #27 (Coder stage
no-op'd; both Tester and Reviewer independently caught spec/changes docs
describing #26, and later #33 after a merge, instead of #27, with the
`notImplemented` stub untouched). That BLOCK was the right call at the time.
This review covers the actual manual implementation that followed.

Reviewed `git diff main...HEAD -- app/api/church-group/members schemas/role.ts
tests/unit/app/api/church-group-members-role-route.test.ts` directly (not
just `changes.md`'s summary), re-ran `bun run typecheck` (clean),
`bun run lint` (clean), and `bun run test` (12 suites / 132 tests, 0
failures).

## Assessment against spec (`.pipeline/spec.md`)

- **`schemas/role.ts`**: `z.enum` over the exact 4 `UserRole` values, no
  scope creep beyond the issue's `{ role }` body shape.
- **`handler.ts`**: control flow matches spec's ordered list exactly.
  Confirmed by reading the file: `requireAuth` → `requireRole(["admin"])` →
  UUID-validate path id → zod-validate body → JWT/Supabase client → target
  lookup (404 on miss, scoped by `church_group_id`) → BR-12 conditional
  count check (422) → `update` → `writeAuditLog` → `ok()`. Every failure
  path maps to the status/code the spec specifies; the outer catch
  correctly reduces any `ApiException` to its own code/status and anything
  else to 500 `INTERNAL`.
- **BR-12 correctness**: the guard `target.role === "admin" && newRole !==
  "admin"` is the only path to the admin-count query, so promotions and
  same-role no-ops never pay for or trigger it — verified both by reading
  the code and by the "no admin-count query made" test asserting the mock's
  call count.
- **BR-03/BR-04 correctness**: no branch anywhere checks "is this the second
  admin" or similar — promoting to admin is unconditionally allowed once
  auth/role/validation/lookup pass, exactly as the issue requires ("no
  special-casing").
- **Self-demotion**: correctly unhandled as a distinct case — the BR-12
  guard reads `target.role`/group admin count only, never `ctx.userId`, so
  self-demotion automatically follows the same last-admin rule. Confirmed
  by the two self-demotion tests (422 as sole admin, 200 with a co-admin).
- **404-not-403 for missing/cross-group target**: correct design choice,
  documented, and covered by tests for both scenarios landing on the same
  code path.
- **Audit log**: `action: "user.role_changed"`, `entityType: "user"`,
  `metadata: { old_value, new_value }` — checked directly against
  `lib/audit/write-audit-log.ts`'s doc comment and its own test fixture, not
  just the issue text (which doesn't specify key names). Matches. A
  `writeAuditLog` failure correctly propagates as a 500 rather than being
  swallowed (verified by the dedicated test).
- **"Only route that writes `users.role`"**: true at the application layer —
  `requireRole(ctx, ["admin"])` is the sole gate. The design note in
  `changes.md` about `users_update_leader_admin` RLS being broader (permits
  `set_leader` too, at the DB layer) is accurate and correctly scoped as
  "not fixed here" — it's a pre-existing RLS gap unrelated to this route's
  correctness, not a regression this issue introduces.
- **Route/params handling**: matches the established Next 15 async-`params`
  convention (`app/api/instruments/[id]/route.ts`) exactly.

## Test quality
20 cases, all meaningful rather than tautological: every status-code
assertion is paired with a `code` field check; the BR-12/self-demotion cases
prove behavior via a rule that has no identity branch to special-case rather
than just asserting a hardcoded outcome; the promotion test's call-count
assertion would actually fail if the BR-12 branch were mistakenly entered.
No gaps found against the issue's acceptance criteria.

## Notes (not blockers)
- Coverage is unit-level with a mocked Supabase client, consistent with
  every other route in this codebase — no live-DB/RLS integration test
  exercises this specific route. This matches existing project convention
  (only #33's cross-tenant matrix uses the live-DB harness) and was not
  part of this issue's AC.
- The RLS column-granularity gap (`users_update_leader_admin` permits
  `set_leader` at the DB layer) is a legitimate follow-up but is correctly
  out of scope for this issue — flagged for a future ticket, not blocking.
- 16 pre-existing prettier formatting issues in files unrelated to this
  issue (brought in by the `origin/main` merge) were correctly left
  untouched rather than bundled into this change.

Green tests here reflect correct behavior against the actual #27
requirements. No correctness, security, or scope issues found.
