# Changes — Issue #142: Provision Google OAuth credentials & Cloudflare R2 bucket

## Summary

This issue is a provisioning/ops task, not a code task (per spec.md's "Scope
note"). The concrete in-repo deliverable is a human-operator runbook plus
small wiring to link it — no application code was touched, and no real
secrets or credential values were added anywhere.

## Files changed

- **`documentation/google-oauth-r2-provisioning.md`** (NEW) — the
  provisioning runbook, mirroring `documentation/staging-environment.md`'s
  structure (numbered `##` sections, tables, `## Verification checklist`).
  Covers: purpose/context, prerequisites (issue #10's existing GCP project
  and Cloudflare account), creating a Web-application OAuth 2.0 client
  scoped to `calendar.events` only with a redirect URI matching
  `/api/google-calendar/callback` per environment, generating
  `TOKEN_ENCRYPTION_KEY` via `openssl rand -base64 32` (must decode to
  exactly 32 bytes), creating a private R2 bucket with a bucket-scoped API
  token, mapping all ten env vars to their destinations (`.env.local` /
  Vercel Preview+Production / no GitHub Actions secrets needed), a free-tier
  cost note, and a verification checklist restating the issue's acceptance
  criteria.
- **`README.md`** — added one sentence under `## Environments` linking the
  new runbook, in the same style as the existing `staging-environment.md`
  link. No restructuring.
- **`documentation/staging-environment.md`** — appended a short
  cross-reference to the new runbook in the Google Calendar and Cloudflare
  R2 rows of §3's env-var table (pointing at the runbook's §3–§4 and §5
  respectively). No other edits; existing sections not renumbered or
  rewritten.
- **`.env.example`** — comment-only edit. Added a couple of comment lines
  above the `# Google Calendar (OAuth sync)` block (redirect URI shape,
  `TOKEN_ENCRYPTION_KEY` = base64 of 32 random bytes via `openssl rand
  -base64 32`, pointer to the runbook) and above the `#Cloudflare R2 (file
  storage)` block (`R2_ENDPOINT` shape, pointer to the runbook). All
  existing placeholder lines (`VAR=`) are unchanged and still empty — no
  values were added.
- **`.pipeline/spec.md`** — staged/committed alongside the above as it was
  the planning stage's output already present (uncommitted) in the working
  tree at the start of this coding pass, not authored by this stage.

## Files explicitly NOT touched (out of scope, per spec)

- `lib/google-calendar/oauth.ts`, `lib/google-calendar/token-crypto.ts`,
  `lib/google-calendar/sync.ts`, `lib/r2/client.ts`, and the
  `app/api/google-calendar/*` route handlers — already fully implemented
  (#58/#61/#62); verified by reading them, confirmed they consume exactly
  the env-var names and formats documented in the runbook.
- No `.env.local`, Vercel, GitHub Actions, or any actual credential/secret
  was created or set — those are human dashboard actions per the issue's own
  "never in the repo" instruction.
- iCal `.ics` export (#63) — unrelated, not touched.

## Verification performed

- `bun run lint` — clean (ESLint, no errors).
- `bun run typecheck` — clean (`tsc --noEmit`, no errors).
- `bun run test` — 77 suites / 968 tests, all passing (docs-only change, no
  test behavior affected).
- `bun run check:service-role` — OK, no service-role key references found
  outside comments in `app/` or `lib/` (unaffected by this change, run as a
  sanity check since `.env.example` was touched).
- Confirmed via `git diff origin/main...HEAD` (before committing) that HEAD
  and `origin/main` were identical — i.e. no prior commit on this branch had
  already implemented this issue, so this pass's commit is genuinely new
  work.
- Cross-checked every concrete claim in spec.md against the actual files:
  `lib/google-calendar/oauth.ts` (`CALENDAR_EVENTS_SCOPE`, env var names),
  `lib/google-calendar/token-crypto.ts` (base64 / 32-byte / AES-256-GCM
  requirement), `lib/r2/client.ts` (env var names, `region: "auto"`,
  `forcePathStyle: true`, 30-minute presign expiry), and
  `app/api/google-calendar/callback/route.ts` (confirms the fixed callback
  path). All matched the spec's description.

## What the Tester should focus on

- **No secrets leaked**: grep the diff for anything that looks like a real
  key/token/id (there should be none — only placeholder text, prose, and
  comment lines).
- **`.env.example` placeholder lines are unchanged and still empty** — only
  comments were added above the Google Calendar and Cloudflare R2 blocks.
- **Runbook accuracy**: the redirect URI path
  (`/api/google-calendar/callback`), the scope
  (`https://www.googleapis.com/auth/calendar.events`, write-only, no read
  scope), the `TOKEN_ENCRYPTION_KEY` format (base64, exactly 32 decoded
  bytes, `openssl rand -base64 32`), and the R2 endpoint shape
  (`https://<account-id>.r2.cloudflarestorage.com`, account-level not
  bucket-level) all need to match the actual code paths referenced above.
- **README and staging-environment.md cross-references** render correctly
  and don't duplicate the runbook's content (they're pointers only).
- **This is a docs-only change** — confirm no application code, tests, or
  CI workflows were modified (the diff should only touch the four
  documentation/config files listed above, plus `.pipeline/spec.md`).
