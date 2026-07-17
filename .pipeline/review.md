# Review — Issue #65: Build Member Week View screen

## VERDICT: SHIP

## What I verified (independently, not just from the summaries)

- `git diff main...HEAD`: only the files the spec scopes were touched — the new
  aggregate endpoint (`handler.ts` + `route.ts`), the rewritten `page.tsx`
  server wrapper, the `"use client"` component, its CSS module, and the two new
  test files. No scope creep, no unrelated refactors, no changes to existing
  endpoints' RBAC.
- `bun run typecheck` — clean.
- `bun run lint` — clean.
- The two new suites — `service-weeks-member-view-route.test.ts` (20) and
  `member-week-view.test.tsx` (16) — 36 tests, all pass.

## Spec conformance (handler)

- RLS-only reads through `getSupabaseClient(jwt)`; no service-role, no new RPC,
  no RLS migration. Matches the sibling `setlist/handler.ts` auth/JWT pattern
  (guest excluded via `requireRole(["admin","set_leader","member"])`, 401 when
  no JWT, 404 for missing/other-tenant week).
- Invitation "latest by created_at" reduce is correct (ISO strings compare
  lexicographically); `confirmationStatus` null when none.
- Setlist: draft/no-row → `null`; published-with-zero-songs →
  `{status:"published",songs:[]}` (edge cases 2 & 3 distinguished);
  `effectiveKey = key_override ?? default_key ?? null` (edge case 4).
- Empty-`.in()` guard is real: `event_attendees`/team queries skipped when no
  events, verified by a `from` spy in the test (edge cases 5 & 8).
- Documents best-effort try/catch → `[]` + 200 on R2 failure (edge case 9);
  no `file_key` in the response, `getDownloadUrl` freshly minted per file
  (edge case 13, asserted via `JSON.stringify` + call-arg check).

## Spec conformance (component)

- ViewState machine + `cancelled` guard mirror `week-view.tsx`; 404→not-found,
  403→forbidden, other non-ok/throw→error.
- All six sections render per spec, including the two distinct setlist empty
  states, assigned-only events, in-page detail panel with a Maps link only when
  `location` is non-empty (edge case 7), team "—" placeholder, documents empty
  state, and the disabled/inert floating chat button. Badge tones match the
  `Badge` component's supported set.

## Notes (non-blocking)

- The handler reads `member_profiles`/`member_instruments` tenant-wide rather
  than scoped to `teamUserIds`, then maps by id. Correct under RLS; a minor
  efficiency point, not a bug.
- Team is sourced from `event_attendees` (documented Decisions limitation: a
  member confirmed for a week with no events yet won't appear until events
  exist). This is an accepted Phase-1 design choice, called out in the spec,
  and tested to behave as documented — a valid follow-up, not a blocker.

Green tests here reflect genuinely correct behavior: the edge-case assertions
check real outputs (skipped queries, degraded documents, distinct empty states),
not just HTTP 200s.
