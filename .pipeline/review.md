# Review — Issue #76: Rate limiting on auth, SMS, and write endpoints

VERDICT: NEEDS WORK

Reviewed: `.pipeline/spec.md`, `.pipeline/changes.md`, `.pipeline/test-results.md`,
`git diff main...HEAD` (commit 9518e7b), plus the two untracked tester-supplement
files, plus the real call sites that consume these endpoints.

Independently re-run in this worktree:
- `bun run typecheck` — pass
- `bun run lint` — pass
- `bun run test` — pass, 86 suites / 1093 tests

## What is right

- `lib/api/rate-limit.ts` implements the spec faithfully: the exact `resolveTier`
  precedence order, anchored `^...$` / `[^/]+` regexes, trailing-slash + method-case
  normalization, the `${tier}:${identifier}` key, the fixed-window counter that
  increments on denial without sliding `windowStartMs`, the `Retry-After` +
  `{ error, code: "RATE_LIMITED" }` envelope matching `types/api.ts` `ApiError`,
  and the bounded-store prune.
- `middleware.ts` runs the limiter before `auth.protect()` and before the
  `isPublicRoute` check, so the public invitation-token endpoints are covered;
  `config.matcher` and `isPublicRoute` are untouched as required.
- No scope creep: nothing under `app/`, `schemas/`, `supabase/`; no new deps or
  env vars. No suspicious/unrelated content in the diff.
- The tests are genuine, not superficial: they exercise the N+1 denial, window
  rollover, the "denial does not extend the window" subtlety via `resetAtMs`
  equality, and a real end-to-end 429 through `middleware.ts`. The tester
  supplements correctly found and closed the two blind spots in the coder's
  suite (throwing `auth()`; tier-prefixed key built by `checkRequestRateLimit`).

## Required fixes

### 1. The tester stage's work is not committed (blocking for the PR)

`git status` in this worktree:
- untracked: `tests/unit/middleware-tester-supplement.test.ts`
- untracked: `tests/unit/lib/api/rate-limit-tester-supplement.test.ts`
- modified, uncommitted: `.pipeline/test-results.md`

Commit 9518e7b contains only the coder's files. If the branch is pushed as-is,
the PR ships **without** the only tests that cover spec edge case #6
(`await auth()` throwing must not 500 → IP fallback), the only test that would
catch dropping the `${tier}:` key prefix, and the only test that `auth.protect()`
is not reached on a denied request. Commit them (cf. the analogous
"Add tester supplement coverage..." commit on the #68 branch).

### 2. `auth` tier (10/min per IP) breaks the public invite-response flow, and a
### 429 there is rendered to the member as "invitation not found"

`app/(public)/invite/[token]/invite-response.tsx:76-84` treats **any** non-OK
response from `GET /api/invitations/respond/{token}` as
`setUnavailableReason("not-found")` → the "unavailable" screen. A 429 therefore
tells a legitimate member their invitation does not exist, with no retry path.
The lookup + the subsequent `POST .../accept` are both `auth` tier, i.e. 2 units
per responding member, against a **10/min bucket keyed by IP** for signed-out
users. A worship team responding from one church wifi (or any carrier CGNAT)
shares that bucket: past ~5 members per minute the rest get a false
"invitation unavailable". This is a realistic, user-visible regression of a core
Sprint-2 flow, and no test covers it because every test asserts the limiter, not
the flows behind it.

Fix (either is acceptable, the choice is a human's):
- raise `RATE_LIMIT_POLICIES.auth.limit` to something that survives a shared-NAT
  congregation (and/or bucket the respond-token lookup by token rather than IP), **and/or**
- add a 429-specific branch in `invite-response.tsx` (surface "too many attempts,
  try again in N seconds" from `Retry-After` instead of "not found") — if that is
  considered out of scope for #76, file it as a follow-up issue and say so.

### 3. `sms` tier (5/min) breaks per-member inviting from the week view

`app/(app)/week/[id]/week-view.tsx:274-300` invites **one member per POST**
(`+ Invite` button per roster row). Staffing a roster of more than 5 members
inside a minute 429s, and the BR-05 conflict path sends a second POST for the
same invite, so a couple of conflicts can exhaust the budget after 3 invites.
The user-visible result is the generic
`"Something went wrong sending the invitation. Please try again."`, and retrying
immediately just burns more budget. The same 5/min bucket is additionally shared
with `POST /api/setlists/{id}/publish` and `.../deny` for the same admin.

Fix: raise the invite/sms budget (or give invitation creation its own tier), or
get explicit human sign-off that 5/min across invite+deny+publish is intended.
The spec itself flagged these numbers as "a first pass meant to be tuned by a
human" — this review is that tuning point, not a rubber stamp.

## Recommended (non-blocking)

4. `middleware.ts:20-25` — `await auth()` now runs on **every** matched request,
   including all page navigations, which previously resolved no session on public
   routes. Since `resolveTier` returns `null` for non-`/api` paths, resolving the
   tier first and only calling `auth()` when the tier is non-null would avoid a
   per-navigation session resolution and would also make the "reject an
   unauthenticated flood cheaply" claim actually true (today the flood still pays
   the JWT verification before the limiter runs).
5. `lib/api/rate-limit.ts:92-106` — the identity for anonymous callers is derived
   entirely from client-supplied headers. First-hop `x-forwarded-for` is only
   trustworthy if the platform overwrites it; if it is ever appended, or the app
   is ever fronted by something else, the whole `auth` tier (the anti-brute-force
   point of this issue) is bypassable by rotating one header. Worth an explicit
   comment stating the trust assumption, and consider preferring the
   platform-set `x-real-ip`. Related: `ip:unknown` is a shared bucket, so a single
   caller sending header-less requests can exhaust the `auth`/`sms` budget for
   every other header-less caller.
6. `tests/unit/lib/api/rate-limit-tester-supplement.test.ts:65-77` — the
   "ignores the query string" test never constructs a query string
   (`req2 = { ...req1 }` is the same object shape, and the fake `nextUrl` has only
   `pathname`). It passes trivially and proves nothing about query strings; either
   put a `search`/`href` on the fake or rename it to what it actually asserts
   (two calls with the same pathname share a bucket).
7. `resolveTier` has no negative-precedence coverage: `HEAD`/`OPTIONS` → `read`,
   a non-`POST` verb on `/deny` or `/publish` → `write`, `PUT /api/setlists/{id}`
   not matching `SETLIST_PUBLISH_RE`, and the `/api` root. Cheap to add and they
   guard the ordering that matters most.
8. Store pruning at 10,000 keys is untestable through the public API (noted
   honestly by the tester). If it is ever worth asserting, export a size accessor
   behind the same test-only door as `resetRateLimitStore()`.

## Not blocking / accepted

- In-memory, per-instance counters (spec OQ #2) — documented limitation.
- `bun run build` failing at static generation on `Missing publishableKey` —
  independently reproduced as a pre-existing sandbox env gap on both branches;
  the middleware bundle compiles, so the `server-only` question is settled and
  the primary (non-fallback) branch was correctly taken.
- Clerk-hosted `/sign-in` / `/sign-up` not being throttled (spec OQ #1).
