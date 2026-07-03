# Changes for Issue #23 — Disable PostgREST auto-API & lock down service role key

## Scope note (OQ-1, non-blocking)
Two of the issue's four acceptance criteria are Supabase-dashboard / secrets-management
actions outside this repo's reach (toggling the hosted project's Data API off, and
placing the service role key in CI secrets). Per the spec, this pass covers only the
in-repo, verifiable deliverables. Those two dashboard/secrets actions remain human/ops
follow-ups tracked by issue #23 and re-checked in #79.

## Files changed

1. **`supabase/config.toml`** (modified) — appended an `[api]` block with
   `enabled = false` after the existing `project_id` line, plus a comment block
   citing PRD §19.3/§25.1 and noting this only governs the local `supabase start`
   stack (the hosted dashboard toggle is a separate ops action). Existing header
   comments and `project_id` line are untouched.

2. **`README.md`** (modified) — appended a new `## Architecture rules (standing)`
   section (README was previously 2 lines) documenting: PostgREST is disabled and
   all data access goes through Next.js API routes; the service role key bypasses
   RLS and must never appear in `app/**` or `lib/**`; PRD references (§15.1/§25.1,
   §19.3); and a pointer to the new `scripts/check-service-role.mjs` guard
   (`bun run check:service-role`), re-verified in the Sprint 4 audit (#79).

3. **`scripts/check-service-role.mjs`** (new file, new `scripts/` directory) —
   dependency-free ESM CLI guard (Node built-in `fs`/`path` only). Recursively
   scans `app/` and `lib/` (`.ts`, `.tsx`, `.js`, `.mjs` only) for the literal
   `SUPABASE_SERVICE_ROLE_KEY` and case-insensitive `service_role`. Lines whose
   trimmed content starts with `//` or `*` are treated as comments and allowed
   (this is what lets the existing warning comment in `lib/supabase/client.ts`
   pass). Any non-comment match prints `path:line - matchedText` for every
   violation and exits 1; a clean scan prints one OK line and exits 0.

4. **`package.json`** (modified) — added `"check:service-role": "node
   scripts/check-service-role.mjs"` to the `scripts` block (placed after
   `test:e2e`). No dependency changes; no other scripts touched or reordered
   beyond the insertion.

## Verification performed
- `node scripts/check-service-role.mjs` and `bun run check:service-role` both
  exit 0 against the current repo (only match is the comment block in
  `lib/supabase/client.ts`, correctly allowlisted).
- Manually introduced a temporary non-comment violation
  (`lib/__test_violation.ts` referencing `SUPABASE_SERVICE_ROLE_KEY`) and
  confirmed the script reports `path:line - matchedText` for both patterns and
  exits 1; the temp file was removed afterward (not committed).
- `bun run typecheck` — passes, no errors.
- `bun run lint` — passes, no errors.

## What the Tester should focus on
- Confirm `bun run check:service-role` exits 0 on a clean checkout of this
  branch.
- Confirm the guard would catch a real violation if one were introduced in
  `app/` or `lib/` (non-comment reference to either pattern).
- Confirm README and `supabase/config.toml` changes are purely additive (no
  existing lines removed/reworded) — verified via `git diff`.
- `.pipeline/spec.md` shows as modified in the working tree but was
  deliberately **not** included in this commit — per prior incident history
  (see commit `8b1915a`, "Revert unrelated .pipeline/spec.md change swept into
  previous commit"), that file is pipeline scratch content managed by the
  orchestrator, not part of the code change for this issue.

## Out of scope (per spec, intentionally not touched)
- No dashboard automation, no real Supabase project/migrations.
- No CI workflow or git-hook wiring for the new script.
- `lib/supabase/client.ts` logic left unchanged (guard reads it, doesn't edit
  it) — that's issue #22's territory.
