# Review — Issue #61: Google Calendar OAuth connect/disconnect

VERDICT: SHIP

## What I verified (independently, not just from the summaries)

Ran `git diff main...HEAD` and read every implementation and test file directly.
Re-ran the full gate myself:
- `bun run test` — 64 suites / 767 tests pass.
- `bun run lint` — clean.
- `bun run typecheck` (`tsc --noEmit`) — clean.
- `bun run check:service-role` — OK (no service-role key usage; RLS-scoped anon
  client only, exactly as spec/PRD §25.5 requires).

## Spec conformance

- **token-crypto.ts**: AES-256-GCM, key from `TOKEN_ENCRYPTION_KEY` base64-decoded
  and rejected unless exactly 32 bytes; error messages are static and never
  include the key. `iv:authTag:ciphertext` (base64) format; fresh random 12-byte
  IV per call; `decryptToken` validates 3 non-empty parts and lets auth-tag
  verification throw on tampering. Matches spec §1.
- **oauth.ts**: `CALENDAR_EVENTS_SCOPE` is exactly the write-only
  `.../auth/calendar.events` — no `calendar`/`calendar.readonly`. `getAuthUrl`
  includes `access_type=offline` + `prompt=consent` + `state`, throws on missing
  client id / redirect URI. `exchangeCode` throws on non-ok and on missing
  `refresh_token` before returning (protects the NOT NULL column), maps
  `expires_in` to an ISO `expiryDate`. `revokeToken` never throws; its two
  `console.warn` calls are static strings with no token interpolated. Matches §2.
- **Handlers**: connect/callback/disconnect follow the profile handler pattern
  exactly (thin route → handler, optional `lookup`, `requireAuth`, Clerk
  `supabase` JWT → `getSupabaseClient(jwt)`). Callback always redirects (307),
  never JSON; clears the state cookie in every path; upserts with
  `onConflict: "user_id"`, `calendar_id: "primary"`, encrypted tokens; outer
  try/catch redirects to error on any unexpected throw. Disconnect is idempotent,
  best-effort revoke wrapped so a decrypt/revoke failure never blocks the delete,
  delete errors → 500. Matches §3–5 and edge cases 1–10.
- **types.ts**: `google_calendar_tokens` Row/Insert/Update added; Insert makes
  `id`/`created_at`/`updated_at` optional so the upsert can set a fresh
  `updated_at`. Matches §6.
- Scope respected: no event sync, no read scope, no `googleapis` dependency, no
  migration/RLS change.

## Tests — meaningful, not superficial

- Callback tests assert the redirect target for every negative branch
  (unauthenticated, `?error=`, missing code/state, CSRF mismatch, missing cookie,
  exchange failure, upsert error) AND that no `exchangeCode`/Supabase call happens
  on the pre-DB failures. Happy path asserts the encrypted values are NOT the
  plaintext, the `:` structure is present, and scope/calendar_id/onConflict.
- token-crypto tests cover round-trip, distinct-IV, tampered/malformed ciphertext,
  bad key length, and that the key never leaks into an error message.
- oauth tests cover scope/params, missing-env throws, non-ok and missing-refresh
  exchange failures, and `revokeToken`'s three never-throw cases.
- disconnect tests cover 401 (both no-Clerk-id and no-JWT), success+revoke+delete
  scoped to user_id, idempotent no-row, revoke-fails-still-succeeds, select/delete
  errors. Tester supplement adds a real (non-mocked) `decryptToken`-throws and
  `encryptToken`-throws path — genuinely exercising graceful degradation.

## Minor, non-blocking observations (no change required)

- `exchangeCode` defaults a missing `access_token` to `""`. Spec only mandates
  throwing on missing `refresh_token`; Google always returns an access token on a
  successful exchange, so this is a non-issue.
- The callback's broad `catch {}` intentionally converts every error into a
  generic error redirect (spec-mandated: a browser redirect target must never
  return JSON/500). This is correct here, though it means an unexpected internal
  bug would surface only as a generic redirect — acceptable for this route type.

Green tests here reflect correct behavior: security-critical paths (CSRF, no
partial rows, encryption at rest, write-only scope, graceful revoke) are all
directly asserted. Ready for human sign-off.
