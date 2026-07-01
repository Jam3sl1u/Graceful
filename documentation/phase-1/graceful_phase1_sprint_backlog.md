# Graceful — Phase 1 (Core) Sprint Plan & Issue Backlog

Source: `graceful_phase1_core_prd.docx` only. Nothing from Phases 2–5 is included.

## Assumptions

- **Cadence:** 5 sprints, 1 week each (5 weeks total). The Phase 1 PRD's "2 weeks" estimate assumed one solo, agentic-assisted developer; spreading the same scope across assignable, trackable issues for a small team naturally runs longer once review and parallel ownership are accounted for. Adjust sprint length in GitHub Milestones if your team's velocity differs.
- **Team size:** designed for 2–4 people working in parallel within a sprint. Sprints are sequenced by dependency (you can't build invitations before church groups exist), but issues *within* a sprint are largely parallelizable across people.
- **Granularity:** one issue per shippable unit of work (roughly one PRD "Feature" row, one schema cluster, one security control, or one test category). 58 issues total. Closely related sub-tasks are folded into the same issue as a checklist rather than split into separate issues, since GitHub issues support task lists.
- **Every issue traces back to the Phase 1 PRD** — section, business rule (BR-##), acceptance criterion, or API endpoint — so "why does this exist" is always answerable without re-opening the PRD.

## Milestones to create in GitHub first

| Milestone | Maps to |
|---|---|
| `Phase 1 / Sprint 0 — Foundation` | Repo, infra, schema, auth, RLS scaffolding |
| `Phase 1 / Sprint 1 — Identity & Roles` | Church group, roles, profiles, instruments |
| `Phase 1 / Sprint 2 — Availability & Invitations` | Availability, service weeks, invitation lifecycle, conflicts |
| `Phase 1 / Sprint 3 — Setlists & Events` | Setlist builder, song catalog, events, Google Calendar |
| `Phase 1 / Sprint 4 — Notifications & Launch Readiness` | SMS/email, inbox, Guest flow, PWA, security/perf hardening |

## Labels to create first

- **Type:** `type:infra`, `type:feature`, `type:security`, `type:test`, `type:screen`
- **Area:** `area:auth`, `area:church-group`, `area:scheduling`, `area:setlist`, `area:events`, `area:notifications`, `area:security`, `area:testing`, `area:data-model`
- **Priority:** `priority:p0` (everything in Phase 1 is MVP-critical by definition, so all issues get `priority:p0` unless noted)

---

## Sprint 0 — Foundation (Week 1)

**Goal:** repo, environments, base schema, auth, and RLS scaffolding exist so feature work in Sprint 1 has something to build on. No user-facing feature ships this sprint.

| # | Title | Labels | Description |
|---|---|---|---|
| 1 | Provision third-party accounts & environment config | `type:infra` | Create Vercel, Supabase, Clerk, Pingram, Resend, Cloudflare R2 accounts and a Google Cloud Console project for the Calendar API. Document all env vars in `.env.example` with placeholder values only (PRD §15 — no secrets in source). |
| 2 | Initialize Next.js project & tooling | `type:infra` | App Router project, TypeScript, ESLint, Prettier, base folder structure. |
| 3 | CI pipeline skeleton | `type:infra` | GitHub Actions: TypeScript check, ESLint, Jest, npm audit on every PR (PRD §16). |
| 4 | Staging environment | `type:infra` | Separate Supabase project, test API keys, mirrors production config (PRD §16). |
| 5 | Clerk auth integration | `type:infra` `area:auth` | Sign-up/sign-in flow, JWT issuance, session handling. |
| 6 | JWT verification + role-check middleware | `type:security` `area:auth` | Every API route validates the Clerk JWT before any business logic; reusable role-check helper for Admin/Set Leader/Member/Guest gating (PRD §15). |
| 7 | Schema migration — Cluster 1 (Organization) | `type:infra` `area:data-model` | `church_groups`, `users`, `member_profiles`. Include `user_role` enum (admin, set_leader, member, guest). |
| 8 | Schema migration — Cluster 2 (Instruments) | `type:infra` `area:data-model` | `instruments`, `member_instruments`. |
| 9 | Schema migration — Cluster 3 (Scheduling core) | `type:infra` `area:data-model` | `service_weeks`, `setlists`, `setlist_songs`, `events`, `invitations`, `event_attendees`, `conflicts`. Include `invitation_status`, `event_type`, `resolution_type`, `setlist_status` enums. |
| 10 | Schema migration — Cluster 4 (partial: Music & Files) | `type:infra` `area:data-model` | `songs`, `song_documents` only (the general `documents` table is out of scope — Phase 2). |
| 11 | Schema migration — Cluster 5 (partial: Communication & State) | `type:infra` `area:data-model` | `availability`, `notification_preferences`, `notifications`. Include `vocal_capability`, `chat_pref` enums. |
| 12 | Schema migration — Cluster 6 (Auth & Audit) | `type:infra` `area:data-model` | `google_calendar_tokens`, `audit_logs`. |
| 13 | RLS policies on every Phase 1 table | `type:security` `area:security` | `church_group_id`-scoped SELECT/INSERT/UPDATE/DELETE policy on every table from issues #7–12 except `church_groups` itself. This is the single most critical security primitive in the app (PRD §15). |
| 14 | Disable PostgREST auto-API; lock down service role key | `type:security` `area:security` | Confirm Supabase's auto-generated REST API is off and the service-role key never appears in user-callable code. |

---

## Sprint 1 — Identity, Church Group & Roles (Week 2)

**Goal:** a user can sign up, create or join a church group, and the 4-role permission model is enforced everywhere it needs to be.

| # | Title | Labels | Description |
|---|---|---|---|
| 15 | Church group creation | `type:feature` `area:church-group` | `PUT /api/church-group`. Name, timezone, optional denomination/logo, unique invite code generation. Creator becomes the first admin. |
| 16 | Join church group via invite code | `type:feature` `area:church-group` | `POST /api/church-group/join`. Creates a user with role `member`. |
| 17 | Member directory | `type:feature` `area:church-group` | `GET /api/church-group/members` + directory screen. Instruments, vocal capability, live availability status; contact details admin-only. |
| 18 | Role assignment & multi-admin support | `type:feature` `area:church-group` | `PATCH /api/church-group/members/:id/role`. Enforce BR-12 (at least one admin always exists, last admin cannot be demoted) and BR-03/BR-04 (any number of co-admins, admin-to-admin invitations follow the standard flow). |
| 19 | Remove / archive member | `type:feature` `area:church-group` | `DELETE /api/church-group/members/:id`. PII anonymized, historical setlist/scheduling data retained. |
| 20 | Audit log writer + read endpoint | `type:feature` `area:security` | Shared audit-log utility called from every mutating route; `GET /api/church-group/audit-log` (paginated, admin-only). Enforce BR-13 (append-only, immutable). |
| 21 | Member profile CRUD | `type:feature` `area:church-group` | `GET/PUT /api/profile`. Vocal capability (lead/harmony/both), bio. |
| 22 | Instrument list management | `type:feature` `area:church-group` | Seed 9 defaults on group creation; `GET/POST /api/instruments`, `POST /api/instruments/custom` (member-submitted), `POST /api/instruments/:id/promote` (admin), `DELETE /api/instruments/:id`. |
| 23 | API auth-matrix tests — Sprint 0–1 routes | `type:test` `area:testing` | For every route created so far: valid admin, valid member hitting an admin route (expect 403), unauthenticated (expect 401), malformed input (expect 400). |
| 24 | RLS bypass tests — Sprint 0–1 tables | `type:test` `area:testing` | Construct direct queries with a Church A JWT attempting to read/write Church B data on every table created so far. All must return empty/error. |

---

## Sprint 2 — Availability & Invitations (Week 3)

**Goal:** a Set Leader can build a roster against real availability data, and the full invitation lifecycle — send, accept, deny, remind, conflict — works end to end.

| # | Title | Labels | Description |
|---|---|---|---|
| 25 | Availability set/get | `type:feature` `area:scheduling` | `GET/PUT /api/availability`. Weekly and per-day, plus monthly blocks. Admin can pass `user_id` to view a specific member's. |
| 26 | Availability delete-to-unset | `type:feature` `area:scheduling` | `DELETE /api/availability/:date`. Enforce BR-15 — clearing a declaration on a date with an accepted invitation triggers the same conflict flow as marking unavailable. |
| 27 | Team availability grid | `type:feature` `area:scheduling` | `GET /api/availability/team`. Powers the roster-planning view for a date range. |
| 28 | Service week CRUD | `type:feature` `area:scheduling` | `GET/POST/PUT /api/service-weeks(/:id)`. |
| 29 | Service week hard-delete (BR-16) | `type:feature` `area:scheduling` | `DELETE /api/service-weeks/:id`. Only allowed if `service_date` is future AND zero accepted invitations; 409 + redirect-to-cancel otherwise. |
| 30 | Service week cancel/reactivate (BR-17) | `type:feature` `area:scheduling` | `POST /api/service-weeks/:id/cancel` and `/reactivate`. Cancellation preserves all data, flips `is_cancelled`, notifies pending/accepted invitees. |
| 31 | Send set invitation | `type:feature` `area:scheduling` | `POST /api/invitations`. Checks double-booking (BR-05) and warns before sending; generates `response_token` with 72h expiry. |
| 32 | Accept invitation | `type:feature` `area:scheduling` | `POST /api/invitations/:id/accept`. Via token or session; adds to roster, syncs to Google Calendar if connected (stub the GCal call — full sync ships Sprint 3). |
| 33 | Deny invitation with reason | `type:feature` `area:scheduling` | `POST /api/invitations/:id/deny`. Optional 200-char reason; enforce BR-08 (max 3 denials per member per week). |
| 34 | Withdraw invitation | `type:feature` `area:scheduling` | `DELETE /api/invitations/:id`. Member notified, slot reopens. |
| 35 | Token-based public invitation lookup | `type:feature` `area:scheduling` | `GET /api/invitations/respond/:token`. No session required — powers the SMS/email link flow. |
| 36 | 24-hour dual-party reminder scheduler | `type:feature` `area:scheduling` | Repeats every 24h to both member and admin until response or withdrawal, then cancels immediately. |
| 37 | Conflict detection on availability change | `type:feature` `area:scheduling` | Auto-creates a `conflicts` record when a confirmed member marks unavailable for a date they're scheduled on. |
| 38 | Conflict resolution flow | `type:feature` `area:scheduling` | `GET /api/conflicts`, `POST /api/conflicts/:id/resolve` — withdraw / member_reconfirmed / admin_dismissed paths. |
| 39 | Week View screen (Admin / Set Leader) | `type:screen` `area:scheduling` | Roster grid with status badges, availability sidebar, events timeline stub, setlist preview card stub. |
| 40 | Invitation Response screen | `type:screen` `area:scheduling` | Mobile-first, no-login-required, token-driven. 44×44px minimum touch targets on accept/decline (PRD §14.3, A-08). |
| 41 | Conflict Resolution screen | `type:screen` `area:scheduling` | Member name, date, reason, three resolution-path buttons. |
| 42 | Invitation state machine unit tests | `type:test` `area:testing` | All valid transitions (pending→accepted/denied/withdrawn) and invalid ones (must throw, not silently fail). |
| 43 | E2E — invitation & conflict flows | `type:test` `area:testing` | Admin sends invite → member accepts/denies → roster updates; 24h reminder flow (time-mocked); conflict detection flow. |

---

## Sprint 3 — Setlists, Songs & Events (Week 4)

**Goal:** a Set Leader can build and publish a setlist, and schedule events that sync to Google Calendar.

| # | Title | Labels | Description |
|---|---|---|---|
| 44 | Song catalog CRUD + search | `type:feature` `area:setlist` | `GET/POST /api/songs`. Title, artist, default key, BPM, tags. |
| 45 | Draft setlist creation | `type:feature` `area:setlist` | `GET/POST /api/service-weeks/:id/setlist`. |
| 46 | Add / remove / reorder setlist songs | `type:feature` `area:setlist` | `PUT /api/setlists/:id`, `POST /api/setlists/:id/songs`, `DELETE /api/setlists/:id/songs/:songId`. Enforce BR-07 (no duplicate songs); recompact position values on removal. |
| 47 | Publish setlist | `type:feature` `area:setlist` | `POST /api/setlists/:id/publish`. Enforce BR-01 (zero-song setlists publishable); re-notification confirmation required when editing a published setlist. |
| 48 | Per-song key override + validation | `type:feature` `area:setlist` | Enforce BR-09 — key must be one of the 12 valid musical keys, rejected with 422 otherwise. |
| 49 | Song-level document attachment | `type:feature` `area:setlist` | `POST /api/songs/:id/documents(/upload-url)`, `DELETE /api/songs/:id/documents/:docId`. Reuses the signed-URL pattern (30-min expiry). |
| 50 | Event CRUD | `type:feature` `area:events` | `GET/POST/PUT/DELETE /api/events(/:id)`. Pre-practice, rehearsal, sound check, service types. Enforce BR-10 (end after start, both within 72h of service date). |
| 51 | Event attendee assignment | `type:feature` `area:events` | `POST/DELETE /api/events/:id/attendees(/:userId)`. |
| 52 | Google Calendar OAuth connect/disconnect | `type:feature` `area:events` | `POST /api/google-calendar/connect`, `GET /callback`, `DELETE /disconnect`. Write-only `calendar.events` scope; AES-256 token encryption at rest. |
| 53 | Google Calendar event sync | `type:feature` `area:events` | Wire the Sprint 2 accept/event-create/update/delete paths to actually push to Google Calendar; graceful degradation + re-auth prompt on revoked token. |
| 54 | iCal (.ics) export fallback | `type:feature` `area:events` | For members who don't connect Google Calendar. |
| 55 | Setlist Builder screen | `type:screen` `area:setlist` | Desktop-first: song search/quick-add panel + ordered setlist panel with key override and drag handle. |
| 56 | Member Week View screen | `type:screen` `area:scheduling` | Mobile: confirmation status, setlist (if published), assigned events, team roster. |
| 57 | E2E — setlist & calendar flows | `type:test` `area:testing` | Setlist publish (including zero-song case), Google Calendar sync (create + update propagation), duplicate-song rejection. |

---

## Sprint 4 — Notifications, Guest Flow & Launch Readiness (Week 5)

**Goal:** every Phase 1 notification fires through the right channel, Guests have a working scoped flow, the in-app inbox works for all 4 roles, and the phase clears its full security/performance gate.

| # | Title | Labels | Description |
|---|---|---|---|
| 58 | Pingram SMS integration | `type:feature` `area:notifications` | Outbound dispatch + delivery-status webhook with signature verification. |
| 59 | Resend email integration | `type:feature` `area:notifications` | Outbound dispatch + delivery webhook. |
| 60 | Notification trigger logic — all Phase 1 event types | `type:feature` `area:notifications` | Invitation sent / reminder / accepted / denied, practice reminder, setlist released, scheduling conflict, Google Calendar event — per the PRD §6.9 trigger table. |
| 61 | Notification preferences | `type:feature` `area:notifications` | Channel per type (SMS/email/in-app), reminder lead time, GCal sync toggle. Enforce BR-14 (at least one invitation channel always active). |
| 62 | In-app notification inbox | `type:feature` `area:notifications` | `GET /api/notifications`, `/unread-count`, `PATCH /:id/read`, `POST /mark-all-read`. Always-on regardless of SMS/email settings; works for all 4 roles, Guest inbox scoped to their invited week. |
| 63 | Guest invitation flow | `type:feature` `area:scheduling` | Existing-user vs. new-user branch; scoped read access grant (setlist, events, roster, week documents) on acceptance; never appears on the music roster. |
| 64 | Notification Inbox screen | `type:screen` `area:notifications` | Unread badge, deep-link on tap, mark-all-read. |
| 65 | Admin Global Dashboard screen | `type:screen` `area:church-group` | All upcoming/recent service weeks group-wide, roster fill rate, open conflicts — delivers the Admin persona's "visibility into everything without being scheduled" requirement. |
| 66 | PWA manifest & install prompt | `type:feature` `area:church-group` | "Add to Home Screen" on iOS and Android; icon, full-screen launch, no browser chrome. |
| 67 | Rate limiting | `type:security` `area:security` | Stricter limits on auth endpoints, SMS-triggering endpoints, and general write endpoints. |
| 68 | Input validation audit (Zod) | `type:security` `area:security` | Every Phase 1 route validated against a schema; no raw SQL/template strings built from user input. |
| 69 | Infrastructure security pass | `type:security` `area:security` | HTTPS enforcement, CSP headers, secret-scanning of git history before first deploy, documented key-rotation plan. |
| 70 | OWASP Top 10 manual review | `type:test` `area:security` | A01 Broken Access Control, A02 Cryptographic Failures, A03 Injection, A05 Security Misconfiguration, A07 Auth Failures — documented findings and resolutions. |
| 71 | Auth-bypass & RLS-bypass test suites — full Phase 1 | `type:test` `area:testing` | Every admin route × every table, run as a dedicated pre-launch gate (not just per-PR). |
| 72 | Performance test pass | `type:test` `area:testing` | k6 load test at 100 concurrent users against all p95 targets (PRD §14.1); notification delivery latency with 50 simultaneous sends; signed URL generation under 200ms. |
| 73 | Full E2E regression pass | `type:test` `area:testing` | Every critical path in PRD §16, run together as a single pre-launch suite rather than per-sprint slices. |
| 74 | Production deploy gate | `type:infra` | Staging smoke-test suite + manual approval step + documented Vercel rollback procedure (PRD §16). |

---

## Summary

| Sprint | Issues | Focus |
|---|---|---|
| 0 — Foundation | 14 | Infra, schema, auth, RLS |
| 1 — Identity & Roles | 10 | Church group, roles, profiles, instruments |
| 2 — Availability & Invitations | 19 | Availability, invitations, reminders, conflicts |
| 3 — Setlists & Events | 14 | Setlists, songs, events, Google Calendar |
| 4 — Notifications & Launch Readiness | 17 | SMS/email, inbox, Guest flow, PWA, security/perf gate |
| **Total** | **58** | |

## Next step

Once GitHub access is connected, each row above becomes one `gh issue create` call (or equivalent API call) with the title, labels, milestone, and description shown — body text will also include the relevant PRD business rule / acceptance criterion / API endpoint reference so context isn't lost outside the document. Say the word once the connector is set up and I'll create all 58 issues plus the 5 milestones and label set in the `Graceful` repo.
