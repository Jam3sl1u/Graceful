# Spec — Issue #32: API auth-matrix tests for Sprint 0–1 routes

## OPEN QUESTIONS (read first)

1. **`DELETE /api/church-group/members/:id` is a 501 stub, not a real route.**
   `app/api/church-group/members/[id]/route.ts` returns `notImplemented(...)` (HTTP
   501, code `NOT_IMPLEMENTED`) with zero auth or validation logic. That route is
   backlog #19 / GitHub #28 (Remove/archive member), which #32 lists as a blocker.
   Because it has no auth/validation code, the full four-case matrix
   (admin-2xx / member-403 / unauth-401 / malformed-400) **cannot** be written for it.
   **This spec assumes:** keep #32 unblocked by pinning the current 501 behavior
   under test (task T4) and defer the real matrix to when #28 lands. If the pipeline
   owner instead wants #32 to block until #28 is implemented, stop and say so. Do NOT
   implement the removal feature here — it is out of scope for a test issue.

2. **Real JWT signing is NOT wanted here.** The issue says "mint fake Clerk JWTs,"
   but the established unit-test pattern in this repo mints role identity by mocking
   `@clerk/nextjs/server`'s `auth()` and injecting a `UserLookup` — no signing, no
   secret. The `checks` CI job has no `SUPABASE_JWT_SECRET`, so real signing would
   break CI. The harness in T2 MUST follow the existing mock pattern. Real signed
   JWTs live only in the separate RLS suite (`tests/integration/rls/jwt.ts`) and are
   out of scope. If you believe real signing is required, stop and ask.

## Scope

The routes enumerated by #32 as #24–#31 are the eight Sprint-1 feature routes =
backlog rows #15–#22 (GitHub numbers are offset +9 from the backlog doc; backlog #23
"auth-matrix tests" == GitHub #32). Sprint 0 produced no user-facing feature routes;
its only auth surface is `lib/api/auth.ts`, already covered by
`tests/unit/lib/api/auth.test.ts`. **Do NOT** add tests for `app/api/health` or
`app/api/webhooks/*` — outside the #24–#31 enumeration and outside this issue.

## Current state (VERIFIED — do NOT redo or modify these)

Every implemented Sprint-1 route already has full auth-matrix coverage under
`tests/unit/app/api/`. These tests pass and are thorough. Leave every assertion in
them untouched.

| GitHub | Route | Existing test file | Matrix status |
|---|---|---|---|
| #24 | `PUT /api/church-group` | `church-group-route.test.ts` | 401 ✓, 400 ✓, success ✓ (any authed user creates → 403 N/A) |
| #25 | `POST /api/church-group/join` | `church-group-join-route.test.ts` | 401 ✓, 400 ✓, success ✓ (not admin-gated → 403 N/A) |
| #26 | `GET /api/church-group/members` | `church-group-members-route.test.ts` | 401 ✓, guest→403 ✓, success ✓ (GET, no body → 400 N/A) |
| #27 | `PATCH /api/church-group/members/:id/role` | `church-group-members-role-route.test.ts` | 401 ✓, non-admin→403 ✓, 400 ✓, admin-success ✓ |
| #28 | `DELETE /api/church-group/members/:id` | **none** | **STUB (501) — see Open Question 1 + T4** |
| #29 | `GET /api/church-group/audit-log` | `audit-log-route.test.ts` | 401 ✓, non-admin→403 ✓, 400 ✓, admin-success ✓ |
| #30 | `GET/PUT /api/profile` | `profile-route.test.ts` | 401 ✓, 400 ✓, success ✓ (self-scoped → 403 N/A) |
| #31 | instruments `GET/POST`, `/custom`, `/:id/promote`, `DELETE /:id` | `instruments-route.test.ts` | 401 ✓, non-admin→403 ✓, 400 ✓, admin-success ✓ |

Acceptance-criteria status going in:
- **"tests run in CI and block merge on failure": already met.** `.github/workflows/ci.yml`
  runs `bun run test` (Jest) on every `pull_request`.
- **"every route tested with the 4 cases": met for #24–#27, #29–#31.** Only gap is #28 (a stub).
- **"coverage report shows these routes covered": NOT met.** `jest.config.ts` collects no
  coverage. This is new work (T1).
- **Implementation Note "reusable harness that mints fake role identities":** the pattern
  exists but is copy-pasted per file, not shared. New work (T2 + T3).

The real deliverables for this issue are therefore: coverage reporting (T1), a shared
reusable harness (T2) with a real consumer (T3), and pinning the #28 stub (T4).

## Tasks

### T1 — Add coverage reporting scoped to the Sprint-1 API routes (AC: coverage report)

**Modify `jest.config.ts`** (existing unit config at repo root). Add these fields to
the exported `config` object; keep everything already there unchanged:

```ts
collectCoverageFrom: [
  "app/api/church-group/**/*.ts",
  "app/api/profile/**/*.ts",
  "app/api/instruments/**/*.ts",
  "lib/api/**/*.ts",
],
coveragePathIgnorePatterns: ["<rootDir>/node_modules/"],
coverageDirectory: "<rootDir>/coverage",
coverageReporters: ["text-summary", "lcov"],
```

Do NOT add a `coverageThreshold`. A failing threshold would break unrelated PRs;
report-only is the safe default for this issue.

**Modify `package.json`** — add one script next to the existing `"test": "jest"`:

```json
"test:coverage": "jest --coverage"
```

Use Bun wording only; never reference npm/yarn/pnpm anywhere.

**Modify `.github/workflows/ci.yml`** — in the `checks` job, change the existing step
`- run: bun run test` to `- run: bun run test:coverage` so CI emits the coverage
report (text-summary in the logs). Leave every other CI step and both other jobs
(`check-secrets`, `rls-integration`) untouched.

**Modify `.gitignore`** — add `/coverage` if not already ignored (check first; do not
duplicate an existing entry).

### T2 — Create the shared, reusable auth-matrix harness (AC: reusable harness)

Create **`tests/support/api-auth.ts`**. This centralizes the Clerk-auth + role-lookup
mock boilerplate currently copy-pasted across the per-route test files, so future
sprints import instead of re-implement.

It must export exactly:

```ts
import type { NextRequest } from "next/server";
import type { AuthContext, UserLookup } from "@/lib/api/auth";
import type { UserRole } from "@/types/domain";

// Injectable lookup returning a fixed AuthContext for the given role.
// Mirrors the makeLookup() duplicated in the existing handler tests.
export function makeLookup(role: UserRole, overrides?: Partial<AuthContext>): UserLookup;

// Configure the module-mocked auth() (from "@clerk/nextjs/server") as a signed-in
// Clerk user whose supabase JWT is `jwt` (default a non-empty string; pass null to
// simulate "session present but no JWT issued"). The consuming test file MUST have
// `jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }))` at top so the
// auth import here resolves to that mock.
export function mockClerkAuthed(jwt?: string | null): void;

// Configure the module-mocked auth() as NO Clerk session (userId: null, getToken jest.fn()).
export function mockClerkAnonymous(): void;

// Build a NextRequest whose .json() resolves `body` (pass nothing / undefined to
// simulate a malformed/empty body).
export function makeJsonReq(body?: unknown): NextRequest;
```

Implementation constraints:
- Import `auth` from `@clerk/nextjs/server` and cast to `jest.Mock` internally; the
  helpers call `.mockResolvedValue(...)` on it. Match the exact resolved shapes used
  in `tests/unit/app/api/service-weeks-route.test.ts` (`setUpAuth`, `makeLookup`,
  `makeReq`) so behavior is identical: authed = `{ userId: "clerk_test", getToken:
  jest.fn().mockResolvedValue(jwt) }`; anonymous = `{ userId: null, getToken: jest.fn() }`.
- Default fixed IDs: `userId: "user-1"`, `churchGroupId: "group-1"` (overridable via
  `overrides`), matching the existing tests.
- **Do NOT** rewrite, migrate, or delete any existing test file. This module is
  additive.
- No real JWT signing (see Open Question 2).

### T3 — Add one consolidated auth-matrix pass that consumes the harness (AC: dedicated pass + real consumer)

Create **`tests/unit/app/api/auth-matrix.test.ts`**. This is the "dedicated test pass
over everything built so far" the issue describes, written against the harness so the
pattern is demonstrably reusable. It complements — does not replace — the deep
per-route tests.

Top of file (hoisted, required for the harness to bind the mock):
```ts
jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase/client", () => ({ getSupabaseClient: jest.fn() }));
```

Cover the **admin-only, handler-style** Sprint-1 routes (those exporting a testable
handler that takes an injected `UserLookup`). For each, assert the applicable matrix
cells using `mockClerkAuthed` / `mockClerkAnonymous` / `makeLookup` / `makeJsonReq`
from `tests/support/api-auth.ts`:

- `patchMemberRole` — `@/app/api/church-group/members/[id]/role/handler` (#27)
- `getAuditLog` — `@/app/api/church-group/audit-log/handler` (#29)
- `addInstrument`, `promoteInstrument`, `deleteInstrument` — `@/app/api/instruments/handler` (#31)
- `getChurchGroupMembers` — `@/app/api/church-group/members/handler` (#26, admin-vs-guest gating)

Matrix cells per route (only those that apply to that route’s shape):
- **unauth → 401 `UNAUTHENTICATED`**: `mockClerkAnonymous()`, then call the handler
  with a lookup that must never be consulted (assert 401).
- **disallowed role → 403 `FORBIDDEN`**: `mockClerkAuthed()`, `makeLookup("member")`
  (use `"guest"` for `getChurchGroupMembers`), assert 403.
- **malformed input → 400 `VALIDATION_FAILED`**: only for routes with a request body
  (`patchMemberRole`, `addInstrument`). `mockClerkAuthed()`, `makeLookup("admin")`,
  `makeJsonReq(null)`, assert 400.
- **admin success**: `mockClerkAuthed()`, `makeLookup("admin")`, assert 2xx. Supply the
  minimal Supabase mock the handler needs.

Critical: **call each handler with EXACTLY the argument arity its existing per-route
test uses** (e.g. `promoteInstrument(req, id, lookup)`, `getAuditLog(req, lookup)`).
Copy the argument order and the chainable/RPC Supabase mock shapes directly from the
matching existing file listed in the table above — do not invent new mock shapes.
Route-export routes (#24 `PUT`, #25 `POST /join`) are already fully covered by their
existing files and are not admin-gated; do NOT duplicate them here.

`beforeEach` must `mockReset()` the `auth` and `getSupabaseClient` mocks, same as the
existing files.

### T4 — Pin the #28 stub route under test

Create **`tests/unit/app/api/church-group-members-id-route.test.ts`**.

- Import `{ DELETE }` from `@/app/api/church-group/members/[id]/route`.
- The current handler takes only `_req` (no `params`). Call it as
  `DELETE({} as unknown as NextRequest)` and assert the resolved `Response`:
  - `res.status === 501`
  - `(await res.json()).code === "NOT_IMPLEMENTED"`
- Add a top-of-file comment: this route is issue #28 (Remove/archive member), still a
  stub; replace with the full auth matrix (admin success / member→403 / unauth→401 /
  malformed→400) once #28 is implemented.
- No Clerk/Supabase mocking needed — the stub short-circuits before any auth.
  `@/lib/api/response` imports `server-only`, which `jest.config.ts` already maps to
  `tests/mocks/server-only.js`, so the import resolves under the node test env.

## Edge cases / invariants the implementation MUST hold

- `bun run test` and `bun run test:coverage` must both pass locally and in CI.
- The coverage report must list all eight #24–#31 route files (plus `lib/api/*`) with
  non-zero coverage. T4 is what makes `members/[id]/route.ts` register.
- Do NOT weaken, delete, or rewrite any assertion in the existing test files.
- Do NOT introduce real network calls or real JWT signing (Open Question 2).
- The new consolidated test (T3) must not reduce or contradict existing coverage; if a
  handler's real arity/behavior differs from an assumption here, follow the existing
  per-route test as the source of truth and adjust.
- `bun run typecheck` and `bun run lint` must stay green — new test + config + support
  files must be typed and lint-clean (no unused exports/vars).

## Patterns to copy (name the file)

- Harness mock shapes (`setUpAuth`, `makeLookup`, `makeReq`, chainable Supabase mock):
  `tests/unit/app/api/service-weeks-route.test.ts` and
  `tests/unit/app/api/instruments-route.test.ts` (most complete references).
- Route-export test that mocks `auth()` + `getSupabaseClient` directly:
  `tests/unit/app/api/church-group-route.test.ts`.
- Auth seam (`AuthContext`, `UserLookup`, `requireAuth`, `requireRole`): `lib/api/auth.ts`.
- Response/error contract (`ok`, `fail`, `notImplemented`): `lib/api/response.ts`;
  error codes incl. `NOT_IMPLEMENTED`: `lib/api/errors.ts`.
- Jest config shape (`roots`, `testMatch`, `moduleNameMapper` for `server-only` and
  `@/`): `jest.config.ts`.

## Files touched (summary)

- Modify: `jest.config.ts` — coverage config (T1)
- Modify: `package.json` — add `test:coverage` script (T1)
- Modify: `.github/workflows/ci.yml` — `checks` job: `bun run test` → `bun run test:coverage` (T1)
- Modify: `.gitignore` — ignore `/coverage` if not already (T1)
- Create: `tests/support/api-auth.ts` — reusable harness (T2)
- Create: `tests/unit/app/api/auth-matrix.test.ts` — consolidated matrix pass (T3)
- Create: `tests/unit/app/api/church-group-members-id-route.test.ts` — pin #28 stub (T4)
