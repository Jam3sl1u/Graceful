# Google OAuth & Cloudflare R2 Provisioning

## 1. Purpose

This runbook provisions the **real** Google OAuth 2.0 client and Cloudflare R2
bucket that `lib/google-calendar/*` and `lib/r2/client.ts` consume at runtime,
so #58/#61/#62 (Google Calendar sync and file storage) can be exercised
end-to-end, not just unit-tested. The code that reads these credentials is
already implemented — `lib/google-calendar/oauth.ts` reads `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI`; `lib/google-calendar/
token-crypto.ts` reads `TOKEN_ENCRYPTION_KEY`; `lib/r2/client.ts` reads
`R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and
`R2_BUCKET_NAME`. This issue only supplies the credentials those files
consume; it does not change any code (PRD §11.2 Google Calendar sync, §12.4
File storage, §18 Cost/free-tier budget).

## 2. Prerequisites

The Google Cloud Console project (with the Calendar API enabled) and the
Cloudflare account for R2 already exist, provisioned under issue #10. This
runbook does not create either account — it only creates the OAuth client,
encryption key, and R2 bucket within them.

## 3. Google OAuth 2.0 client

Steps for the operator, in the existing GCP project:

1. Create an **OAuth 2.0 Client ID** of type **Web application**
   (APIs & Services → Credentials → Create Credentials → OAuth client ID).
2. **Scope**: `https://www.googleapis.com/auth/calendar.events` only —
   write-only, per PRD §12.4 / §25.5 (the app never reads a member's
   calendar, only creates/updates/deletes events it created itself). This
   matches `lib/google-calendar/oauth.ts`'s `CALENDAR_EVENTS_SCOPE` exactly;
   do not add read scopes (e.g. `calendar.readonly` or the bare `calendar`
   scope).
3. **Authorized redirect URI** must equal exactly
   `<NEXT_PUBLIC_APP_URL>/api/google-calendar/callback` — the path is fixed
   by the route file `app/api/google-calendar/callback/route.ts` (GET
   handler); a trailing slash or different path breaks the OAuth exchange.
   Register one redirect URI per environment:
   - local dev: `http://localhost:3000/api/google-calendar/callback`
   - staging: `https://<staging-vercel-host>/api/google-calendar/callback`
   - production: `https://<prod-host>/api/google-calendar/callback`
4. Use a **dedicated OAuth client per environment** (staging vs production)
   — never share one client's credentials across environments, per PRD
   §25.7 Environment isolation and `staging-environment.md` §3's Google
   Calendar row.
5. Map the outputs:
   - Client ID → `GOOGLE_CLIENT_ID`
   - Client secret → `GOOGLE_CLIENT_SECRET`
   - That environment's redirect URI → `GOOGLE_REDIRECT_URI` (each
     environment's value points at its own host).

## 4. Token encryption key

`TOKEN_ENCRYPTION_KEY` must be a **32-byte random value, base64-encoded**.
`lib/google-calendar/token-crypto.ts` decodes it with `Buffer.from(raw,
"base64")` and throws unless the decoded length is exactly 32 bytes
(AES-256-GCM).

Generate it with:

```bash
openssl rand -base64 32
```

- Must be **base64, not hex** — a hex string of the same character count
  decodes to the wrong byte length and will throw at runtime.
- Staging and production each get their **own distinct** key — a shared key
  would let one environment decrypt the other's stored tokens.
- Never commit or log this value.

## 5. Cloudflare R2 bucket

Steps for the operator, in the existing Cloudflare account:

1. Create a **private** R2 bucket — no public access, no public bucket URL,
   no custom domain. The app only ever serves objects through pre-signed
   URLs (`lib/r2/client.ts`, 30-minute expiry via `getUploadUrl` /
   `getDownloadUrl`), so direct public reads must stay disabled.
2. Create an **R2 API token scoped to only that bucket** — Object Read &
   Write permission on that single bucket, not account-wide.
3. Map the outputs:
   - `R2_ACCOUNT_ID` — the Cloudflare account ID.
   - `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` — the API token's
     S3-compatible access key ID / secret.
   - `R2_BUCKET_NAME` — the bucket name.
   - `R2_ENDPOINT` — `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com` (the
     account-level S3 API endpoint, no bucket name in the host —
     `lib/r2/client.ts` uses `region: "auto"` and `forcePathStyle: true`,
     so the bucket is addressed via the path, not a subdomain).
4. Use a **separate bucket + separate token per environment** (staging vs
   production), per PRD §25.7 and `staging-environment.md` §3's Cloudflare
   R2 row.

## 6. Where to set the values

| Destination | Scope | Notes |
| --- | --- | --- |
| `.env.local` | Local dev only | Git-ignored; never add real values to `.env.example` |
| Vercel → Preview | Staging | Same variable names as production, staging-only values |
| Vercel → Production | Production | Same variable names as staging, production-only values |
| GitHub Actions secrets | Not required for this issue | None of #58/#61/#62's server-side vars (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `TOKEN_ENCRYPTION_KEY`, `R2_*`) are consumed by any GitHub Actions workflow today — contrast the cron/E2E vars in `staging-environment.md` §6–§7, which are read by workflows. Do not add these to GitHub secrets unless a future CI/E2E workflow actually reads them. |

Vercel setup follows the same native per-Environment scoping convention as
`staging-environment.md` §3: Preview = staging, Production = production,
identical variable names across environments, only the values differ. Never
name-prefix a variable (e.g. no `STAGING_GOOGLE_CLIENT_ID`).

The ten variables provisioned by this runbook:

| Variable | Source |
| --- | --- |
| `GOOGLE_CLIENT_ID` | §3 |
| `GOOGLE_CLIENT_SECRET` | §3 |
| `GOOGLE_REDIRECT_URI` | §3 |
| `TOKEN_ENCRYPTION_KEY` | §4 |
| `R2_ACCOUNT_ID` | §5 |
| `R2_ACCESS_KEY_ID` | §5 |
| `R2_SECRET_ACCESS_KEY` | §5 |
| `R2_BUCKET_NAME` | §5 |
| `R2_ENDPOINT` | §5 |

## 7. Free-tier / cost note

Per PRD §18: the Google Calendar API's free tier covers 10M requests/day,
and Cloudflare R2's free tier covers 10GB storage, 10M Class A (write)
operations, and 100M Class B (read) operations per month with **zero
egress fees**. This provisioning stays entirely within free tier for both
services.

## 8. Verification checklist

- [ ] OAuth Web client exists in the #10 GCP project with only the
      `calendar.events` scope and a redirect URI matching
      `/api/google-calendar/callback` for each environment.
- [ ] `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` set
      in Vercel Preview + Production and in local `.env.local`.
- [ ] `TOKEN_ENCRYPTION_KEY` is a base64 value decoding to exactly 32 bytes,
      distinct per environment, set the same three places.
- [ ] A private R2 bucket exists (no public access) with a bucket-scoped API
      token; all five `R2_*` vars set the same three places, distinct per
      environment.
- [ ] `R2_ENDPOINT` is `https://<account-id>.r2.cloudflarestorage.com`.
- [ ] A teammate can pull the env vars and run the real OAuth/R2 flow
      without provisioning anything themselves.
- [ ] This document exists at
      `documentation/google-oauth-r2-provisioning.md` and is linked from
      `README.md`.
