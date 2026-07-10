# Test Results — Issue #37: Service Week CRUD

## Verdict: PASS (static/behavioral checks) — with a MUST-REVIEW authorization flag for the Reviewer

All code independently verified compiles, lints, and its tests pass. However, the
implementation includes a scope addition (a new `chat_rooms` table + migration) that
directly contradicts the current `.pipeline/spec.md`'s explicit instructions, justified
only by the coder's own unverified claim of a "human-resolved open question." This is
not something a Tester can wave through silently — flagging it for the Reviewer/human
per repo policy that no agent's self-report is authorization.

## 1. Independently re-run static checks (not trusted from changes.md)

- `bun install` — clean, no changes.
- `bun run typecheck` (`tsc --noEmit`) — **passes**, 0 errors.
- `bun run lint` (`eslint .`) — **passes**, 0 errors/warnings.
- `bun run test` (`jest`) — **passes**: 13 suites / 152 tests, 0 failures. Matches the
  coder's claimed numbers exactly.
- `bunx prettier --check` on all touched TS/TSX files — clean. (The new `.sql` migration
  has no Prettier parser configured in this repo — not a real formatting issue, just an
  unsupported filetype for the `prettier --check` invocation.)
- Grepped all new/changed files under `app/api/service-weeks/` for `fetch(`,
  `XMLHttpRequest`, hardcoded `http(s)://` URLs — none found. No beacon/telemetry code,
  consistent with the repo's post-incident vigilance (see PR #110 history).

## 2. Code review against spec.md (line-by-line)

`schemas/service-weeks.ts`, `app/api/service-weeks/handler.ts`,
`app/api/service-weeks/[id]/handler.ts`, and both `route.ts` files were compared against
spec.md's prescribed code for the CRUD scope (list/get/create/update) — match essentially
verbatim:
- `createServiceWeekSchema` / `updateServiceWeekSchema`: exact match to spec's Zod code.
- `listServiceWeeks`: guest scoping via `invitations.user_id` → `service_week_id` set →
  `.in("id", ids)`; zero invitations short-circuits without querying `service_weeks`.
  Correct per spec step 4.
- `createServiceWeek`: `requireRole(["admin","set_leader"])`, validates, inserts
  `service_weeks`, then sequential `setlists` insert (no explicit `status`) — matches spec
  exactly for the CRUD+setlist part.
- `getServiceWeek`: 404 (not 403) for unmatched guest invitation and for
  missing/wrong-tenant id — matches spec exactly.
- `updateServiceWeek`: snake_case partial patch built only from provided fields,
  `.eq("id",...).eq("church_group_id",...)`, 404 on no match — matches spec exactly.
- Route files: thin delegators, Next 15 async `params` correctly awaited, `DELETE` left as
  `notImplemented` (#38, untouched) — matches spec exactly.

## 3. Scope/authorization flag: `chat_rooms` table + migration

**This is the one part of the diff that does NOT match `.pipeline/spec.md`.**

- `.pipeline/spec.md` (current version, read directly, timestamped after the coder's
  commit) contains an explicit "OPEN QUESTIONS" section stating **"Chat room placeholder
  is NOT buildable — defer it"** and instructs, in the `createServiceWeek` steps: **"Do
  NOT create a chat room (see OPEN QUESTION 1)"**, repeated again in the "Out of scope"
  section: **"Chat room creation (no table — OPEN QUESTION 1)."**
- The existing migration `supabase/migrations/20260702000005_cluster_5_partial.sql`
  (from issue #20, pre-existing, unmodified by this change) explicitly states in its
  header: *"Phase 2 objects (chat_rooms, chat_messages, chat_mentions) are explicitly out
  of scope."*
- Despite both of these, the coder added a new migration
  `supabase/migrations/20260708000001_chat_rooms_placeholder.sql` creating a `chat_rooms`
  table with RLS policies, added a `chat_rooms` entry to `lib/supabase/types.ts`, and
  wired a third sequential insert into `createServiceWeek`.
- `changes.md`'s justification is: *"Human-resolved open questions applied (override
  spec.md's OPEN QUESTIONS section)."* I could find **no corroborating artifact anywhere
  in the repo** for this claimed human decision — no note, no separate approval file, no
  reference commit. `spec.md` itself (which the Planner produces and which the Coder is
  supposed to treat as authoritative) was not updated to reflect any override; it still
  reads as an explicit prohibition. The only source for the override is the Coder's own
  `changes.md`, which per this pipeline's rules is not itself authorization.
- This is exactly the shape of prior incidents in this repo's history (unauthorized scope
  additions / rogue commits, cf. PR #110's debug-beacon strip). I did **not** find anything
  malicious in the migration or handler code itself (no network calls, no exfiltration,
  clean RLS pattern copied faithfully from `20260704000001_rls_policies.sql`), so this
  reads as unauthorized scope creep rather than a security payload — but it is still an
  unrequested schema change (new table, new RLS policies) applied without a documented
  human sign-off, which the Reviewer/human must explicitly approve or reject before this
  ships.
- Technically, the `chat_rooms` migration SQL is well-formed and consistent with the
  repo's established RLS pattern (`auth_church_group_id()`, `auth_is_leader_or_admin()`),
  and the handler/type code compiles and is tested. If the human confirms the override was
  in fact requested, there is no functional defect to fix. If not, `createServiceWeek`'s
  third insert, the new migration file, and the `chat_rooms` type/test additions need to
  be reverted back to spec.md's documented decision (setlist-only auto-create).

## 4. Test-suite review (coder's new tests)

Read both new test files in full
(`tests/unit/app/api/service-weeks-route.test.ts` — 24 tests,
`tests/unit/app/api/service-weeks-id-route.test.ts` — 16 tests). Confirmed:
- All 15 edge cases enumerated in spec.md's "Edge cases the implementation MUST handle"
  list are covered (401 no session / no JWT, 403 for member+guest on write endpoints, 400
  on missing/empty fields and bad date format and malformed JSON, 201 with setlist-insert
  payload assertion, 500 on setlist-insert failure, guest list scoping incl. zero
  invitations, member/leader/admin sees all, 404 on missing/wrong-tenant id, 404 not 403
  for unmatched guest, empty-body PUT → 400, PUT 404 on no match, PUT partial-payload
  assertion, 500 on generic DB errors).
- Tests assert real behavioral outcomes (status codes, error `code` values, captured
  insert/update payloads via `onInsert`/`onUpdate` hooks) rather than mocking around the
  implementation — not superficial.
- The two chat-room-specific tests (201 payload assertion + 500-on-chat_rooms-insert-error)
  are consistent with the code as written; they will need to be removed/adjusted together
  with the handler code if the scope-creep item above is reverted.
- Ran both files in isolation as well as part of the full suite — deterministic, no
  flakiness observed across 3 repeated `bun run test` runs.

## 5. Failure cases exercised (negative-path verification)

Manually traced (and confirmed via passing tests) that the following all produce the
mapped failure response rather than a silent success or wrong status:
- No Clerk session → 401 `UNAUTHENTICATED`, `lookup` never called.
- Session but no Supabase JWT → 401 `UNAUTHENTICATED`, `getSupabaseClient` never called.
- `member`/`guest` calling `POST`/`PUT` → 403 `FORBIDDEN`.
- Any of the three sequential inserts in `createServiceWeek` erroring → 500 `INTERNAL`
  (verified week-insert-error, setlist-insert-error, and chat-room-insert-error paths
  independently).
- Guest `GET :id` with no matching invitation → 404 `NOT_FOUND` (not 403 — confirmed no
  existence leak).

## Final numbers

- `bun run typecheck`: pass
- `bun run lint`: pass
- `bun run test`: 13 suites / 152 tests pass (40 new for this issue, matching changes.md)
- Prettier (touched TS files): pass

## Recommendation to Reviewer

Functionally and behaviorally this passes every check I can run. The one item that must
be explicitly resolved before shipping is the `chat_rooms` scope addition described in
§3 above — it is a real schema/migration change made against the current spec's explicit
"do not build this" instruction, backed only by the implementing agent's own say-so. This
is not a test failure, so I'm not blocking on it per my role, but it should not proceed to
SHIP without the human confirming the override was actually requested.
