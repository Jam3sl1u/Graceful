# Graceful — Phase 2 (Collab) Sprint Plan & Issue Backlog

Source: `documentation/prd/graceful_requirements_v10.md` — rows marked **Ph.2**, the §27 "Phase 2 — Collab" build order, and the §31 Phase 2 roadmap row. Nothing marked Ph.3, Ph.4 or later is included: no audio pipeline, no Modal/Python worker, no AI model, no transcribed-sheet-music library section.

Status: **draft for approval.** Nothing has been created on GitHub.

## Assumptions

- **Cadence:** 4 sprints (numbered 5–8, continuing from Phase 1's 0–4). The PRD's "2 weeks, solo dev" estimate is the same scope; the split is for trackable, independently reviewable PRs.
- **Granularity:** one issue per shippable unit, deliberately small — a schema cluster, one API surface, one screen, or one test category. 32 issues. Each goes through the plan → code → test → review pipeline on its own linked branch and PR.
- **IDs:** `P2-NN` are backlog-local. GitHub will assign real numbers at creation; a mapping table gets appended to this file then.
- **Reuse, don't refactor:** every issue copies an existing Phase 1 pattern (`handler.ts` + thin `route.ts`, Zod validation, `requireAuth`/role check, `writeAuditLog`, `dispatchNotification`, `tests/support/api-auth.ts`, `tests/support/admin-route-registry.ts`, `tests/integration/rls/`). Phase 1 code is only touched where a row below says so.
- **Every issue traces back to the PRD** — section, business rule, acceptance criterion, or API endpoint.

## What already exists on `main` (verified, not assumed)

| Found | Where | Consequence |
|---|---|---|
| `chat_pref` enum and `notification_preferences.chat_preference` column | `20260702000005_cluster_5_partial.sql` | No migration needed for the preference; but the preferences handler **deliberately never reads or writes it** — P2-05 lifts that. |
| `notification_type` already has `chat_mention`, `devotion_shared`, `new_church_document` | same migration | Only genuinely new values need `ALTER TYPE`. |
| No `chat_rooms` / `chat_messages` / `chat_mentions` / `documents` tables | migrations | P2-01, P2-09 create them. |
| `invitations.response_deadline` exists, used as the 72h link expiry in the accept/deny RPCs | cluster 3 + RPC migrations | The Ph.2 *per-week* deadline must be a separate column so link expiry is not conflated with escalation (P2-19). |
| Inbox filter row (All / Invitations / Setlists / Events / Chat) is already client-side | `lib/notifications/inbox-links.ts` | P2-16 only adds **System** and the server-side filter the PRD API specifies. |
| `/documents` page is a "coming soon" stub | `app/(app)/documents/page.tsx` | P2-11 replaces it. |
| `TODO(Phase 2 chat): archive chat room` in the cancel path | `app/api/service-weeks/[id]/handler.ts` | P2-02 fills it (BR-17). |
| PWA manifest + install prompt, but **no service worker** | `app/manifest.ts`, `lib/pwa/install.ts` | P2-23 adds the first service worker. |
| No Supabase Realtime usage, no browser-side Supabase client, no push library | repo-wide grep | P2-06 and P2-17 introduce them. |
| Multi-admin support (PRD §11.1 "Multiple admins", marked Ph.2) | Phase 1 issue 18 | **Already shipped — no Phase 2 issue.** |
| No i18n string file (`en.json`) exists, although PRD §28.4 calls for one | repo-wide | Phase 2 screens follow the Phase 1 inline-string convention; extracting strings would be a Phase 1 refactor and is **not** in this backlog. |
| Load runner is a custom Bun script, not k6 | `tests/load/` | P2-31 adds a scenario to it rather than a new tool. |

## Decisions I need from you before Step 2

These would otherwise surface as OPEN QUESTIONS mid-run and stop a batch. Each has a recommendation; none is assumed.

| # | Question | Recommendation |
|---|---|---|
| D1 | **Realtime transport.** The browser has no Supabase client today; all DB access is server-side with the Clerk JWT. Realtime needs the browser to hold a socket. | Supabase Realtime *Postgres Changes* on `chat_messages`, browser client authenticated with the same Clerk JWT so RLS decides who receives rows. Sending still goes through `POST /api/chat-rooms/:id/messages`. Requires a dashboard step (see needs-human). |
| D2 | **Who is in a week chat?** PRD §15.1: "all confirmed members and the worship leader". | Accepted invitees of that week (members and guests, per §22.11) **plus all admins and set leaders** of the group. Alternative: admins only. |
| D3 | **Guests and the global library.** PRD §22.9 says guests are "scoped to their invited week's documents only", but the `documents` table has no week link. | Guests get 403 on the global library in Phase 2; they keep their existing access to song attachments of their invited week. No `service_week_id` column added. |
| D4 | **Deadline semantics** (PRD §35 leaves this open). | After the per-week deadline: one final alert to the member and the admins, the 24h reminder cycle stops for that invitation, the invitation **stays pending and still answerable**, and the admin decides. No auto-deny. |
| D5 | **`chat_preference = all`.** Does every message create an inbox row? | Yes for `all` (inbox row + push, type `chat_message`); `mentions` users get a row only when mentioned. Mentions always notify (§15.1). |
| D6 | **YouVersion "import".** There is no keyless public content API. | Server-side fetch of the share link's OpenGraph metadata, host-allowlisted to `bible.com` domains. If the fetch fails or is blocked, the manual fallback lets the user type the title/passage and still post the link. No YouVersion developer account. |
| D7 | **Song familiarity visibility.** PRD only says members mark it. | Each member reads/writes their own; admins and set leaders can read the group's (it is the input for Ph.4 scheduling). No member-to-member visibility. |
| D8 | **Merge cadence.** I never merge. Later batches build on earlier ones. | You merge a batch's PRs before giving the go-ahead for the next; each new branch starts from fresh `origin/main`. If you'd rather not merge between batches, I stack branches instead and say so in each PR. |

## Milestones to create in GitHub first

| Milestone | Maps to |
|---|---|
| `Phase 2 / Sprint 5 — Week Team Chat` | Chat schema, lifecycle, API, mentions, realtime, screen, pin |
| `Phase 2 / Sprint 6 — Library, Archive & Familiarity` | Global document library, past setlist archive, song familiarity |
| `Phase 2 / Sprint 7 — Notifications & Devotions` | Inbox filter, deadline + escalation, YouVersion import, web push |
| `Phase 2 / Sprint 8 — Offline, Polish & Phase Gate` | Service worker, offline cache, responsive polish, security/test gate |

## Labels

Reuse the existing `type:feature`, `type:security`, `type:infra`, `type:chore`, `area:data-model`, `area:auth`, `priority:high|med|low`. Create:

- `phase-2`, `sprint-5` … `sprint-8`
- `area:chat`, `area:library`, `area:notifications`, `area:pwa`, `area:testing`
- `type:screen`, `type:test` (in the Phase 1 backlog but never created on GitHub)

---

## Sprint 5 — Week Team Chat

**Goal:** a confirmed member can open the week chat, send a message another member receives in real time, @mention someone, and the leader can pin an announcement. (PRD §15.1, §20.7, §22.11, §14.1.)

| ID | Title | Labels | Description |
|---|---|---|---|
| P2-01 | Schema — chat tables + RLS | `type:infra` `area:data-model` `area:chat` | `chat_rooms` (unique `service_week_id`, `is_archived`, `pinned_message_id`), `chat_messages` (`content` ≤ 2000 via CHECK as defence in depth, `is_deleted`, `kind` `text`/`devotion`, nullable `metadata jsonb` so P2-22 needs no second migration), `chat_mentions`. RLS: church-group scoped **and** week-membership scoped per D2 via one `is_chat_room_member()` helper; INSERT refused when `is_archived`. Regenerate `lib/supabase/types.ts`. PRD §20.7, §25.1. |
| P2-02 | Chat room lifecycle — auto-create and archive | `type:feature` `area:chat` | Room is created when the first invitation for a week becomes `accepted` (DB trigger, so the Phase 1 accept RPCs are not edited). Archived when the service date passes (hourly cron, same `CRON_SECRET` pattern) and immediately on week cancel (BR-17 — fills the existing TODO); reactivating a future week un-archives. PRD §15.1, §20.7, BR-17, AC "Accept invitation → gains access to the week team chat". |
| P2-03 | Chat API — list rooms, read and send messages | `type:feature` `area:chat` | `GET /api/chat-rooms`, `GET /api/chat-rooms/:id/messages` (cursor-paginated), `POST /api/chat-rooms/:id/messages`. Zod: 1–2000 chars with the exact §8 message "Message is too long. Please keep messages under 2000 characters."; archived room rejected; non-member 403; write rate limit via `lib/api/rate-limit.ts`. PRD §22.11, §8. |
| P2-04 | @mention parsing and chat notifications | `type:feature` `area:chat` `area:notifications` | On send: resolve mentions against room members only, write `chat_mentions`, create a `chat_mention` inbox row for each mentioned user **regardless of `chat_preference`**; per D5 create `chat_message` rows for `all`-preference members (new enum value). Never notify the sender. Deep-link to the room. PRD §15.1, §14 "Chat mention", §20.7. |
| P2-05 | Chat notification preference — all vs mentions only | `type:feature` `area:notifications` | Expose `chat_preference` in `GET/PUT /api/notifications/preferences` (currently deliberately omitted) with Zod enum validation, and add the control to the preferences UI. Default stays `mentions`. BR-14 logic untouched. PRD §14.1, §15.1. |
| P2-06 | Realtime delivery | `type:feature` `area:chat` | Per D1: add `chat_messages` to the realtime publication, a browser Supabase client that carries the Clerk JWT (anon key only — `check:service-role` must still pass), and a `useChatMessages` hook with reconnect + gap backfill through the REST endpoint. CSP `connect-src` updated for `wss:`. PRD §26.6 (500 ms p95), §19. |
| P2-07 | Week Chat screen | `type:screen` `area:chat` | Mobile-first room view: message list, composer with character counter and mention autocomplete, archived read-only state, empty state. New messages announced through an ARIA live region (A-07); icon buttons labelled (A-03); 44 px targets (A-08). Entry points from Week View and Member Week View. PRD §15.1, §28.3. |
| P2-08 | Admin broadcast pin | `type:feature` `area:chat` | `PUT`/`DELETE /api/chat-rooms/:id/pin` (admin / set leader only, message must belong to the room, audit-logged) and a pinned banner at the top of the chat screen. One pin per room. PRD §15.1 "Admin broadcast pin". |

---

## Sprint 6 — Library, Archive & Familiarity

**Goal:** the church group has a browsable shared document library, a searchable history of published setlists, and members can record how well they know each song. (PRD §11.2, §13.4, §22.9, Screen 4.)

| ID | Title | Labels | Description |
|---|---|---|---|
| P2-09 | Schema — `documents` table + RLS | `type:infra` `area:data-model` `area:library` | General shared library table exactly as PRD §20.6 (`folder`, `description`, `file_key` — never a URL). RLS: group members read, admins insert/delete, guests none (D3). Distinct from `song_documents`; no changes to that table. |
| P2-10 | Documents API | `type:feature` `area:library` | `GET /api/documents` (folder filter + name search), `POST /api/documents/upload-url` (admin), `POST /api/documents` (register completed upload — mirrors the song-document flow), `GET /api/documents/:id/download-url` (30-min signed URL after the three §25.2 ownership checks), `DELETE /api/documents/:id` (admin, removes the R2 object). Cross-group attempt → 403 **and** an audit-log entry (§8). `new_church_document` in-app notification to all members on register. PRD §22.9, §25.2, AC "Document access (signed URL)", BR-06. |
| P2-11 | Document Library screen | `type:screen` `area:library` | Replaces the stub. Folder tabs shown only when non-empty, search by name, list with type badge / date / size; admin-only upload and delete. Guest sees a scoped "no access" state, not a broken page. PRD Screen 4. |
| P2-12 | Past setlist archive API | `type:feature` `area:library` | `GET /api/setlists/archive` — published setlists whose service date has passed, filterable by date range, song (title match) and team member (accepted invitee), paginated. Read-only; no schema change expected (index only if the query plan needs it). Search input goes through `lib/api/postgrest.ts` quoting helpers. PRD §11.2 "Past setlist archive". |
| P2-13 | Setlist Archive screen | `type:screen` `area:library` | Search form (date range, song, member) + results list linking to a read-only setlist view with that week's roster. PRD §11.2. |
| P2-14 | Song familiarity — schema and API | `type:feature` `area:data-model` `area:library` | `song_familiarity` (`user_id`, `song_id`, `church_group_id`, level enum `comfortable`/`learning`/`not_learned`, unique per user+song) + RLS per D7. `PUT /api/songs/:id/familiarity`, own level included in `GET /api/songs`. PRD §13.4 "Song familiarity". |
| P2-15 | Song familiarity UI | `type:screen` `area:library` | Three-state control on the song catalog and on each song in Member Week View; text label alongside colour (A-02). PRD §13.4. |

---

## Sprint 7 — Notifications & Devotions

**Goal:** the inbox filters by all five categories, invitations can carry a hard deadline that escalates, a YouVersion link can be shared to the week, and notifications can arrive as push. (PRD §12.1, §13.2, §14, §15.2.)

| ID | Title | Labels | Description |
|---|---|---|---|
| P2-16 | Inbox filter by type — add System, filter server-side | `type:feature` `area:notifications` | Add the **System** category (calendar re-auth, new document, and any type not otherwise mapped — nothing may be unfilterable) and a `category` query param on `GET /api/notifications` so pagination is correct under a filter. Guest inbox scoping unchanged. PRD §13.2 "Filter by type", §22.12, Screen 6. |
| P2-19 | Invitation response deadline — set per week | `type:feature` `area:data-model` | New `service_weeks.response_deadline` (separate from the invitation link expiry). Accepted by `PUT /api/service-weeks/:id` with Zod + a 422 rule: must be in the future and before the service date. Control on Week View; deadline shown on the invitation response screens. Audit-logged. PRD §12.1 "Invitation deadline". |
| P2-20 | Deadline auto-escalation | `type:feature` `area:notifications` | Extend the hourly reminder job: once a week's deadline passes, each still-pending invitation gets exactly one final alert to the member and to the admins (stamped so it cannot repeat), and its 24h reminders stop (D4). Uses a new SECURITY DEFINER RPC alongside — not a rewrite of — `send_invitation_reminders`. PRD §12.1, §35. |
| P2-21 | YouVersion link preview | `type:feature` `area:chat` | `POST /api/devotions/preview` (admin / set leader). Host allowlist, HTTPS only, no redirects off the allowlist, timeout and response-size cap, HTML never rendered — only extracted, escaped metadata is returned. On failure returns a "couldn't load a preview" result that drives the manual fallback. PRD §15.2 both rows; SSRF handling noted for P2-32. |
| P2-22 | Post a devotion to the week | `type:feature` `area:chat` `area:notifications` | `POST /api/service-weeks/:id/devotions`: writes a `devotion` chat message, sends `devotion_shared` in-app + email to all confirmed members through `dispatchNotification` with a new Resend template. "Share devotion" dialog in the chat screen: paste link → preview (or manual fields) → confirm. PRD §15.2, §14 "Devotion shared". |
| P2-17 | Push subscriptions — schema and API | `type:feature` `area:notifications` `area:data-model` | `push_subscriptions` (per user, per device endpoint) + own-rows-only RLS; `POST`/`DELETE /api/push/subscriptions`; VAPID variables added to `.env.example` as placeholders. PRD §14 "In-app push is added in Phase 2". |
| P2-18 | Push delivery | `type:feature` `area:notifications` `area:pwa` | Push becomes a channel in the dispatch path for the types the PRD routes to push (chat mention first); expired endpoints are pruned on 404/410. Service-worker `push` and `notificationclick` handlers deep-link using the existing inbox link map. Opt-in prompt is user-initiated, never on page load. PRD §14. |

---

## Sprint 8 — Offline, Polish & Phase Gate

**Goal:** the current week works with no signal, every screen is clean on the P0 browsers, and the phase clears its security and test gate. (PRD §9.1, §28.3, §28.5, §26.)

| ID | Title | Labels | Description |
|---|---|---|---|
| P2-23 | Service worker foundation | `type:infra` `area:pwa` | First service worker: registration, versioned caches with cleanup on activate, app-shell precache, offline fallback page. Hand-written (no new dependency). Never caches API responses for other users — caches are cleared on sign-out. CSP `worker-src` updated. PRD §9.1. |
| P2-24 | Offline cache — current week | `type:feature` `area:pwa` | Caches the current week's setlist, event details and documents (the setlist's song attachments, stored by document id because signed URLs expire in 30 minutes). Stale-while-revalidate; a visible "offline — showing saved copy" indicator. Storage cap with oldest-week eviction. PRD §9.1 "Offline reading (PWA)". |
| P2-25 | Mobile-responsive polish — Phase 1 screens | `type:chore` `type:screen` | Audit and fix all 8 Phase 1 screens at 375 px and 768 px: overflow, 44 px targets, focus rings, contrast. Findings listed in the PR; CSS-only where possible, no behavioural changes. PRD §28.3 A-01–A-08, §28.5. |
| P2-26 | Mobile-responsive polish — Phase 2 screens + P0 browser projects | `type:chore` `type:test` `area:testing` | Same audit for chat, library, archive and familiarity screens. Add Playwright projects for WebKit (desktop + iPhone) and Android Chrome emulation alongside Chromium, with a smoke spec per P0 target. PRD §28.5. |
| P2-27 | Auth-matrix + file-access tests — all Phase 2 routes | `type:test` `area:testing` | Register every new handler in `tests/support/admin-route-registry.ts` so the bypass sweep covers it: no session, wrong role, other church group, malformed input. Plus §26.3 file-access cases for `documents`. PRD §26.3. |
| P2-28 | RLS tests — all Phase 2 tables | `type:test` `area:testing` | `chat_rooms`, `chat_messages`, `chat_mentions`, `documents`, `song_familiarity`, `push_subscriptions`: Church A JWT against Church B rows, plus the in-group cases — a same-church member **not** on the week cannot read its chat; a member cannot read another's subscriptions. PRD §6 "RLS enforcement", §26.3. |
| P2-29 | Zod / input-validation audit — Phase 2 routes | `type:security` `area:testing` | Every new route validated by a schema; injection, XSS, oversized, null-byte and Unicode payloads against chat content, document names/folders, archive search and the devotion URL. PRD §26.3 "Input validation / injection". |
| P2-30 | E2E — chat flow | `type:test` `area:testing` | Playwright, two browser contexts: member A sends, member B receives without reload; A @mentions B while B is on `mentions` and B gets the notification; archived room refuses a send. PRD §26.2 "Chat flow". |
| P2-31 | Chat latency check | `type:test` `area:testing` | New scenario in `tests/load/`: 20 concurrent clients in one room, send-to-receive p95 ≤ 500 ms, reported through the existing report module; `documentation/performance-testing.md` updated. PRD §26.6 "Realtime chat latency". |
| P2-32 | OWASP pass — Phase 2 surface | `type:security` `area:testing` | Short manual review of the new surface (A01 chat/library access control, A03 injection, A05 CSP + service worker, A10 SSRF on the devotion fetch), appended to `documentation/owasp-top-10-review.md` so `check:owasp` still passes. PRD §26.3. |

---

## Dependency order

```
P2-01 ─┬─ P2-02
       └─ P2-03 ─┬─ P2-04 ─────────────┐
                 ├─ P2-06 ─┐           │
                 │         ├─ P2-07 ─┬─ P2-08
                 │         │         └─ P2-22 (also needs P2-21)
P2-05 (independent) ───────┘
P2-09 ── P2-10 ── P2-11
P2-12 ── P2-13
P2-14 ── P2-15
P2-16 (independent)
P2-19 ── P2-20
P2-21 ── P2-22
P2-23 ─┬─ P2-24
       └─ P2-18 (also needs P2-17, P2-04)
P2-25 (independent)          P2-26 needs P2-07, P2-11, P2-13, P2-15
P2-27, P2-28, P2-29 need every feature issue      P2-30 needs P2-04, P2-06, P2-07
P2-31 needs P2-06            P2-32 runs last
```

## Batches (three at a time at most)

Issues in the same batch are independent of each other and can run in parallel. Each batch assumes the previous batch's PRs are merged (D8).

| Batch | Issues | Notes |
|---|---|---|
| 1 | P2-01, P2-09, P2-14 | Three independent schema starts. All regenerate `lib/supabase/types.ts` — expect a trivial merge conflict there. |
| 2 | P2-02, P2-03, P2-10 | |
| 3 | P2-04, P2-06, P2-12 | |
| 4 | P2-05, P2-07, P2-11 | |
| 5 | P2-08, P2-13, P2-15 | **Chat, library, archive and familiarity are usable end to end after this batch.** |
| 6 | P2-16, P2-19, P2-21 | |
| 7 | P2-20, P2-22, P2-23 | |
| 8 | P2-17, P2-24, P2-25 | |
| 9 | P2-18, P2-26, P2-27 | |
| 10 | P2-28, P2-29, P2-30 | |
| 11 | P2-31, P2-32 | Gate closes here. |

Shared-file hot spots that cause conflicts between parallel PRs: `lib/supabase/types.ts`, `types/domain.ts`, `tests/support/admin-route-registry.ts`, `lib/security/csp.ts`, `.env.example`.

If the usage budget runs short, the natural stopping points are after batch 5 (core collab features) and after batch 7 (everything except push, offline, polish and the gate).

## Needs human

Nothing here is skipped silently; issues that depend on these say so, and a test that skips for want of a secret is reported as **not run**, not as passing.

| Item | Needed by | What to do |
|---|---|---|
| Enable Supabase Realtime for `chat_messages` and confirm the Clerk JWT is accepted by Realtime (third-party auth setting) on staging and production | P2-06, P2-30, P2-31 | Supabase dashboard |
| Apply the new migrations to staging, then production | every schema issue | Supabase CLI / dashboard |
| Generate a VAPID key pair; set the public/private/subject variables in Vercel (Preview + Production) | P2-17, P2-18 | One command locally, then Vercel dashboard |
| Staging secrets available to the E2E and load runs (Clerk test users, Supabase staging URL/keys) | P2-30, P2-31 | Confirm they are still valid from Phase 1 |
| R2 bucket CORS allows browser `PUT` from the app origin for the new key prefix | P2-10, P2-11 | Cloudflare dashboard — likely already true from song attachments; verify |
| Real-device check on iOS Safari 16+ and Android Chrome (installed PWA, push permission, offline) | P2-18, P2-24, P2-26 | Emulation does not prove these; iOS push only works from an installed PWA |
| Still open from Phase 1: issue #83 (production deploy gate) | Phase 2 launch | Not part of this backlog |

## Summary

| Sprint | Issues | Focus |
|---|---|---|
| 5 — Week Team Chat | 8 | Schema, lifecycle, API, mentions, preference, realtime, screen, pin |
| 6 — Library, Archive & Familiarity | 7 | Global documents, setlist archive, song familiarity |
| 7 — Notifications & Devotions | 7 | Inbox filter, deadline + escalation, YouVersion, push |
| 8 — Offline, Polish & Phase Gate | 10 | Service worker, offline cache, responsive polish, security/test gate |
| **Total** | **32** | |

## Scope item → issue map

| Requested scope | Issues |
|---|---|
| 1. Week team chat | P2-01 – P2-08, P2-30, P2-31 |
| 2. Global document library | P2-09 – P2-11 |
| 3. Past setlist archive | P2-12, P2-13 |
| 4. YouVersion devotion import + manual fallback | P2-21, P2-22 |
| 5. Song familiarity | P2-14, P2-15 |
| 6. PWA offline caching | P2-23, P2-24 |
| 7. Push + inbox filtering by type | P2-16, P2-17, P2-18 |
| 8. Invitation deadline + auto-escalation | P2-19, P2-20 |
| 9. Mobile-responsive polish | P2-25, P2-26 |
| 10. Security and test gate | P2-27 – P2-32 |
