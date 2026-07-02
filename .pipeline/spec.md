# Spec — Issue #15: JWT verification + role-check middleware

## OPEN QUESTIONS (non-blocking — decisions made below, flag if you disagree)

1. **The `users` table (#16) does not exist yet.** `supabase/migrations/` contains only
   `.gitkeep`, and `lib/supabase/client.ts` is a stub that throws. The acceptance criteria
   say role must be read from the `users` table "not just the JWT claim." We cannot query a
   table that isn't built, and creating it is issue #16's job (out of scope here).
   **Decision:** introduce a thin, injectable lookup seam (`UserLookup`) so the middleware's
   contract and unit tests land now, and the real DB query is dropped in when #16 lands. The
   real query is stubbed to throw a clear "pending #16" error; unit tests inject a fake
   lookup. This is the same stub-and-seam pattern already used across `lib/` in this repo.
   If the pipeline owner would rather block this issue until #16 merges, stop here.

2. Everything else is unambiguous. No invented requirements below.

---

## Scope

Implement the two existing stubs in `lib/api/auth.ts` (`requireAuth`, `requireRole`) plus a
lookup seam, and unit-test all four roles against an admin-only route. API-layer only. NOT in
scope: RLS (#22), rate limiting (#76), wiring middleware.ts enforcement, the `users` migration
(#16), or converting existing stub routes.

## Existing patterns to follow (do not deviate)

- Error type: `ApiException(message, code, status)` from `lib/api/errors.ts`. `ErrorCode.UNAUTHENTICATED` and `ErrorCode.FORBIDDEN` already exist.
- Response envelope + `fail()`: `lib/api/response.ts`.
- Role type: `UserRole = "admin" | "set_leader" | "member" | "guest"` from `types/domain.ts`. Use this; do not redefine.
- `AuthContext` type already declared in `lib/api/auth.ts` — keep its shape: `{ userId, churchGroupId, role }`.
- Every server file starts with `import "server-only";`.
- Unit test style: copy `tests/unit/lib/api/response.test.ts` (Jest `describe`/`it`, `@/` path alias). Tests live under `tests/unit/**/*.test.ts` (see `jest.config.ts` `testMatch`). `server-only` is auto-mocked via `tests/mocks/server-only.js`.

---

## Files to modify

### 1. `lib/api/auth.ts` (rewrite the two stub bodies + add lookup seam)

Keep the existing `AuthContext` type. Implement:

```ts
import "server-only";
import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { ApiException, ErrorCode } from "@/lib/api/errors";
import type { UserRole } from "@/types/domain";

export type AuthContext = {
  userId: string;        // internal users.id (uuid), NOT the Clerk id
  churchGroupId: string;
  role: UserRole;
};

// Lookup seam — real impl added when #16 (users table) lands. Injected in tests.
export type UserLookup = (clerkId: string) => Promise<AuthContext | null>;

// requireAuth: verify the Clerk JWT, then resolve the DB-backed AuthContext.
// `lookup` defaults to the real (currently pending) DB lookup; tests pass a fake.
export async function requireAuth(
  _req: NextRequest,
  lookup: UserLookup = lookupUserByClerkId,
): Promise<AuthContext>;

export function requireRole(ctx: AuthContext, roles: UserRole[]): void;
```

Behaviour:

- `requireAuth`:
  1. Call Clerk `const { userId: clerkId } = await auth();` (App Router server helper). If `clerkId` is null/undefined → `throw new ApiException("Authentication required", ErrorCode.UNAUTHENTICATED, 401)`.
  2. `const ctx = await lookup(clerkId);`. If `null` (authenticated Clerk user with no matching `users` row) → `throw new ApiException("Authentication required", ErrorCode.UNAUTHENTICATED, 401)`. (No user record ⇒ cannot authorize ⇒ treat as unauthenticated, not 403.)
  3. Return `ctx`.
  - Note the `req` arg is retained for signature stability / future use even though Clerk `auth()` reads request context ambiently. Do not remove it.

- `requireRole(ctx, roles)`:
  - If `roles.includes(ctx.role)` → return (void).
  - Else → `throw new ApiException("Insufficient permissions", ErrorCode.FORBIDDEN, 403)`.
  - `roles` is an array so callers can allow multiple (e.g. `["admin", "set_leader"]`).

- `lookupUserByClerkId` (the default real lookup): a `UserLookup` that currently throws `new Error("user lookup not implemented — blocked on #16 (users table) / #7-14 (supabase client)")`. Keep it internal (not exported) or export it — either is fine, but it must be the default arg. Add a `// TODO(#16): SELECT id, church_group_id, role FROM users WHERE clerk_id = $1` comment describing the real query (maps clerk_id → AuthContext per PRD §20.3 `users` table).

Import note: import `ApiException` and `ErrorCode` from `@/lib/api/errors` (both are exported there).

### 2. `lib/clerk/server.ts` — LEAVE AS-IS.

Do not implement `getAuthContext` here; it is a separate concern (session-claim reader, #5/#6) and not required by this issue. Touching it risks scope creep.

---

## Files to create

### 3. `app/api/_examples/admin-only/route.ts` (test fixture route)

An admin-only route used only to exercise the middleware end-to-end in unit tests. Keep it
minimal and clearly marked as an example.

```ts
import { NextRequest } from "next/server";
import { requireAuth, requireRole, type UserLookup } from "@/lib/api/auth";
import { ok, fail } from "@/lib/api/response";
import { ApiException, ErrorCode } from "@/lib/api/errors";

// Example admin-only route — demonstrates the requireAuth + requireRole pattern
// every Sprint 1–4 endpoint will copy. Exists primarily for #15 unit tests.
export async function GET(req: NextRequest, lookup?: UserLookup) {
  try {
    const ctx = await requireAuth(req, lookup);
    requireRole(ctx, ["admin"]);
    return ok({ ok: true });
  } catch (err) {
    if (err instanceof ApiException) return fail(err.message, err.code, err.status);
    return fail("Internal error", ErrorCode.INTERNAL, 500);
  }
}
```

- The optional `lookup` param is a test seam mirroring `requireAuth`. It is NOT part of the Next.js route contract (Next passes only `(req, { params })`); in production `lookup` is `undefined` and the real default is used. This keeps the fixture testable without a real DB.
- `_examples` prefix (underscore) keeps it out of any future route-convention sweeps and signals it is not a product endpoint.

---

## Tests to create

### 4. `tests/unit/lib/api/auth.test.ts`

Cover `requireAuth` + `requireRole` directly:

- Mock Clerk: at top of file, `jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));` then import `auth` and cast, e.g. `const mockAuth = auth as jest.Mock;`. Reset in `beforeEach`.
- `requireAuth` throws `ApiException` with `code === "UNAUTHENTICATED"` and `status === 401` when `auth()` returns `{ userId: null }`.
- `requireAuth` throws 401 UNAUTHENTICATED when Clerk `userId` is set but the injected `lookup` returns `null`.
- `requireAuth` returns the `AuthContext` from the injected `lookup` when Clerk `userId` is set and lookup resolves a user.
- `requireRole` returns void (does not throw) when `ctx.role` is in the allowed list.
- `requireRole` throws `ApiException` with `code === "FORBIDDEN"` and `status === 403` when `ctx.role` is not allowed.
- Assert on thrown error via `await expect(...).rejects.toMatchObject({ code, status })` or a try/catch with `instanceof ApiException`.

### 5. `tests/unit/app/api/admin-only-route.test.ts`

This satisfies the acceptance criterion "Unit tests cover all four roles against an admin-only route." Import the `GET` from `app/api/_examples/admin-only/route.ts`.

- Mock `@clerk/nextjs/server` `auth` to return a fixed authenticated `{ userId: "clerk_test" }`.
- Build a fake `UserLookup` factory that returns an `AuthContext` with a given `role`.
- Table-driven test over all four roles:
  - `admin` → response `status === 200`, body `{ data: { ok: true } }`.
  - `set_leader` → `status === 403`, body `code === "FORBIDDEN"`.
  - `member` → `status === 403`, `code === "FORBIDDEN"`.
  - `guest` → `status === 403`, `code === "FORBIDDEN"`.
- One additional case: `auth()` returns `{ userId: null }` → `status === 401`, `code === "UNAUTHENTICATED"` (lookup never consulted).
- Read the response via `res.status` and `await res.json()` exactly like `tests/unit/lib/api/response.test.ts`.

---

## Edge cases the implementation must handle

- Clerk `auth()` returns `userId: null` (unauthenticated) → 401, before any lookup.
- Authenticated Clerk user with no `users` row → 401 (not 403). Documented rationale above.
- `requireRole` called with a multi-role allow-list → any match passes.
- Non-`ApiException` errors bubbling out of a handler → the route's `catch` maps to 500 `INTERNAL` (see fixture). Do not let a raw error escape as an unhandled 500 with a stack.
- `requireAuth` must not perform the DB lookup before confirming the JWT is valid (auth check strictly precedes lookup — avoids unauthenticated DB hits).

## Definition of done

- `npm run typecheck` passes.
- `npm test` passes, including the two new test files.
- No changes to `middleware.ts`, `lib/supabase/*`, `lib/clerk/server.ts`, or any existing route.
- `lib/api/auth.ts` no longer throws "not implemented"; `lookupUserByClerkId` remains the single point that is intentionally deferred to #16.
