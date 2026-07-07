# Review — Issue #24: Church group creation (`PUT /api/church-group`)

VERDICT: SHIP

## What I verified independently (not just trusting the summaries)
- Ran `git diff main...HEAD` and read every changed file.
- `bun run typecheck` — clean.
- `bun run lint` — clean.
- `bun run test` — 5 suites / 29 tests, all pass.
- Cross-checked the RPC's INSERT statements against the real table DDL in
  `supabase/migrations/20260702000001_cluster_1_organization.sql` and
  `20260702000002_cluster_2_instruments.sql`:
  - `church_groups(name, denomination, timezone, logo_url, invite_code)` column
    list and the `VALUES (p_name, p_denomination, p_timezone, p_logo_url, ...)`
    mapping line up correctly (no transposed columns — denomination/timezone are
    in the right slots).
  - `users(clerk_id, church_group_id, role, name, email)` matches.
  - `instruments(church_group_id, name, is_default, created_by)` matches;
    `created_by` is nullable in DDL, so `NULL` seed is valid.
  - Column length limits in the zod schema (name<=100, timezone<=50,
    denomination<=100) match the varchar sizes. `logo_url` is `text`, so the 2048
    cap is a self-imposed guard — fine.
- Confirmed `ok`/`fail` signatures and `ErrorCode.{CONFLICT,VALIDATION_FAILED,
  UNAUTHENTICATED,INTERNAL}` all exist and are used correctly; `fail` emits
  `{ error, code }`, which the tests assert against.
- Migration timestamp `20260706000001` sorts after the latest existing
  `20260704000002`. GRANT EXECUTE is present for `create_church_group` and
  correctly absent for `generate_invite_code`. Commented DOWN present.

## Correctness spot-checks
- Spec divergences are intentional and documented in the code (PUT-creates vs
  PRD §22.1 update; exactly 8 default instruments, no "Other" row). The 8 names
  and their order match the spec exactly.
- `USER_ALREADY_IN_GROUP` guard correctly prevents a user from creating a second
  group. `UNAUTHENTICATED` raised when `auth.jwt() ->> 'sub'` is null.
- SECURITY DEFINER + `SET search_path = ''` + schema-qualified refs throughout;
  runs as table owner so RLS INSERT gaps are bypassed as designed — no
  service-role key used (check:service-role passes).
- Route returns the RPC row directly via `ok(data, 201)`; since the function
  returns a single composite row (not SETOF), `data` is an object, matching the
  happy-path test assertion.

## Tests are meaningful, not superficial
The unit suite asserts the exact `rpc` argument object (param name mapping,
null coercion for optional fields), exact status codes, and error-code strings
for each branch (201/400x2/401x2/409/500) plus the "Admin" name fallback. These
would catch a real regression in param mapping or error routing.

## Non-blocking notes (do not block ship; track for the DB integration pass)
1. **Invite-code collision under concurrency**: the retry loop only re-checks
   `EXISTS` before insert; it does not catch a `unique_violation` from the
   `church_groups.invite_code` unique constraint if two transactions generate
   the same code between check and insert. Probability is ~1/31^8, but a clean
   `BEGIN/EXCEPTION WHEN unique_violation THEN retry` would be more robust. Spec
   explicitly describes the current loop approach, so this is acceptable.
2. **`random()` is not cryptographically secure**. Invite codes gate the future
   join-via-code flow (#25). 31^8 keyspace makes brute force impractical, and
   the spec prescribes this exact approach, but `gen_random_bytes`-based
   generation would be stronger. Flagging for a future hardening pass, not this
   issue.
3. **Error classification is substring-based** on `error.message`
   (`includes("USER_ALREADY_IN_GROUP")` / `includes("UNAUTHENTICATED")`), only
   verified against mocked error shapes. The live PostgREST error payload for a
   `RAISE EXCEPTION ... USING ERRCODE = 'P0001'` should be confirmed in the
   `tests/integration/rls/` pass. If it holds the message elsewhere than
   `.message`, the 409/401 mapping would silently fall through to 500.
4. **DB-level behavior unexecuted**: exact 8-instrument seeding, admin role,
   atomic rollback on partial failure are not run against a live Postgres in
   this environment. Correctly deferred to `tests/integration/rls/` per spec.

None of the above changes correctness for the merged unit-testable behavior.
The implementation faithfully matches the spec; tests are substantive.
