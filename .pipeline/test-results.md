# Test Results — Issue #61: Google Calendar OAuth connect/disconnect

This overwrites the stale `test-results.md` for issue #58 that was still
sitting at this path (per AGENTS.md, `.pipeline/` files reflect only the most
recent run).

## Summary

**PASS.** All verification commands are clean and the coder's claims in
`.pipeline/changes.md` hold up under independent re-verification. One gap the
coder itself named in changes.md ("What the Tester should focus on") — the
disconnect handler's `decryptToken`-throws path had no test forcing it — has
been filled in with a new test file; it passes, along with one additional
independently-chosen failure case for the callback route.

## Commands re-run independently

- `bun run lint` — clean, 0 errors / 0 warnings.
- `bun run typecheck` (`tsc --noEmit`) — clean.
- `bun run test` — **64 suites / 767 tests pass** (63 suites / 765 tests from
  the coder's existing work, plus 1 new suite / 2 new tests added by this
  stage).
- `bun run check:service-role` — OK, no service-role key references outside
  comments in `app/` or `lib/`.
- `bun run check:workflows` — OK (not a workflow-script change; re-run for
  parity with the coder's own verification claims).

## Independent code read

Read `lib/google-calendar/token-crypto.ts`, `lib/google-calendar/oauth.ts`,
and all three handlers (`app/api/google-calendar/{connect,callback,disconnect}/handler.ts`)
line-by-line against `.pipeline/spec.md`. Confirmed:

- `token-crypto.ts`: key is read from `TOKEN_ENCRYPTION_KEY`, base64-decoded,
  and rejected unless exactly 32 bytes; error messages never include the key
  value (`"TOKEN_ENCRYPTION_KEY is not set"` /
  `"TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes"` — both static).
  `encryptToken` uses a fresh random 12-byte IV per call and joins
  `iv:authTag:ciphertext` (all base64) with `:`. `decryptToken` splits on
  `:`, requires exactly 3 non-empty parts, and lets `setAuthTag`/`final()`
  throw naturally on tampering — matches spec.
- `oauth.ts`: `CALENDAR_EVENTS_SCOPE` is exactly
  `https://www.googleapis.com/auth/calendar.events` (write-only, no
  `calendar`/`calendar.readonly`). `getAuthUrl` throws if `GOOGLE_CLIENT_ID`
  or `GOOGLE_REDIRECT_URI` is unset, and includes `access_type=offline` +
  `prompt=consent` + `state`. `exchangeCode` throws on non-ok response and on
  a response missing `refresh_token` (before ever returning a partial
  `GoogleTokens` object), maps `expires_in` seconds to an ISO `expiryDate`.
  `revokeToken` is wrapped so neither a non-2xx response nor a rejected
  `fetch` ever propagates — confirmed via the `try/catch` around the whole
  body, and its only `console.warn` calls are static strings with no token
  interpolated in.
- `connect/handler.ts`: `requireAuth` first (so the state cookie is only ever
  set for authenticated callers); cookie is `httpOnly: true, secure: true,
  sameSite: "lax", path: "/", maxAge: 600`, exactly as spec'd; `ApiException`
  maps to its own status/code, anything else (including a thrown
  `getAuthUrl`, e.g. missing env) maps to 500 `INTERNAL`.
- `callback/handler.ts`: never returns JSON — always
  `NextResponse.redirect`, and the state cookie is deleted in every returned
  path (`redirectError`/`redirectConnected` both call `cookieStore.delete`
  before building the response). Order matches spec exactly: auth → `?error=`
  → missing `code`/`state` → CSRF cookie check → `exchangeCode` → encrypt →
  JWT → upsert. The whole body is additionally wrapped in an outer
  `try {...} catch { return redirectError(); }`, so even an unexpected throw
  (e.g. `encryptToken` failing on a bad key) still redirects rather than
  crashing or returning a 500 — this is the belt-and-suspenders behavior
  changes.md describes, and I independently verified it by forcing
  `encryptToken` to throw for real (see below).
- `disconnect/handler.ts`: no-row case short-circuits to
  `ok({ disconnected: true })` before any revoke/delete; when a row exists,
  `decryptToken` + `revokeToken` are wrapped in their own inner `try/catch`
  so a decrypt failure can never block the subsequent `DELETE`; delete errors
  map to 500 `INTERNAL`; the `DELETE` is scoped with `.eq("user_id",
  ctx.userId)`, matching the RLS-scoping intent from the spec.

Also confirmed via `grep -rn "console\." app/api/google-calendar
lib/google-calendar` that the only two `console.*` calls in any new/modified
file are the two static `console.warn` strings in `oauth.ts`'s `revokeToken`
— no token or key value is ever interpolated into a log call anywhere in
this feature.

## Independent read of the coder's existing tests

Read all five existing test files
(`tests/unit/lib/google-calendar/token-crypto.test.ts`,
`tests/unit/lib/google-calendar/oauth.test.ts`, and the three
`tests/unit/app/api/google-calendar-{connect,callback,disconnect}-route.test.ts`
files). Coverage matches what `changes.md` claims — round-trip encryption,
distinct-IV-per-call, tampered/malformed ciphertext, missing/short key
(including a "key never appears in the error message" assertion),
`getAuthUrl`'s scope/access_type/prompt/state and missing-env-var throws,
`exchangeCode`'s happy path + non-ok + missing-refresh_token + missing-env
cases, `revokeToken`'s three never-throws cases, connect's 401/200/500
cases (including asserting the state in the cookie matches the state in the
returned `authUrl`), callback's full redirect-target matrix (unauthenticated,
`?error=`, missing code/state, CSRF mismatch, missing cookie, exchange
failure, upsert success with encrypted-value assertions, upsert error), and
disconnect's 401 (both no-Clerk-id and no-JWT), success+revoke+delete,
idempotent-no-row, revoke-fails-but-succeeds, select-error, and delete-error
cases. No discrepancies found between the code and what these tests assert.

## Independent test coverage added

`changes.md`'s own "What the Tester should focus on" section named this gap
explicitly: "confirm this holds even if `decryptToken` itself throws (e.g. a
corrupted `refresh_token_encrypted` value), which the handler's inner
try/catch is intended to cover but has no spec-named edge case forcing it."
The existing disconnect test suite only ever calls `decryptToken` on values
produced by the real `encryptToken`, so that specific throw path was never
actually exercised — it's a materially different behavior than "revoke
returns ok:false" or "fetch rejects", since here decryption itself fails
before any token value exists to hand to `revokeToken`.

Added `tests/unit/app/api/google-calendar-tester-supplement.test.ts` with:

1. **Disconnect — corrupted stored ciphertext**: stubs a stored row whose
   `refresh_token_encrypted` is not valid `iv:authTag:ciphertext` ciphertext,
   so the real `decryptToken` throws (not mocked). Asserts the handler still
   returns 200 `{ disconnected: true }`, the row is still deleted
   (`DELETE ... WHERE user_id = <caller>`), and — since decryption failed
   before a token value existed — `revokeToken` is never called at all (a
   stronger assertion than "called and its failure ignored").
2. **Callback — encryption key failure at encrypt time**: deletes
   `TOKEN_ENCRYPTION_KEY` so the real `encryptToken` throws inside the
   handler's try block, after a successful (mocked) `exchangeCode`. Confirms
   the handler still redirects to `/profile?calendar=error` (never a JSON
   500 — this route is a browser redirect target and must never return JSON)
   and never reaches `getSupabaseClient`, i.e. no partial row can be
   written. This independently verifies spec edge case #9 ("Missing/invalid
   TOKEN_ENCRYPTION_KEY ... callback redirects to error") at the point in the
   flow (encrypt, not decrypt) where it's actually most likely to occur.

Both new tests pass against the current implementation with no code changes
required; they were run standalone and as part of the full suite.

## Failure cases exercised

Per the pipeline contract's requirement to cover at least one failure case,
the following were confirmed (both pre-existing in the coder's suite and
newly added by this stage):

- `exchangeCode` throwing (non-ok token endpoint response) is caught by
  callback's outer `try/catch` and redirects to error without ever calling
  `getSupabaseClient` (pre-existing test, re-run and confirmed).
- A Supabase upsert error redirects to error rather than silently reporting
  success (pre-existing test, re-run and confirmed).
- A Supabase select/delete error in disconnect maps to 500 `INTERNAL`
  (pre-existing tests, re-run and confirmed).
- `encryptToken` throwing mid-callback (missing `TOKEN_ENCRYPTION_KEY`) still
  redirects to error rather than crashing or returning JSON (new test, this
  stage).
- `decryptToken` throwing mid-disconnect (corrupted stored ciphertext) still
  completes the delete and returns success, never calling `revokeToken` with
  a bad value (new test, this stage).

- Malformed/non-JSON POST body → 400 VALIDATION_FAILED (via `req.json()`
  rejecting, caught by `.catch(() => null)` then failing Zod parse).
- Non-uuid `userId` → 400 VALIDATION_FAILED (Zod `.uuid()` constraint).
- Unconfirmed member (no accepted invitation) → 422 VALIDATION_FAILED.
- Already-assigned member → 409 CONFLICT.
- Cross-tenant/missing event → 404 NOT_FOUND on both endpoints, without
  leaking state via a subsequent query.
- Every Supabase `.error` branch on both endpoints → 500 INTERNAL.

No failures found. Nothing was patched around — the implementation matched
the spec on every point checked, and the one coverage gap the coder itself
flagged in changes.md is now closed with a real (non-mocked) throw of
`decryptToken`/`encryptToken`, plus one additional independently-chosen edge
case. Ready for Review.
