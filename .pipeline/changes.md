# Changes — Issue #61: Google Calendar OAuth connect/disconnect

Implements the connect / callback / disconnect plumbing only, per
`.pipeline/spec.md`. No event sync (that's #62), no calendar read scope, no
`googleapis` dependency, no migration/RLS changes.

## Files created

- **`app/api/google-calendar/connect/handler.ts`** — `connect(req, lookup?)`:
  `requireAuth`, generates a CSRF `state` via `randomBytes(32).toString("base64url")`,
  sets an httpOnly/secure/`sameSite: "lax"` `gcal_oauth_state` cookie (10 min
  maxAge) via `cookies()` from `next/headers`, returns `{ authUrl }` from
  `getAuthUrl(state)`. `ApiException` → mapped status/code; anything else
  (e.g. missing Google env vars) → 500 `INTERNAL`.

- **`app/api/google-calendar/callback/handler.ts`** — `callback(req, lookup?)`:
  always responds with `NextResponse.redirect` (never JSON) to
  `/profile?calendar=connected` or `/profile?calendar=error`, and always
  clears the `gcal_oauth_state` cookie. Order: `requireAuth` (throw → error),
  `?error=` present → error, missing `code`/`state` → error, CSRF check
  against the cookie → error on mismatch/missing, `exchangeCode`, encrypt
  both tokens via `token-crypto`, resolve the Clerk `supabase` JWT, and
  `upsert` into `google_calendar_tokens` (`onConflict: "user_id"`,
  `calendar_id: "primary"`). Any thrown error or Supabase `error` → error
  redirect; otherwise → connected redirect. The whole body is wrapped in a
  single try/catch that also redirects to error (belt-and-suspenders for any
  unexpected throw, e.g. missing JWT).

- **`app/api/google-calendar/disconnect/handler.ts`** — `disconnect(req, lookup?)`:
  `requireAuth`, resolves the JWT/Supabase client, `SELECT`s the caller's row
  (`maybeSingle`); no row → idempotent `{ disconnected: true }`. If a row
  exists, best-effort `decryptToken` + `revokeToken` (wrapped in its own
  try/catch so a decrypt/revoke problem never blocks deletion —
  `revokeToken` itself is designed to never throw), then `DELETE`s the row;
  a delete error → 500 `INTERNAL`, otherwise `{ disconnected: true }`.

- **`tests/unit/lib/google-calendar/token-crypto.test.ts`** — round-trip,
  distinct IV per call, tampered-ciphertext / malformed-ciphertext throws,
  missing/short key throws, and asserts the key value never appears in a
  thrown error message.

- **`tests/unit/lib/google-calendar/oauth.test.ts`** — `getAuthUrl` asserts
  the endpoint, `calendar.events` scope, `access_type=offline`,
  `prompt=consent`, and `state`, plus throws on missing client id/redirect
  URI; `exchangeCode` covers the happy path (mapped fields + expiry math),
  non-ok `fetch`, missing `refresh_token`, and missing env vars; `revokeToken`
  asserts it never throws (ok, non-ok, and a rejecting `fetch`).

- **`tests/unit/app/api/google-calendar-connect-route.test.ts`** — 401 when
  unauthenticated (lookup never consulted, cookie never set); 200 returns
  `authUrl` and sets the state cookie with the exact spec'd options, and the
  `state` in the cookie matches the `state` query param embedded in
  `authUrl`; 500 `INTERNAL` when Google env vars are missing.

- **`tests/unit/app/api/google-calendar-callback-route.test.ts`** — redirects
  to error (with the correct `Location`) for: unauthenticated, `?error=`
  (asserting no `exchangeCode`/Supabase call), missing `code`/`state`, CSRF
  mismatch, missing state cookie, `exchangeCode` throwing (asserting no
  Supabase call), and a Supabase upsert error. Happy path asserts the
  redirect target, the state cookie is cleared, the upsert payload/opts
  (`user_id`, `calendar_id: "primary"`, `scope`, `token_expiry`,
  `onConflict: "user_id"`), and that the stored `*_encrypted` fields are not
  the plaintext values.

- **`tests/unit/app/api/google-calendar-disconnect-route.test.ts`** — 401
  unauthenticated (both no Clerk id and no JWT); success + revoke + delete
  when a row exists (asserts `revokeToken` called with the *decrypted*
  refresh token and the delete is scoped to `user_id`); idempotent success
  (no revoke/delete calls) when no row exists; still succeeds when revoke
  "fails" (per its own no-throw contract); 500 `INTERNAL` on a select error
  and on a delete error.

## Files modified

- **`lib/google-calendar/token-crypto.ts`** — replaced the throwing stubs
  with real AES-256-GCM encrypt/decrypt. Key: `TOKEN_ENCRYPTION_KEY`
  interpreted as base64, must decode to exactly 32 bytes (throws otherwise,
  never including the key value in the message). `encryptToken`: random
  12-byte IV, `"iv:authTag:ciphertext"` (all base64) joined by `:`.
  `decryptToken`: parses/validates the three parts, verifies the auth tag,
  throws on any parse/auth failure.

- **`lib/google-calendar/oauth.ts`** — replaced the throwing stubs.
  `CALENDAR_EVENTS_SCOPE` constant (write-only `calendar.events` scope —
  never `calendar`/`calendar.readonly`). `getAuthUrl(state)` builds the
  Google consent URL with `access_type=offline` + `prompt=consent` (so a
  refresh token is returned every time) and throws if `GOOGLE_CLIENT_ID`/
  `GOOGLE_REDIRECT_URI` are unset. `exchangeCode(code)` POSTs
  form-urlencoded to the token endpoint, throws on a non-ok response or on a
  response missing `refresh_token` (so the caller never persists a row with
  an empty refresh token), and maps `expires_in` seconds into an ISO
  `expiryDate`. `revokeToken(token)` is best-effort — it never throws;
  non-2xx or a network failure is swallowed with a non-sensitive
  `console.warn`. No token values are ever logged.

- **`app/api/google-calendar/connect/route.ts`**,
  **`app/api/google-calendar/callback/route.ts`**,
  **`app/api/google-calendar/disconnect/route.ts`** — replaced the
  `notImplemented` 501 stubs with thin wiring (`POST`/`GET`/`DELETE`) to the
  new handlers, mirroring `app/api/profile/route.ts`.

- **`lib/supabase/types.ts`** — added `GoogleCalendarTokensRow` and a
  `google_calendar_tokens` entry to the hand-rolled
  `Database["public"]["Tables"]` type. `Insert` omits `id`/`created_at`/
  `updated_at` as optional (so the callback's upsert can set a fresh
  `updated_at` on reconnect while everything else stays required, matching
  the NOT NULL DB columns).

## Untouched, per spec

- `schemas/google-calendar.ts` — left as the empty-object stub; these routes
  take no request body.
- `lib/google-calendar/client.ts` — out of scope (#62 event sync).
- No migration or RLS changes; the `google_calendar_tokens` table and its
  RLS policies already existed.
- No new dependency added (`googleapis` was explicitly excluded by the spec
  — all HTTP calls use `fetch`, encryption uses Node's built-in `crypto`).

## Verification

- `bun run lint` — clean.
- `bun run typecheck` — clean.
- `bun run test` — 63 suites / 765 tests pass, including the 5 new/expanded
  suites for this issue (36 tests covering token-crypto, oauth, and the
  three route handlers).
- `bun run check:service-role` and `bun run check:workflows` — both pass
  (no service-role key usage introduced; not a workflow-script change).

## What the Tester should focus on

- **CSRF**: callback must redirect to error (not throw/500) on a missing or
  mismatched `gcal_oauth_state` cookie, without ever calling `exchangeCode`
  or the Supabase client.
- **Consent denial**: `?error=access_denied` (no `code`) redirects to error
  and never touches Supabase, even if a valid state cookie is present.
- **No-refresh-token edge case**: `exchangeCode` must throw (not silently
  substitute an empty string) when Google's response omits `refresh_token`,
  since the DB column is `NOT NULL`.
- **Reconnect**: a second successful callback for the same user should
  `upsert` (overwrite), not create a duplicate row — verified here via the
  `onConflict: "user_id"` option and cookie/token round-trip in mocks, but
  worth an integration/RLS-level check if one exists for this table.
- **Disconnect graceful degradation**: revoke "failing" must never block the
  DB delete or turn the response into an error — confirm this holds even if
  `decryptToken` itself throws (e.g. a corrupted `refresh_token_encrypted`
  value), which the handler's inner try/catch is intended to cover but has
  no spec-named edge case forcing it.
- **Never-log-plaintext**: no `console.log`/`console.warn`/`console.error`
  call anywhere in the new code includes a token or the encryption key value
  — `revokeToken`'s warnings are intentionally static strings.
- Route wiring only forwards `req`; handlers accept an optional `lookup` for
  testability exactly like `app/api/profile/handler.ts`.
