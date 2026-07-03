# Review — Issue #23 (Disable PostgREST auto-API & lock down service role key)

VERDICT: NEEDS WORK

## Summary
The four in-repo deliverables match the spec: `supabase/config.toml` [api]/enabled=false
block, README "Architecture rules (standing)" section, `scripts/check-service-role.mjs`
guard, and the `check:service-role` package.json script. All edits are additive (only
deletion is the package.json trailing-comma line). PRD refs (§19.3, §25.1) verified to
exist. Commit contains only the four code files; `.pipeline/*` correctly left uncommitted
per prior incident history. OQ-1 dashboard/secret actions correctly deferred.

I independently re-ran the guard and confirmed: passes clean repo (exit 0), the
`lib/supabase/client.ts` comment is correctly allowlisted, real non-comment violations in
both `app/` and `lib/` are flagged with `path:line - matched` and exit 1, trailing comments
after real code correctly FAIL, and the extension filter skips `.json`/no-extension files.

## Must fix

1. **Guard silently passes (exit 0) when run from any cwd other than the repo root.**
   `scripts/check-service-role.mjs:11` uses relative `SCAN_DIRS = ["app", "lib"]` resolved
   against `process.cwd()`. `walk()` (lines 21-25) swallows the ENOENT in a bare `try/catch`
   and returns zero files, so from a non-root cwd the script prints the OK message and
   exits 0 while scanning NOTHING. Reproduced:
     - `cd /repo && node scripts/check-service-role.mjs` with an injected violation → exit 1 (correct)
     - `cd / && node /repo/scripts/check-service-role.mjs` same violation → exit 0 "OK" (WRONG)
   This is a false-negative in a security guard whose only job is to fail loudly. The
   `bun run check:service-role` path is safe today (npm/bun set cwd to package root), but
   the spec's stated contract is `node scripts/check-service-role.mjs`, and any future
   direct call, git hook, or CI step that runs from a different directory would get a
   silent green while enforcing nothing.
   Fix: resolve SCAN_DIRS against the script/repo root, e.g. anchor to
   `import.meta.url` (`fileURLToPath` + `join(dirname, "..", dir)`), OR make a missing
   scan dir an explicit condition (only tolerate absent dirs, still fail on read errors) —
   do not let a missing `app/`+`lib/` resolve to a silent pass. Then verify the guard
   flags a violation regardless of invocation cwd.

## Non-blocking notes (do not need to fix for ship)
- Block comments whose content lines lack a leading `*` (e.g. a bare line inside `/* ... */`)
  are treated as code and would FALSE-POSITIVE fail. This errs toward strictness, which is
  the safe direction for a security guard, and does not affect the current allowlisted file
  (which uses `//` and `*`-prefixed lines). Acceptable as-is; worth a comment if revisited.
- No regression test for the guard itself (tester noted this). Acceptable for this issue's
  scope; consider a fixture-based test if #79/CI wiring lands.
