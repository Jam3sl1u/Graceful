# Review — Issue #24: Implement church group creation

## VERDICT: BLOCK

The route, schema, and types are well-built and match the spec. But the core
SQL migration — the atomic bootstrap the whole feature depends on — contains a
runtime bug that makes church-group creation fail on **every** call. Green unit
tests hid it because they mock the Supabase RPC and never execute the SQL, and
no live-DB integration test was run.

## Blocking issue (must fix)

**`supabase/migrations/20260705000001_church_group_create_fn.sql:53` — unqualified
`gen_random_bytes(1)` fails under `set search_path = ''`.**

`create_church_group` is declared `security definer set search_path = ''`. With an
empty search_path only `pg_catalog` is implicitly searched. `gen_random_bytes()`
is a **pgcrypto** function, not a `pg_catalog` builtin (unlike `gen_random_uuid()`,
which moved to core in PG13 and is why the table-default usage works). So the
unqualified call cannot resolve.

I verified this empirically against Postgres 16 with pgcrypto installed:

    ERROR:  function gen_random_bytes(integer) does not exist
    CONTEXT: PL/pgSQL function public.t() line 4 at assignment

Schema-qualifying it (`public.gen_random_bytes(1)` / `extensions.gen_random_bytes(1)`)
resolves correctly.

Impact: the raised error is SQLSTATE `42883` (`undefined_function`), which is NOT
`unique_violation`, so it escapes the retry `begin…exception` block, aborts the
function, and the route maps it to **500 INTERNAL**. Church-group creation is
100% non-functional in any real environment. `check_function_bodies` does not
validate plpgsql bodies at `CREATE` time, so the migration "applies cleanly" —
false confidence.

### Fix
Schema-qualify the pgcrypto call at line 53. Note the schema is environment-dependent:
- This repo's `create extension if not exists "pgcrypto"` (cluster 1) has no
  `WITH SCHEMA`, so on a fresh DB it lands in `public` → `public.gen_random_bytes`.
- On Supabase (including `supabase start` local, which the `test:rls` suite targets)
  pgcrypto is pre-installed in the `extensions` schema and the `if not exists`
  no-ops, so there it is `extensions.gen_random_bytes`.

Confirm which schema pgcrypto actually resides in for the target Supabase env and
qualify accordingly (most likely `extensions.gen_random_bytes`). Then run the
`test:rls` integration suite against a live DB to prove the function executes end
to end — this bug is only catchable there, not in the mocked unit tests.

## Secondary issues (should fix, non-blocking)

1. **New tests are untracked, not committed.** `tests/unit/app/api/church-group-route.test.ts`
   and `tests/unit/schemas/church-group.test.ts` show as untracked in `git status`
   and are absent from `git diff main...HEAD`. As it stands the PR ships the feature
   with zero committed tests. Ensure they are committed with the change.

2. **No integration coverage was actually run.** The tester explicitly did not run
   `test:rls` (no DB available). Given the SQL bug above, this is precisely the gap
   that let a broken migration pass. The migration must be exercised against a live
   DB before ship.

## What is correct (verified)

- Route `PUT /api/church-group`: Clerk `auth()` (not `requireAuth`), defensive body
  parse, `safeParse` → 400, JWT check → 401, name/email derivation, RPC param
  mapping, `GR001` → 409, other errors → 500, `ok(data, 201)`. Matches spec and
  `admin-only` error-handling pattern.
- `createChurchGroupSchema`: field bounds match DB column widths (name/denomination
  varchar(100), timezone varchar(50)); IANA `.refine`; `America/Chicago` default.
  `.default()` before `.refine()` ordering is correct.
- `lib/supabase/types.ts`: `ChurchGroupsRow`/`InstrumentsRow`, Tables + Functions
  entries; typecheck green.
- Migration otherwise correct: all tables schema-qualified `public.*`, columns match
  the cluster 1/2 table definitions, `auth.jwt() ->> 'sub'` with `GR000`, GR001
  member guard before writes, 8-char code from the exact unambiguous alphabet,
  `unique_violation` retry loop, 9 correct instrument names, `is_default=true`,
  `created_by` = new user id, grant to `authenticated`, commented DOWN.
- `lint`, `typecheck`, `check:service-role` all pass; no service-role key referenced.

Fix the `gen_random_bytes` qualification, commit the tests, and prove it with the
live-DB RLS suite. Then this is a SHIP.
