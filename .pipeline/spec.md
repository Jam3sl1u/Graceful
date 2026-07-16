# Spec — Issue #61: Google Calendar OAuth connect/disconnect

## OPEN QUESTIONS

None blocking. Two low-risk decisions made below (documented, coder may keep as-is):
- `calendar_id` is stored as the literal `"primary"` (the member's primary
  Google calendar). The PRD column allows any calendar; there is no UI to pick
  one, so `"primary"` is the MVP value.
- The `callback` route redirects the browser to `/profile?calendar=connected`
  on success and `/profile?calendar=error` on failure. There is no dedicated
  calendar-settings page yet; `/profile` is the existing member settings page.

## Scope

Implement the connect / callback / disconnect plumbing ONLY. Do NOT implement
event sync (that is #62). Do NOT request calendar read scope. Do NOT add a
`googleapis` dependency — use `fetch` against Google's HTTP endpoints and Node's
built-in `crypto`.

## Current state (already present — do not recreate)

- Route stubs return `notImplemented(...)`:
  - `app/api/google-calendar/connect/route.ts` (exports `POST`)
  - `app/api/google-calendar/callback/route.ts` (exports `GET`)
  - `app/api/google-calendar/disconnect/route.ts` (exports `DELETE`)
- `lib/google-calendar/oauth.ts` — has `getAuthUrl` and `exchangeCode` stubs
  that `throw`. Referenced (not yet existing) `lib/google-calendar/token-crypto.ts`.
- DB table `google_calendar_tokens` exists
  (`supabase/migrations/20260702000006_cluster6_auth_audit.sql`) with columns:
  `id, user_id (UNIQUE FK→users.id ON DELETE CASCADE), access_token_encrypted,
  refresh_token_encrypted, token_expiry, calendar_id, scope, created_at, updated_at`.
- RLS policies (select/insert/update/delete, all `user_id = auth_user_id()`)
  exist in `supabase/migrations/20260704000001_rls_policies.sql`.
- Env vars already declared in `.env.example`: `GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `TOKEN_ENCRYPTION_KEY`.
- `lib/supabase/types.ts` is MISSING a `google_calendar_tokens` table type — must be added.
- `schemas/google-calendar.ts` is an empty-object stub — leave it alone (no body
  schema is needed for these routes; input comes from query params / OAuth).

No migration or RLS change is required. No new npm/bun dependency is required.

## Patterns to copy

- Route/handler split + auth + error handling: copy the shape of
  `app/api/profile/route.ts` (thin) + `app/api/profile/handler.ts` (logic).
- Auth: `requireAuth(req, lookup)` from `lib/api/auth.ts`; take an optional
  `lookup?: UserLookup` param on every handler for testability (as profile does).
- Responses: `ok(...)`, `fail(msg, ErrorCode.X, status)` from `lib/api/response.ts`;
  `ApiException`/`ErrorCode` from `lib/api/errors.ts`.
- Supabase access: `getSupabaseClient(jwt)` with the Clerk `supabase` template
  JWT (exactly as profile handler lines 26–31). RLS enforces user scoping.
- Handler test structure: copy `tests/unit/app/api/profile-route.test.ts`
  (mock `@clerk/nextjs/server` and `@/lib/supabase/client`, fake `UserLookup`).

## Files to create / modify

### 1. `lib/google-calendar/token-crypto.ts` (CREATE)

AES-256-GCM using Node `crypto`. Key from `process.env.TOKEN_ENCRYPTION_KEY`.

```ts
// "server-only" at top
export function encryptToken(plaintext: string): string;
export function decryptToken(ciphertext: string): string;
```

- Key: interpret `TOKEN_ENCRYPTION_KEY` as base64; it must decode to exactly 32
  bytes. If missing or wrong length, `throw new Error(...)` (do NOT include the
  key value in the message).
- `encryptToken`: random 12-byte IV via `randomBytes`, `createCipheriv("aes-256-gcm", key, iv)`,
  produce `iv:authTag:ciphertext` all base64, joined by `:`. Return that string.
- `decryptToken`: parse the three parts, `createDecipheriv`, verify auth tag.
  On any parse/auth failure, throw.
- Never `console.log` plaintext or the key.

### 2. `lib/google-calendar/oauth.ts` (MODIFY — replace the two throwing stubs)

```ts
export const CALENDAR_EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events";

// Build the Google consent URL. `state` is the CSRF token (see callback).
export function getAuthUrl(state: string): string;

export type GoogleTokens = {
  accessToken: string;
  refreshToken: string;      // required; see edge case below
  expiryDate: string;        // ISO timestamptz for token_expiry
  scope: string;
};

// Exchange an auth code for tokens at https://oauth2.googleapis.com/token.
export async function exchangeCode(code: string): Promise<GoogleTokens>;

// Best-effort revoke at https://oauth2.googleapis.com/revoke. Never throws.
export async function revokeToken(token: string): Promise<void>;
```

Details:
- `getAuthUrl`: base `https://accounts.google.com/o/oauth2/v2/auth`, query params:
  `client_id=GOOGLE_CLIENT_ID`, `redirect_uri=GOOGLE_REDIRECT_URI`,
  `response_type=code`, `scope=CALENDAR_EVENTS_SCOPE`, `access_type=offline`,
  `prompt=consent`, `state=<state>`. Use `URLSearchParams`. Throw if
  `GOOGLE_CLIENT_ID` or `GOOGLE_REDIRECT_URI` is unset.
  (`access_type=offline` + `prompt=consent` are required so Google returns a
  refresh_token every time.)
- `exchangeCode`: POST form-urlencoded body (`code`, `client_id`, `client_secret`,
  `redirect_uri`, `grant_type=authorization_code`) to the token endpoint. Parse
  JSON. If HTTP not ok, throw. Map `access_token`→accessToken,
  `refresh_token`→refreshToken, `expires_in` (seconds)→`expiryDate` =
  `new Date(Date.now() + expires_in*1000).toISOString()`, `scope`→scope. If
  `refresh_token` is absent in the response, throw (see edge case).
- `revokeToken`: POST `token=<token>` form-urlencoded to the revoke endpoint;
  swallow any error / non-2xx (log a non-sensitive warning only). Used for
  graceful disconnect.
- Do NOT log token values.

### 3. `app/api/google-calendar/connect/handler.ts` (CREATE) + wire `route.ts`

`export async function connect(req, lookup?): Promise<Response>`

1. `requireAuth(req, lookup)` (any authenticated member; no role gate).
2. Generate CSRF `state = randomBytes(32).toString("base64url")`.
3. Set an httpOnly cookie via `cookies()` from `next/headers`:
   name `gcal_oauth_state`, value `state`, `httpOnly: true`, `secure: true`,
   `sameSite: "lax"`, `path: "/"`, `maxAge: 600`. (`sameSite: "lax"` is required
   so the cookie survives Google's top-level GET redirect back to `callback`.)
4. `authUrl = getAuthUrl(state)`.
5. Return `ok({ authUrl })`.
6. Wrap in try/catch: `ApiException`→`fail(err.message, err.code, err.status)`;
   anything else (e.g. missing Google env)→`fail("Internal error", ErrorCode.INTERNAL, 500)`.

`route.ts`: replace stub with `export async function POST(req: NextRequest) { return connect(req); }`.

### 4. `app/api/google-calendar/callback/handler.ts` (CREATE) + wire `route.ts`

`export async function callback(req, lookup?): Promise<Response>`

This route is a browser redirect target, so it ALWAYS responds with an HTTP
redirect (`NextResponse.redirect(new URL(path, req.url))`), never JSON. Use
`/profile?calendar=connected` on success and `/profile?calendar=error` on any
failure. Clear the `gcal_oauth_state` cookie in all paths.

1. `requireAuth(req, lookup)`. If it throws → redirect to error.
2. Read query params from `req.nextUrl.searchParams`: `code`, `state`, `error`.
   - If `error` present (user denied consent) → redirect error, store nothing.
   - If `code` or `state` missing → redirect error.
3. CSRF check: read `gcal_oauth_state` cookie; if missing or `!== state` →
   redirect error, store nothing.
4. `tokens = await exchangeCode(code)`.
5. Encrypt: `encryptToken(tokens.accessToken)`, `encryptToken(tokens.refreshToken)`.
6. Get the Clerk `supabase` JWT, `getSupabaseClient(jwt)`, and UPSERT into
   `google_calendar_tokens` with `onConflict: "user_id"`:
   ```
   {
     user_id: ctx.userId,
     access_token_encrypted,
     refresh_token_encrypted,
     token_expiry: tokens.expiryDate,
     calendar_id: "primary",
     scope: tokens.scope,          // will be the calendar.events scope
     updated_at: new Date().toISOString(),
   }
   ```
   Cast the payload as the profile handler does (`as unknown as
   Database["public"]["Tables"]["google_calendar_tokens"]["Insert"]`) since the
   hand-written Insert type marks defaulted columns required.
7. On any thrown error or a Supabase `error` → redirect error. On success →
   redirect connected.
8. Never log token plaintext.

`route.ts`: `export async function GET(req: NextRequest) { return callback(req); }`.

### 5. `app/api/google-calendar/disconnect/handler.ts` (CREATE) + wire `route.ts`

`export async function disconnect(req, lookup?): Promise<Response>`

1. `requireAuth(req, lookup)`.
2. Get the Clerk `supabase` JWT + `getSupabaseClient(jwt)`.
3. SELECT the caller's row (`refresh_token_encrypted`, `access_token_encrypted`)
   from `google_calendar_tokens` where `user_id = ctx.userId` (`maybeSingle`).
   - If no row → return `ok({ disconnected: true })` (idempotent; nothing to do).
4. Best-effort revoke: `decryptToken(refresh_token_encrypted)` then
   `await revokeToken(...)`. `revokeToken` never throws; a failed revoke must NOT
   block deletion (graceful degradation, PRD §25.5).
5. DELETE the row where `user_id = ctx.userId`. If the delete returns a Supabase
   `error` → `fail("Internal error", ErrorCode.INTERNAL, 500)`.
6. Return `ok({ disconnected: true })`.
7. try/catch same as the other handlers.

`route.ts`: `export async function DELETE(req: NextRequest) { return disconnect(req); }`.

### 6. `lib/supabase/types.ts` (MODIFY — add the missing table type)

Add a row type near the other `*Row` types:
```ts
type GoogleCalendarTokensRow = {
  id: string;
  user_id: string;
  access_token_encrypted: string;
  refresh_token_encrypted: string;
  token_expiry: string;
  calendar_id: string;
  scope: string;
  created_at: string;
  updated_at: string;
};
```
Add the `Tables` entry (mirror `audit_logs`, but also make `updated_at` optional
so the callback upsert can set it):
```ts
google_calendar_tokens: {
  Row: GoogleCalendarTokensRow;
  Insert: Omit<GoogleCalendarTokensRow, "id" | "created_at" | "updated_at"> & {
    id?: string;
    created_at?: string;
    updated_at?: string;
  };
  Update: Partial<GoogleCalendarTokensRow>;
  Relationships: [];
};
```

## Edge cases the implementation MUST handle

1. **Unauthenticated** (no Clerk `userId`, or no `supabase` JWT): connect →
   401 `UNAUTHENTICATED`; disconnect → 401; callback → redirect to error.
2. **CSRF**: callback with missing/mismatched `gcal_oauth_state` cookie →
   redirect error, no DB write.
3. **User denied consent**: callback called with `?error=access_denied` (no
   `code`) → redirect error, no DB write.
4. **Token exchange failure** (Google returns non-2xx): `exchangeCode` throws →
   callback redirects error, no partial row written.
5. **No refresh_token returned**: `refresh_token_encrypted` is NOT NULL. If
   Google omits `refresh_token`, `exchangeCode` throws → callback redirects
   error rather than writing a row with an empty refresh token. (Requesting
   `prompt=consent` makes this rare, but handle it.)
6. **Reconnect**: an existing row for the user is overwritten via
   `upsert(onConflict: "user_id")` with a fresh `updated_at`.
7. **Disconnect with no stored tokens**: idempotent success (`{ disconnected: true }`).
8. **Disconnect when Google revoke fails** (token already revoked/expired): row
   is still deleted and the response is success (graceful degradation).
9. **Missing/invalid `TOKEN_ENCRYPTION_KEY`** (not 32 bytes): crypto throws →
   surfaced as 500 `INTERNAL` on connect; callback redirects to error. Never
   leak the key.
10. **Never log token plaintext or the encryption key** anywhere.

## Security requirements (from AC / PRD §25.5)

- OAuth scope is EXACTLY `https://www.googleapis.com/auth/calendar.events`
  (write-only). No `calendar` or `calendar.readonly` scope.
- Tokens encrypted with AES-256 before storage; key only in
  `process.env.TOKEN_ENCRYPTION_KEY`, never in DB or source.
- Use the RLS-scoped anon client (`getSupabaseClient(jwt)`) — never the service
  role key.

## Verification

Run `bun run lint`, `bun run typecheck`, and `bun run test` before finishing.

## Tests to add (unit; mirror `tests/unit/app/api/profile-route.test.ts`)

Place under `tests/unit/`:
- `token-crypto`: round-trips (`decryptToken(encryptToken(x)) === x`); distinct
  IV per call (two encryptions of same input differ); throws on tampered
  ciphertext; throws on bad key length.
- `oauth`: `getAuthUrl` contains the calendar.events scope, `access_type=offline`,
  `prompt=consent`, and the state; `exchangeCode` throws when the mocked
  `fetch` returns non-ok and when `refresh_token` is absent.
- `connect` handler: 401 when unauthenticated; 200 returns `authUrl` and sets
  the state cookie.
- `callback` handler: redirects to error on state mismatch / on `?error=`;
  redirects to connected on success and upserts encrypted tokens with
  `scope=calendar.events` and `calendar_id="primary"`.
- `disconnect` handler: 401 unauthenticated; success + delete when a row exists;
  idempotent success when no row; still succeeds when revoke fails.

Mock `fetch` via `global.fetch = jest.fn()` and set the Google/`TOKEN_ENCRYPTION_KEY`
env vars in the test setup.
