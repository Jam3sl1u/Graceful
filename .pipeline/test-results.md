# Test Results — Issue #23 (Disable PostgREST auto-API & lock down service role key)

## Overall: PASS

All coder claims in `.pipeline/changes.md` were independently re-verified against
a clean checkout of branch `issue-23-sprint-0-disable-postgrest-auto-api-lock-down-service-role-key`
(HEAD `3bc3e6c`). No code changes were made by the tester.

## Checks performed

1. **Diff review vs. spec/changes.md claims** — PASS
   - `git diff HEAD~1 HEAD -- README.md supabase/config.toml package.json` confirms
     all three edits are purely additive: no existing lines removed or reworded.
   - `supabase/config.toml`: `[api]` / `enabled = false` block appended after
     `project_id`, with the exact comment text specified in the spec.
   - `README.md`: new `## Architecture rules (standing)` section appended below
     the original 2 lines; covers PostgREST-disabled rule, service-role-key/RLS
     rule, PRD §15.1/§25.1/§19.3 references, and pointer to the guard script —
     matches spec requirements verbatim.
   - `package.json`: `"check:service-role": "node scripts/check-service-role.mjs"`
     added after `test:e2e`, no other scripts touched/reordered.
   - `scripts/check-service-role.mjs` is a new, dependency-free ESM script using
     only `node:fs`/`node:path`, matching the spec's required behavior (recursive
     scan of `app/`+`lib/`, `.ts/.tsx/.js/.mjs` only, comment-line allowlist,
     case-sensitive `SUPABASE_SERVICE_ROLE_KEY` / case-insensitive `service_role`).

2. **Existing test/lint/typecheck suite** — PASS (re-run independently, not trusted from changes.md)
   - `bun run typecheck` (`tsc --noEmit`) — exit 0, no errors.
   - `bun run lint` (`eslint .`) — exit 0, no errors.
   - `bun run test` (`jest`) — 1 suite / 3 tests passed
     (`tests/unit/lib/api/response.test.ts`), exit 0. Unaffected by this change,
     as expected (no existing test touches these files).

3. **Guard script — clean repo baseline** — PASS
   - `node scripts/check-service-role.mjs` and `bun run check:service-role` both
     exit 0 on the unmodified repo, printing the expected single OK line. Only
     pre-existing match is the allowlisted comment block in
     `lib/supabase/client.ts` (not flagged, as required).

4. **Guard script — manual violation injection (failure-case + edge-case coverage)** — PASS
   Temporarily added (and removed after verification, confirmed via
   `git status --porcelain` showing no leftover files):
   - `lib/__tmp_test/violation1.ts` — non-comment `SUPABASE_SERVICE_ROLE_KEY`
     reference in `lib/`. Correctly flagged (`path:line - matchedText`), and the
     line also matched the case-insensitive `service_role` pattern (substring
     `SERVICE_ROLE` inside the const name), which is correct per spec since both
     patterns are independently checked.
   - `app/api/__tmp_test/violation2.ts` — non-comment mixed-case
     `Service_Role` string in `app/`. Correctly flagged, confirming the guard
     covers **both** scanned directories, not just `lib/`.
   - `lib/__tmp_test/ok_comment.ts` — comment-only mention of both patterns.
     Correctly **not** flagged (allowlist works for `//`-prefixed lines).
   - `lib/__tmp_test/ignored.json` — non-comment `SUPABASE_SERVICE_ROLE_KEY`
     inside a `.json` file. Correctly **not** flagged (extension filter works).
   - Combined run with all four fixtures present: exit code 1, three violation
     lines printed (as expected — two real violations, one line matching both
     patterns), OK message suppressed. Matches the spec's exit-1-on-violation
     contract.
   - After cleanup: guard returns to exit 0 / single OK line; empty directory
     (`lib/__tmp_empty_dir`) and empty file (`lib/__tmp_empty_file.ts`) injected
     and re-scanned separately — no crash, exit 0 (covers the spec's "must not
     crash on directories with no matching files / empty files" edge case).

## Notes for Reviewer

- No automated regression test file was added for `check-service-role.mjs`
  itself (e.g. under `tests/`) — the spec's edge cases were verified manually
  per the "What the Tester should focus on" section of changes.md, and the
  script has no exported functions to unit-test without spawning a subprocess.
  If a Sprint 4 audit (#79) or CI wiring is planned later, consider adding a
  `tests/unit/scripts/check-service-role.test.ts` that shells out to the script
  against fixture directories, so this behavior is regression-tested going
  forward. Not a blocker for this issue's scope.
- OQ-1 (dashboard toggle / CI secret placement) remains out of repo reach, as
  correctly scoped in the spec — not something this tester pass can verify.
- `.pipeline/spec.md` and `.pipeline/changes.md` show as modified in
  `git status` (pipeline scratch content) — consistent with the note in
  changes.md that these are orchestrator-managed and not part of the code
  commit.

**Result: PASS. No blocking issues found. Ready for Reviewer.**
