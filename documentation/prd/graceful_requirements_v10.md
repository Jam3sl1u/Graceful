# Graceful — Product Requirements Document

**DRAFT v0.10**

*Scheduling, setlist management, and music coordination for churches, ministries, and bands*

## Document Information

| Field | Value |
| --- | --- |
| **Product name** | Graceful |
| **Author** | James Liu |
| **Date** | June 26–27, 2026 |
| **Version** | v0.10 — Draft |
| **Status** | Working draft — not finalized |
| **Intended audience** | CRU campus ministries, churches, worship bands |

## Revision History

| Ver | Date | Author | Changes |
| --- | --- | --- | --- |
| v0.1 | Jun 1 2026 | James Liu | Initial draft: product overview, two user roles (admin / member), admin scheduling features, member features, notification system with SMS + email channels. |
| v0.2 | Jun 8 2026 | James Liu | Added: accept / deny invitation flow, default instrument list (9 options), Graceful brand name, church group feature with global shared library, free-tier cost notes and upgrade path table. |
| v0.3 | Jun 15 2026 | James Liu | Added: three separate AI pipelines (music transcription, member scheduling, setlist prediction), web-first / PWA platform decision, Google Calendar sync, three audio sources for transcription (upload / YouTube / Spotify metadata), 24hr dual-party reminders, custom instrument submission flow, formal out-of-scope section. |
| v0.4 | Jun 22 2026 | James Liu | Added: free-tier scalability notes with upgrade triggers, Modal GPU pipeline concurrency design (max cap, queue position, job timeout, memory-safe processing), full Security Requirements section (7 subsections: RLS, file storage, API authorization, pipeline SSRF, OAuth, data privacy, infrastructure), full Testing & QA section (6 subsections: unit, E2E, security, performance, CI/CD, pipeline accuracy regression). |
| v0.5 | Jun 26–27 2026 | James Liu | Added: table of contents, full document metadata (author, date, audience), revision history with notes per version, expanded product vision (broader audience: churches / ministries / bands, competitor positioning), new Problem Statement section, new Goals & Success Metrics section (success and failure criteria), new Assumptions & Constraints section, updated User Personas with functional need descriptions for worship leader and worship team member. |
| v0.6 | Jun 27 2026 | James Liu | Added: Acceptance Criteria (14 items, Given/When/Then format), Business Rules (14 rules covering zero-song setlists, no-member teams, multi-leader sets, double-booking prevention), Error States & Edge Cases (12 scenarios with system behavior, user message, and recovery path), full Non-Functional Requirements section (performance targets, availability/SLA with Monday maintenance window, WCAG 2.1 AA accessibility, localisation scope, browser/device support matrix), Monitoring & Observability as a named Phase 5, Notification Content Templates, Timeline Estimates (2 weeks/phase), Risk Register (8 risks), and a 20-term Glossary. |
| v0.7 | Jun 27 2026 | James Liu | Added: AI Pipeline 4 (sermon topic song suggestion), four user types (Admin, Set Leader, Member, Guest) replacing the original two-role model with a full permission matrix, renamed Worship Leader to Set Leader throughout, new Admin and Guest personas, in-app notification inbox for all users, daily check-in/practice-tracking feature marked explicitly out of scope, first-login feature walkthrough marked as a beta-phase feature. |
| v0.8 | Jun 29 2026 | James Liu | SMS provider confirmed as Pingram (free tier: 100 SMS/month, no credit card, handles US A2P 10DLC registration end-to-end). All prior Twilio references updated throughout the document. Future migration to a more robust/scalable SMS provider added as an explicit out-of-scope item for when volume or reliability needs grow. |
| v0.9 | Jun 29 2026 | James Liu | Added: System Architecture (Section 19 — 7-layer component breakdown, full from/to connection table, 4 critical architecture rules), Data Model / Schema (Section 20 — all 24 tables fully documented across 6 clusters with columns/types/nullability, 9 enums, relationships summary), User Flows (Section 21 — 6 flows fully stepped out with actor/action/outcome). Companion files for interactive diagrams: graceful_architecture.xml, graceful_schema.dbml, graceful_flows.xml (paste into app.diagrams.net / dbdiagram.io). Corrected section numbering drift inherited from v0.6–v0.8 across Sections 9–31. users.email changed to nullable — guest accounts can now be created by phone only. Backfilled this revision history table, which had silently stopped updating after v0.5. |
| v0.10 | Jun 29 2026 | James Liu | Added: full API Specifications (Section 22 — ~55 endpoints across 14 resource areas), Wireframes / Screen Descriptions (Section 23 — 8 screens including a new Admin Global Dashboard closing a gap against the Admin persona), Migration & Onboarding Strategy (Section 24 — 4-phase rollout plan for moving a real team off WhatsApp/Sheets). New: DELETE endpoints for availability (BR-15, reverts to unset — not just toggling false), service weeks (BR-16, restricted to future+zero-accepted-invitation weeks) plus a new cancel/reactivate flow (BR-17, preserves historical data for AI training), setlist songs, song documents, and transcription jobs (new 'cancelled' job_status enum value, native Modal cancellation for in-flight jobs). New BR-15 through BR-17. New service_weeks.is_cancelled column. Fixed two stale references found during audit: an Assumptions bullet still said 'three AI pipelines' (now four), an error-state example still referenced Twilio (now Pingram). Schema changes reflected in companion file graceful_schema.dbml. |

---

# 1. Product Vision

Graceful centralizes all coordination work surrounding a worship service — who is playing, what songs are performed in what key, when and where practice happens, and what documents the team needs. Musicians must accept their invitation before the schedule is finalized.

The platform is built for churches, campus ministries (such as CRU), and worship bands who need to organize their weekly sets, coordinate music, and communicate as a team. It is not limited to Sunday morning church services — any recurring ministry or band that manages a rotating roster, a setlist, and shared music resources is a target user.

Graceful exists because every comparable product on the market is either too expensive for a volunteer ministry budget, too complex for a team of part-time musicians, or lacks the smart integrations — AI-powered scheduling suggestions, audio-to-sheet-music transcription, devotional imports, intelligent conflict resolution — that a modern ministry team should have access to without paying enterprise prices.

Everything is organized around a Church Group, the top-level entity that holds all members, past setlists, the song library, and shared documents. The platform is web-first — fully mobile-responsive and installable as a PWA on any phone home screen — with a native mobile app as a future milestone after the product is validated.

| 4 User roles | 4 AI pipelines | 24 DB tables | 4 Build phases | 3 Audio sources | 0 Vendor lock-in | PWA Mobile approach |
| --- | --- | --- | --- | --- | --- | --- |

# 2. Problem Statement

## 2.1 Existing Solutions Are Limited and Restrictive

Several products attempt to address worship team coordination — Planning Center Online, Elvanto, and ChurchTeams are the most common. These tools are built for large institutional churches with paid administrative staff, not for volunteer-led teams with part-time worship leaders and a $0/month tool budget. Their limitations fall into three categories:

- Access is gated behind expensive pricing tiers. Planning Center Online starts at $49/month and gates key features like unlimited scheduling behind higher tiers. For a small campus ministry or church plant with no budget, this is simply inaccessible.
- They are over-engineered for the use case. These platforms manage entire church operations — giving, children's ministry, facility bookings, check-in systems. A worship leader trying to schedule six musicians for Sunday ends up navigating a platform built for a team of full-time staff.
- They lack smart integrations. None offer AI-powered scheduling suggestions, audio-to-sheet-music transcription, or intelligent conflict resolution. They are scheduling tools, not intelligent coordination platforms.

## 2.2 The Real Pain: Accessibility and Flexibility

The pain Graceful addresses is not just inconvenience — it is the gap between what ministry teams need and what they can afford or access. A worship leader who is also a full-time teacher, nurse, or engineer should not have to spend $50-150/month for software that still requires them to manage everything manually.

Graceful is custom software built by someone in ministry, for someone in ministry. It is designed around the actual workflow of a volunteer worship team — not the workflow of a church administration department. Every feature exists because someone actually needed it on a Tuesday night trying to figure out who is playing guitar on Sunday.

## 2.3 Why Existing Solutions Are Inadequate

| Product | Monthly cost | Core limitation | What Graceful does instead |
| --- | --- | --- | --- |
| **Planning Center Online** | $49-149/month | Expensive, complex, built for paid church staff | Free-tier-first. Built for volunteer teams. Core features in Phase 1 cost ~$3-8/month. |
| **Elvanto / ChurchTeams** | $50-200/month | Full church management suite — overkill for a worship team | Scoped specifically to music coordination. No bloat. |
| **WhatsApp + Google Sheets** | Free | No confirmation flow, no setlist management, no document organization | Formal invitation flow with accept/deny, structured setlists, organized document library. |
| **No AI features anywhere** | N/A | Zero AI-powered assistance in any existing product in this category | Three AI pipelines: transcription, scheduling, setlist prediction. |

# 3. Goals & Success Metrics

## 3.1 Definition of Success

Success for Graceful is not a specific user count or revenue target — it is a product that actually works and that real ministry teams actually use. The following criteria define success at each phase:

- Each phase reaches usability in deployment — it can be given to a real team and used in a real service week without workarounds.
- The platform reaches real users — at least one active church, campus ministry, or worship band is using Graceful in production.
- All internal tests pass and all security measures are validated before each phase is considered complete.
- Timeline target: each phase should be completable in approximately one week of focused development. No hard deadline is set — the goal is quality over speed.

## 3.2 Definition of Failure

The following outcomes constitute failure and must be avoided. They are treated as blocking issues that halt development until resolved:

- The platform is exploited for bugs or security vulnerabilities before or after launch.
- Internal tests fail between phases — no phase ships with known failing tests.
- Security issues or data leaks occur in production. Any exposure of member PII, church scheduling data, or credentials is an immediate rollback event.
- Real users have consistently bad feedback — not 'this feature is missing' but 'this product does not work' or 'this is harder than what I was using before.'
- Deployments fail in staging or production and cannot be resolved quickly — rollback procedures must work and must be tested.

# 4. Assumptions & Constraints

## 4.1 Assumptions

The following are assumed to be true for this project to succeed. If any of these prove false during development, the relevant requirements should be revisited.

- The project runs on no monthly budget. All infrastructure choices prioritize free tiers. Monthly infrastructure cost is out of scope as a budget item — the platform should cost $0/month to operate during development and as close to $0 as possible in early production.
- AI integrations actually work. The four AI pipelines (transcription, member scheduling, setlist prediction, sermon-topic song suggestion) are technically feasible with the chosen tools. It may take time to develop and tune each pipeline, but they are assumed to be buildable. Timeline estimate for each: ideally no more than one week of focused development per pipeline at the appropriate phase.
- The development environment supports Python 3.11, Node.js 18+, and GPU access via Modal without additional setup.
- Supabase, Vercel, Clerk, Cloudflare R2, Pingram, and Resend all remain available on their current free tiers for the duration of Phase 1-2 development.

## 4.2 Hard Limits — Things That Cannot Change

The following constraints are fixed. Features or timelines that conflict with these limits must be adapted, not the limits themselves.

- The project must be completed. Scope may be reduced between phases, but the platform must reach a shippable Phase 1 state.
- Due dates may be extended. The one-week-per-phase estimate is a target, not a hard deadline. If a phase requires more time to be done correctly — tests passing, security validated, real-world usable — the timeline extends. Shipping broken phases is not acceptable.
- Development approach will grow from agentic-assisted coding toward independent development. Early phases will rely more heavily on AI-assisted (agentic / vibe) coding. As the developer gains experience with the stack and codebase, later phases should require less AI assistance and more direct, independent development.
- No native iOS or Android app in Phases 1-3. The PWA approach is fixed for the foreseeable future.
- Single-church architecture for Phases 1-4. Multi-tenancy is explicitly out of scope until validated.

# 5. User Personas

Four distinct user types in Graceful. Each has different permissions, different needs, and a different relationship to any given service week.

## Persona 1 — Admin

**The Admin.** The person who created the church group, or someone assigned as admin by another admin. *Responsible for the health and structure of the whole group — not necessarily involved in individual sets.*

**What defines this role:** Whoever creates the church group is automatically the first admin. Additional admins can be assigned by any existing admin. Has visibility into all weekly events across the church group at all times — without needing to be added to any specific set. Does not have to be added as a musician or vocalist to any set. Can observe all events and manage the group without participating in worship. Is the only user type that can assign and change user roles. Set Leaders and Members have no permission to change anyone's role. There must always be at least one admin in a church group — the last admin cannot be demoted or removed.

*A successful role: the group runs smoothly, set leaders have what they need, and membership and permissions are always clean.*

## Persona 2 — Set Leader

**The Set Leader.** The person responsible for planning and leading a specific weekly set. May or may not be the group Admin. *Often a volunteer with a full-time job who gives 10-15 hours a week to ministry. Currently managing everything through WhatsApp and spreadsheets.*

**What they need from Graceful:** Organize and build the team roster for each week — see who is available, send invitations, and get confirmed responses without chasing people over text. Easy access to AI-transcribed sheet music in any key for any song, so every musician on the set has the resources they need without the worship leader spending hours formatting chord charts. Set the week's full schedule — practices, sound check, service — with locations, times, and automatic calendar sync to every team member. Internal team communication through a dedicated week chat, without relying on personal group texts that get cluttered and buried. Share biblical encouragement and devotionals with the team directly through the platform to build spiritual community alongside the logistics.

*A successful week: roster confirmed by Monday, setlist published by Wednesday, team has all resources and devotional by Thursday, no scrambling Saturday night.*

## Persona 3 — Member / Musician

**The Team Member.** Volunteer musician or vocalist serving on the worship team at a church, campus ministry, or band. *Has a full-time schedule that changes week to week. Wants to serve faithfully but needs clarity and flexibility — not more group chats.*

**What they need from Graceful:** Know when they are playing and what they are playing — a clear view of their service week with all events, setlist, and key information in one place on their phone. Set their availability week to week and mark which instruments or vocal parts they can cover, so the worship leader has accurate information without a back-and-forth conversation. Clearly accept or decline set invitations — with one tap, from their phone — without the awkwardness of a text message decline. Access all music — chord charts, sheet music, instrumentals — transcribed and organized by the worship leader. Members can also submit their own songs for transcription if they want to suggest music for the team. Stay connected with the team through internal communication — a week-specific group chat so conversations are organized — and receive the worship leader's devotionals to align spiritually before the service.

*A successful week: knows by Tuesday they are on the set, has the chord chart by Thursday, shows up to practice prepared, no missed messages.*

## Persona 4 — Guest

**The Guest.** A speaker, preacher, or non-worship participant invited to a specific service week. *Not a musician. Needs context about the week — the schedule, what the team is preparing, any relevant coordination — without full member access.*

**What defines this role:** Reserved for speakers, pastors, or non-worship participants who are part of a specific service week but not playing or singing. Must receive a formal invitation and accept it before gaining access to the week's details. Cannot self-join a week. Once accepted, has the same read access as a Member for that specific week: can see the setlist, events, team roster, week chat, and shared documents. Does not appear on the music roster. Cannot be assigned an instrument or vocal role. Not included in musician-specific notifications like setlist release reminders. Cannot manage availability, cannot send invitations, and cannot change any settings for the group.

*A successful role: the speaker knows what time to arrive, what the service flow looks like, and can communicate with the team — without needing a separate group chat.*

# 6. Acceptance Criteria

Industry-standard Given / When / Then format. These are binding — QA uses them to determine if a feature is done. A feature is not shippable until all its acceptance criteria pass.

| Feature | Given | When | Then |
| --- | --- | --- | --- |
| **Send set invitation** | Admin has selected a member for a service week role | Admin clicks Send Invitation | Member receives SMS within 60 seconds containing their name, service date, role note, and unique accept/deny links. Links expire in 72 hours. Roster slot shows Pending. Invitation appears in member's in-app notification list. Audit log records the action with admin ID and timestamp. |
| **Accept invitation** | Member has a pending invitation and taps the accept link (via SMS or in-app) | Member confirms acceptance | Status changes to Confirmed within 5 seconds. Admin receives in-app notification. Member added to week roster. All assigned events synced to member's Google Calendar if connected. Member gains access to the week team chat. Audit log records acceptance with timestamp and response time from invitation creation. |
| **Deny invitation** | Member has a pending invitation and taps the deny link | Member submits denial with optional reason (max 200 characters) | Status changes to Denied within 5 seconds. Roster slot reopens and shows Open. Admin receives SMS + email within 60 seconds with member name and reason if provided. Member not added to any event attendees. No Google Calendar events created. Audit log records denial. |
| **24hr unanswered reminder** | An invitation has been Pending for 24 hours | The 24hr timer fires | Member receives SMS reminder. Admin receives notification listing all pending invitations for the week by name. Cycle repeats every 24 hours. When member responds or admin withdraws, all future reminders for that invitation cancel immediately. |
| **Publish setlist (zero songs allowed)** | A setlist exists — may have zero songs | Admin clicks Publish | Status changes to Published. All confirmed members receive SMS + email within 60 seconds. If zero songs, notification reads: 'Setlist for [date] has been released — songs are still being added.' Setlist becomes visible to confirmed members. Admin must confirm before editing a published setlist. |
| **Empty set team (no members)** | A service week exists with no invitations sent or confirmed | Admin publishes setlist or views roster | Roster shows all slots as Open with no error or blocking state. Setlist can still be published. No notifications sent if zero members are confirmed. Week is valid and usable. |
| **Multiple worship leaders on a set** | A church group has two or more admin-role users | One worship leader invites another admin-role user to the week's roster | Invited worship leader receives the invitation as normal. On acceptance, they appear on the roster in their role. They retain full admin capabilities — editing setlist, inviting others, creating events — while also being a confirmed roster member. Admin role is global, not per-week. |
| **Worship leader assigns another worship leader** | Admin A selects Admin B for a week's roster | Admin A sends the invitation | Admin B receives a standard set invitation. Admin B can accept or deny as any member would. If Admin B accepts, they appear on the roster. Admin B retains all admin functions for that week. |
| **Member double-booking prevention** | Member A is already confirmed for a service week that includes date X | Admin attempts to invite Member A to a second service week that also includes date X | System displays warning: 'This member is already confirmed for another set on [date]. Sending this invitation may create a conflict.' Admin can proceed or cancel. If admin proceeds and member accepts, both invitations show Confirmed and a conflict flag is raised automatically on the overlapping date. |
| **Document access (signed URL)** | A document exists in the church group library | Any confirmed member of that church group requests to view it | API verifies authentication and church group membership. Signed URL generated with 30-minute expiry. Document opens in browser. After 30 minutes, URL returns 403. Next access request silently regenerates a new URL. A user from a different church group cannot generate a signed URL for this document under any circumstances. |
| **Member library access** | Any member of a church group regardless of scheduling status | Member navigates to the document library or member directory | Member sees all current members of the church group: name, instruments, vocal capability, availability status. Contact details (email/phone) visible to admins only. All documents, songs, and transcribed music in the shared library accessible at all times, not only during scheduled weeks. |
| **Transcription job (pipeline up)** | Admin submits a valid audio file with target key selected | Job is created | Job enters queue with position displayed. GPU worker picks it up within the concurrency cap. On success: PDF stored in R2, attached to song in library, admin notified in-app, source audio permanently deleted within 60 seconds. On failure: admin notified with error message, source audio deleted, retry option shown. |
| **Transcription job (pipeline down)** | The transcription pipeline (Modal) is unavailable | Admin submits a transcription job | Job fails immediately — not queued. Admin sees: 'Sheet music generation is temporarily unavailable. We're working on it — please try again later.' Error logged automatically for developers. No audio file uploaded or retained. Admin can retry at any time. |
| **RLS enforcement** | Authenticated user from Church Group A | Attempts to read, write, or delete any data belonging to Church Group B via any method | Response is empty result set for reads, 403 for writes/deletes. No Church Group B data returned or modified. Verified for every table in the security test suite before each phase launch. |

# 7. Business Rules

Domain constraints enforced at the API layer. The UI not showing a button is not a business rule — these must be validated on the server before any write operation. A request that violates a business rule returns 422 with a descriptive error.

| ID | Business rule | Rationale |
| --- | --- | --- |
| **BR-01** | A setlist can have zero songs and still be published. | A worship leader may choose to release a week with no songs finalized yet. The team is notified that songs are still being added. |
| **BR-02** | A set team can have zero confirmed members. | An empty roster is a valid state. A service week can exist and be managed without any musicians confirmed. |
| **BR-03** | A set team can have multiple worship leaders (admin-role users) simultaneously. | Co-leadership is a common ministry structure. Any number of admins can serve on the same week's roster. |
| **BR-04** | A worship leader can assign any other worship leader to a set as a roster member. | Admin-to-admin invitations follow the same invitation flow as admin-to-member. The invited admin retains their global admin permissions while also being a confirmed roster member for that week. |
| **BR-05** | A member cannot be double-booked for two service weeks that share the same calendar date. | If a member is already confirmed for a week that includes date X, they cannot be confirmed for a second week with date X. The system warns the admin before sending a conflicting invitation. |
| **BR-06** | All members of a church group have permanent access to the full member directory, document library, song catalog, and all transcribed sheet music. | Access to shared resources is tied to group membership, not to being scheduled for a specific week. Any member can browse the library at any time. |
| **BR-07** | A setlist cannot contain the same song more than once. | Each song appears at most once per service. If a worship leader attempts to add a duplicate, the system rejects it with a clear message. |
| **BR-08** | A member who has denied an invitation for a specific service week cannot be re-invited more than 3 times for that same week. | Prevents repeated invitations after a member has clearly indicated unavailability. After 3 denials, the slot must be filled by someone else. |
| **BR-09** | Song keys must be valid musical keys: C, C♯, D♭, D, D♯, E♭, E, F, F♯, G♭, G, G♯, A♭, A, A♯, B♭, B. | Any key value outside this set is rejected at the API layer. This prevents invalid data that would break the transposition engine. |
| **BR-10** | An event's end time must be after its start time. Both must fall within 72 hours of the service week's service date. | Prevents nonsensical event data such as events that start after they end or events scheduled weeks away from their service week. |
| **BR-11** | Audio files submitted for transcription must pass server-side MIME validation as a recognized audio format (MP3, WAV, M4A, FLAC). File extension alone is not sufficient. | Prevents malicious or corrupted files from entering the transcription pipeline. Validation runs before any file is stored or queued. |
| **BR-12** | A church group must have at least one admin at all times. The last remaining admin cannot be demoted to member. | Prevents the church group from becoming unmanageable with no one able to send invitations, publish setlists, or manage members. |
| **BR-13** | Audit log entries are immutable. No user — including admins — can edit or delete audit log records. | Preserves the integrity of the accountability trail. Audit logs are append-only at the database layer. |
| **BR-14** | A member must keep at least one delivery channel enabled for invitation notifications. The channel can be SMS, email, or in-app notification — but at least one must remain active. | Ensures members always receive set invitations through at least one channel. Prevents a member from being silently unreachable when a worship leader sends an invitation. |
| **BR-15** | Deleting an availability record for a date with an accepted invitation triggers the same conflict-detection flow as explicitly marking that date unavailable. | From the admin's perspective, losing a member's availability confirmation is functionally identical to that member becoming unavailable — both mean the admin can no longer rely on the member showing up. Treating them identically avoids a gap where a quiet deletion could go unnoticed. |
| **BR-16** | A service week can only be hard-deleted if its service_date is in the future AND it has zero accepted invitations. Weeks with accepted invitations or a past service date can only be cancelled, never deleted. | Service week data feeds AI Pipelines 2 and 3 (member scheduling, setlist prediction), which depend on permanent historical records. Hard deletion is reserved for genuine mistakes made before anyone was invited — not a way to erase real scheduling history. |
| **BR-17** | Cancelling a service week (as opposed to deleting it) preserves all underlying data — setlist, events, invitations, conflicts — and only flips a status flag. It notifies every member with a pending or accepted invitation and archives the week's chat room immediately. | Cancellation covers the real-world case of an already-scheduled service that won't happen (holiday, building closed, etc.). The historical record stays intact for audit and AI training purposes; only the live coordination activity (calendar sync, chat) stops. |

# 8. Error States & Edge Cases

Every error has a defined system behavior, a user-facing message, and a recovery path. Developers must not design error handling independently — these definitions are binding. All error events are logged automatically.

| Error scenario | System behavior | User-facing message | Recovery path |
| --- | --- | --- | --- |
| **Sheet music pipeline down (Modal unavailable)** | Job rejected before entering queue. Error event logged with timestamp and stack trace. Developer alert fires. | Sheet music generation is temporarily unavailable. We're working on it — please try again later. | Admin can retry at any time. Error log visible to developers in monitoring dashboard. No audio file uploaded or retained. |
| **Third-party service temporarily unavailable** | Return 503 with a service category label. Error logged. Retry logic applied where applicable (3 retries with backoff). | [Music/Calendar/Notification] service is temporarily unavailable. Please try again in a moment. | Note: message uses functional label ('Calendar service', 'Notification service') not the vendor name (Google, Pingram). User retries; app recovers automatically when service comes back. |
| **Google Calendar token invalid or expired** | Sync stops. Token flagged as invalid in DB. Member notified with re-auth prompt. Graceful continues functioning normally without calendar sync. | Your Google Calendar connection needs to be refreshed. Tap here to reconnect. | Member taps the re-auth prompt, completes OAuth flow. All missed events synced retroactively after reconnection. |
| **Transcription job failed (pipeline error)** | Job status set to failed. Source audio permanently deleted. Error details logged for developers. Admin receives notification. | Transcription failed. Please try again, or upload a different audio file. | Admin can resubmit the job. If three consecutive failures occur on the same file, admin is prompted to try a different audio source. |
| **Member accesses document from different church group** | 403 returned before any file URL is generated. Attempt logged in audit log. | You don't have access to this document. | No recovery needed. If the member believes this is an error, they contact their worship leader. |
| **Accept/deny link used after already responding** | Return current invitation status without error or additional side effects. | You've already [accepted / declined] this invitation. View your current schedule in the app. | No recovery needed. Link is informational after first use. |
| **Audio file fails MIME validation (wrong format or corrupted)** | Rejected at upload before any file is stored or queue entry created. | This file couldn't be read as audio. Please upload an MP3, WAV, or M4A file. | Admin selects a valid audio file and re-uploads. |
| **YouTube video is private, removed, or age-restricted** | yt-dlp extraction fails immediately. No file retained. Error logged. | We couldn't access that video — it may be private or unavailable. Please use a public YouTube video or upload a file directly. | Admin uses a different YouTube URL or uploads an audio file directly. |
| **Chat message exceeds 2000 characters** | Rejected at API layer. Partial message not stored. | Message is too long. Please keep messages under 2000 characters. | Member shortens the message and resubmits. |
| **Database unreachable (Supabase connection timeout)** | Return 503. Error logged with full context. Uptime monitor fires alert. | Something went wrong on our end. Please try again in a moment. | App retries automatically. Uptime monitor pages on-call. Users retry after a brief wait. |
| **Member profile has no instruments or vocal capability listed** | Invitation can still be sent. Admin sees a non-blocking warning before sending. | This member hasn't listed any instruments or vocal ability. They can still be invited, but consider checking with them first. | Admin proceeds with the invitation or contacts the member first. Member can update their profile at any time. |
| **Job queue unavailable (Upstash Redis unreachable)** | Transcription job submission fails. 503 returned. No audio uploaded. | Sheet music generation is temporarily unavailable. Please try again shortly. | Admin retries when the queue recovers. Alert fires automatically for developer. |

# 9. Platform Approach

## 9.1 Web-First

Graceful is built as a web application (Next.js). The web app is fully mobile-responsive and will be the primary interface for all users — both worship leaders on desktop and musicians on their phones.

| Feature | Phase | Description |
| --- | --- | --- |
| **Responsive web app** | MVP | Fully mobile-optimized layout. All core workflows (accept invitation, view setlist, access documents, chat) are usable on a phone browser. |
| **PWA install prompt** | MVP | Members are prompted to 'Add to Home Screen' on iOS and Android, giving the app a native feel — icon on the home screen, full-screen launch, no browser chrome. |
| **Offline reading (PWA)** | Ph.2 | Service worker caches the current week's setlist, documents, and event details for offline access in low-connectivity venues. |
| **Native iOS / Android app** | — | Out of scope. PWA covers the mobile use case. A native app can be built with React Native (Expo) after the product is validated. |

# 10. User Roles

Four roles exist in Graceful. Only Admins can assign or change any user's role — Set Leaders and Members have no permission to modify roles. See Section 5 for full persona descriptions.

**Admin**
- Creates the church group (first admin) or is assigned by another admin
- Only role that can assign, change, or remove user roles
- Visibility into ALL weekly events across the group without being added to any set
- Does not have to be added as a musician or vocalist to participate
- Can manage group membership, instruments, documents, and settings
- Receives all admin-level alerts (conflicts, unanswered invitations, security events)
- At least one admin must exist at all times

**Set Leader**
- Renamed from 'Worship Leader' — more broadly applicable across performing groups
- Builds setlists, selects keys, attaches resources to songs
- Sends set invitations to Members and Guests; manages accept/deny flow
- Creates and manages events (practice, sound check, service) with Google Calendar sync
- Publishes setlists and controls when the team sees the song lineup
- Receives conflict alerts and AI replacement suggestions (Phase 4)
- Cannot assign or change user roles — that is Admin only

**Member**
- Volunteer musician or vocalist serving on the team
- Accepts or declines set invitations with one tap
- Manages own weekly and monthly availability
- Lists instruments and vocal capability on their profile
- Accesses published setlists, chord charts, sheet music, and documents
- Participates in week team chat once confirmed
- Cannot assign or change user roles — that is Admin only

**Guest**
- Reserved for speakers, pastors, or non-worship participants
- Must receive a formal invitation and accept it to see the week
- Once accepted: same read access as a Member for that specific week
- Does NOT appear on the music roster — no instrument or vocal role
- Can view setlist, events, roster, week chat, and shared documents
- Access is scoped to the specific invited week only
- Cannot manage availability, send invitations, or change any group settings

## 10.1 Role Permission Summary

| Permission | Admin | Set Leader | Member | Guest |
| --- | --- | --- | --- | --- |
| **Assign / change user roles** | ✓ | ✗ | ✗ | ✗ |
| **View all weekly events (all sets)** | ✓ | ✗ | ✗ | ✗ |
| **Build and publish setlists** | ✓ | ✓ | ✗ | ✗ |
| **Send set invitations** | ✓ | ✓ | ✗ | ✗ |
| **Create and manage events** | ✓ | ✓ | ✗ | ✗ |
| **Manage song library and documents** | ✓ | ✓ | ✗ | ✗ |
| **Accept or deny set invitations** | ✓ | ✓ | ✓ | ✓ |
| **Manage own availability** | ✓ | ✓ | ✓ | ✗ |
| **Access published setlist (own week)** | ✓ | ✓ | ✓ | ✓ |
| **Access week team chat (own week)** | ✓ | ✓ | ✓ | ✓ |
| **Access shared document library** | ✓ | ✓ | ✓ | ✓* |
| **Appear on music roster** | opt | ✓ | ✓ | ✗ |
| **Manage group membership / settings** | ✓ | ✗ | ✗ | ✗ |

\* Guest document access is scoped to documents shared for their specific invited week only, not the full church group library.

# 11. Church Group

The Church Group is the top-level organizational unit. Everything — members, setlists, the song library, instrument lists, and shared documents — belongs to the group. When a member joins, they immediately have access to the shared library built up over time.

## 11.1 Group Membership

| Feature | Phase | Description |
| --- | --- | --- |
| **Create a church group** | MVP | Admin creates the group with a name, timezone, and optionally a denomination and logo. The group gets a unique join link. |
| **Invite members** | MVP | Admins share the join link or send direct email invites. Members claim their account and are auto-linked to the group. |
| **Member directory** | MVP | Full list of all members with instruments, vocal capability, and live availability status. |
| **Multiple admins** | Ph.2 | Any member can be promoted to admin — useful for co-worship-leaders or associate directors. |
| **Remove / archive member** | MVP | Admin can remove a member. Their historical data (past setlists, documents they were part of) is retained. |

## 11.2 Global Shared Library

The church group maintains a persistent shared library accessible to all members at any time, separate from per-week setlist access.

| Feature | Phase | Description |
| --- | --- | --- |
| **Song catalog** | MVP | All songs ever used by the church group — title, artist, default key, BPM, tags, and linked resources. Grows over time. Worship leaders pull from this when building setlists. |
| **Shared document storage** | MVP | Folder-based library of all music documents: chord charts, sheet music PDFs, instrumental tracks, and recordings. Stored in Cloudflare R2. All members can browse; only admins can add or remove files. |
| **Past setlist archive** | MVP | Every published setlist archived and searchable by date, songs included, and who was on the set. |
| **Transcribed sheet music** | Ph.3 | All AI-generated sheet music stored here, organized by song and tagged with the key it was generated in. |
| **Other shared files** | MVP | Admins can upload any file (announcements, training guides, etc.) to a general section of the library visible to all members. |

## 11.3 Instrument List Management

The church group maintains a global instrument list that all members see when setting up their profile. It starts with nine defaults and can be extended by admins.

- Acoustic guitar
- Electric guitar
- Bass guitar
- Piano / keyboard
- Violin
- Vocalists
- Drums
- Cajon
- Other — custom field

- Members can type a custom instrument name in the Other field when it is not in the list.
- Admins can promote any custom instrument to the church group's global list, making it a default option for all members going forward.
- Multiple members can play the same instrument in a given week — the list is a profile declaration, not an exclusive slot.

# 12. Admin & Set Leader Features

## 12.1 Set Invitation & Confirmation Flow

When the worship leader selects a musician for a week's roster, they are sending an invitation, not confirming. A musician is only confirmed once they have explicitly accepted. Unanswered invitations escalate every 24 hours to both parties.

| Feature | Phase | Description |
| --- | --- | --- |
| **Send set invitation** | MVP | Admin picks a member for a role. Member receives SMS + email with accept and deny options. Slot shows as Pending until responded. |
| **24hr unanswered alert** | MVP | Every 24 hours an invitation goes unanswered, both the member AND the worship leader are alerted. This repeats until the member responds or the admin withdraws the invitation. |
| **View pending/confirmed** | MVP | Roster view shows status per slot: Pending, Confirmed, or Declined. Admin sees the full picture at a glance. |
| **Re-invite on denial** | MVP | When a member declines, their slot reopens. Admin is notified with the reason (if provided) and an AI replacement suggestion (Phase 4). |
| **Withdraw invitation** | MVP | Admin can withdraw a pending invitation at any time — member is notified and the slot reopens. |
| **Invitation deadline** | Ph.2 | Admin can set a hard response deadline per week. After the deadline, unreplied invitations are auto-escalated with a final alert to both parties. |

## 12.2 Conflict Detection & AI Replacement Suggestions

A conflict occurs when a confirmed member changes their availability or becomes unavailable after accepting. Graceful detects this immediately and notifies the admin with an AI-powered replacement suggestion in Phase 4.

| Feature | Phase | Description |
| --- | --- | --- |
| **Automatic conflict detection** | MVP | When a confirmed member marks themselves unavailable for a date they are scheduled on, the conflict is flagged instantly. |
| **Admin conflict alert** | MVP | Admin receives SMS + email with the member's name, affected event, and their reason (if provided). |
| **AI replacement suggestion** | Ph.4 | Phase 4 Member Scheduling model suggests the best available member to fill the open role based on availability, instrument match, past scheduling history, and workload balance. |
| **Manual replacement** | MVP | Admin can always pick a replacement manually from the member directory regardless of AI suggestions. |

## 12.3 Setlist & Song Management

| Feature | Phase | Description |
| --- | --- | --- |
| **Build and publish setlists** | MVP | Create setlists per service week. Private until admin publishes — all confirmed members are then notified. |
| **Song library (church-wide)** | MVP | Pull from the church group's global song catalog when building a setlist. Add songs on the fly. |
| **Per-song key selection** | MVP | Set the performance key per song per service. The audio pipeline (Phase 3) auto-transposes sheet music to this key. |
| **Attach resources to songs** | MVP | Link chord charts, PDFs, instrumentals, and recordings to any song. Files live in the shared library. |
| **Song order drag-and-drop** | MVP | Reorder songs with drag-and-drop. Order locks at publish but can be amended with a notification to confirmed members. |

## 12.4 Event Scheduling & Google Calendar Sync

| Feature | Phase | Description |
| --- | --- | --- |
| **Create events** | MVP | Event types: pre-practice, full rehearsal, sound check, and service/performance. Each has a type, location, start/end time, and notes. |
| **Assign events to members** | MVP | Control which confirmed members are expected at each event. Assigned members are notified and the event is synced to their Google Calendar. |
| **Google Calendar API sync** | MVP | All events created in Graceful are synced to each assigned member's Google Calendar via OAuth. Updates and cancellations sync automatically. |
| **Week calendar view** | MVP | Full weekly timeline of all events, attendees, locations, and the linked setlist. |
| **iCal export fallback** | MVP | Members who do not connect Google Calendar can download an .ics file to import into any calendar app. |

# 13. Member / Musician Features

## 13.1 Set Invitation Response

Members receive an invitation when selected for a week. They must respond explicitly — the roster is not finalized until everyone has answered.

| Feature | Phase | Description |
| --- | --- | --- |
| **Receive invitation** | MVP | Notified via SMS and email with a link to review the invitation — week, events, and the role they are invited for. |
| **Accept** | MVP | One-tap acceptance confirms the member. Admin is notified. The member is added to the confirmed roster. |
| **Deny with reason** | MVP | Member can decline and optionally include a brief reason. Admin is notified immediately with the reason. Slot reopens. |
| **In-app response** | MVP | Members can also accept or deny from within the app on their schedule view, not just from the notification link. |
| **24hr reminder** | MVP | Every 24 hours of silence, both the member and the worship leader are reminded — keeping everyone accountable without being one-sided. |

## 13.2 In-App Notification Inbox

Every user has a persistent notification inbox. This inbox collects all notifications regardless of whether SMS or email delivery is enabled — external delivery settings control additional channels, but the inbox is always active and always complete.

| Feature | Phase | Description |
| --- | --- | --- |
| **Universal inbox** | MVP | All system notifications appear in every user's inbox: invitations, reminders, setlist releases, conflict alerts, transcription completions, chat mentions. Inbox is always on regardless of SMS or email preferences. |
| **Unread count badge** | MVP | The inbox icon in the main navigation shows a count of unread notifications. Clears when the inbox is opened or individual notifications are tapped. |
| **Direct deep-link on tap** | MVP | Tapping a notification opens the relevant screen directly: an invitation notification opens the accept/deny flow, a setlist notification opens the setlist, a conflict alert opens the roster view. |
| **All 4 user types have inboxes** | MVP | Admins, Set Leaders, Members, and Guests all have their own inbox. Guest inboxes only contain notifications scoped to their invited weeks. |
| **Filter by type** | Ph.2 | Users can filter inbox by notification category: Invitations, Setlists, Events, Chat, System alerts. |

## 13.3 Availability Management

| Feature | Phase | Description |
| --- | --- | --- |
| **Set weekly availability** | MVP | Mark available or unavailable per week or per day. Can update at any time — changes after confirming trigger a conflict alert to the admin. |
| **Set monthly blocks** | MVP | Mark extended unavailability (vacation, recurring commitments) weeks in advance. |
| **Conflict alert to admin** | MVP | If a confirmed member goes unavailable, admin is immediately notified with an AI replacement suggestion (Phase 4). |

## 13.4 Profile & Instruments

| Feature | Phase | Description |
| --- | --- | --- |
| **Select instruments** | MVP | Members select from the church group's global instrument list. Multiple selections allowed. |
| **Add custom instrument** | MVP | Members can type a custom instrument name if it is not in the global list. The custom entry is saved to their profile. |
| **Admin promotes to global** | MVP | Admins can add any member-submitted custom instrument to the church group's global list, making it available to all members going forward. |
| **Vocal capability** | MVP | Members indicate if they can sing lead, harmonize, or both. |
| **Song familiarity** | Ph.2 | Members can mark songs in the library as comfortable, learning, or not yet learned. |

## 13.5 Access & Visibility

| Feature | Phase | Description |
| --- | --- | --- |
| **View week roster** | MVP | Who is confirmed for the week — names, roles, instruments. Pending invitations show as awaiting confirmation. |
| **Access published setlist** | MVP | Visible only after admin publishes. Shows song order, keys, and notes. |
| **Document library access** | MVP | All resources shared by the admin plus the full church group shared library. |
| **Event calendar view** | MVP | All events the member is confirmed for, with Google Calendar sync active. |

# 14. Notification System

Delivered via SMS (Pingram) and email (Resend) in Phase 1. Google Calendar sync is also Phase 1. In-app push is added in Phase 2.

| Notification | Recipients | Channel | Trigger |
| --- | --- | --- | --- |
| **Set invitation** | Member | SMS + Email | When admin selects them for a week's roster. |
| **Invitation reminder** | Member + Admin | SMS | Every 24 hours the invitation goes unanswered — sent to both the member and the worship leader until responded. |
| **Invitation accepted** | Admin | In-app | When a member accepts their set invitation. |
| **Invitation denied** | Admin | SMS + Email | When a member denies — includes AI replacement suggestion (Phase 4). |
| **Practice reminder** | Confirmed members | SMS + Email | Configurable lead time before each event (24hr, 2hr, etc.). |
| **Setlist released** | All confirmed | SMS + Email | When admin publishes the setlist for the week. |
| **Scheduling conflict** | Admin only | SMS + Email | Member changes availability post-acceptance — includes AI replacement suggestion (Phase 4). |
| **Chat mention** | Mentioned member | Push + in-app | When @mentioned in the week team chat. |
| **Devotion shared** | All confirmed | Email + in-app | When a Bible app devotion is imported and posted to the week. |
| **New church document** | All members | In-app | When a document is added to the global church group library. |
| **Google Calendar event** | Confirmed members | Email + GCal | When an event is created or updated — synced to each member's Google Calendar. |

## 14.1 User Preferences

- Choose SMS, email, or both per notification type
- Set reminder lead time for events (24 hours, 2 hours, 30 minutes, etc.)
- Chat notifications: all messages or mentions only (default: mentions only)
- Google Calendar sync: on/off per member (requires one-time OAuth connection)

# 15. Special Features

## 15.1 Week Team Chat

| Feature | Phase | Description |
| --- | --- | --- |
| **Per-week group chat** | MVP | Auto-created when the first member confirms. Includes all confirmed members and the worship leader. Archived after the service. |
| **@mention support** | MVP | Tagging a member always triggers a notification regardless of their general chat preference. |
| **Notification preferences** | MVP | Per-user: all messages or mentions only (default). |
| **Admin broadcast pin** | Ph.2 | Worship leader can pin an announcement at the top of the week chat. |

## 15.2 Bible App Devotion Import

| Feature | Phase | Description |
| --- | --- | --- |
| **YouVersion import** | Ph.2 | Pull a shared Bible plan, verse, or devotion from YouVersion and post it to the week team chat and email. |
| **Manual link fallback** | Ph.2 | Paste a YouVersion share link — Graceful previews the content before posting. |

## 15.3 Audio Sources for Sheet Music Pipeline

The sheet music transcription pipeline (Section 16) accepts audio from three different sources. The worship leader picks whichever is most convenient.

| Feature | Phase | Description |
| --- | --- | --- |
| **Direct audio upload** | Ph.3 | Upload an MP3, WAV, or M4A file directly. Cleanest path — no third-party dependencies, no legal ambiguity. Recommended default. |
| **YouTube audio extraction** | Ph.3 | Worship leader pastes a YouTube URL. Graceful uses yt-dlp on the Python worker to extract the audio. Note: yt-dlp may conflict with YouTube's Terms of Service — this is used solely for internal transcription, not redistribution. Church is responsible for ensuring they have rights to use the content. |
| **Spotify metadata assist** | Ph.3 | Spotify API is used for song search and metadata only (title, artist, BPM, key, album art, genre). Spotify does not provide full audio via API — the actual audio for transcription must still come from a direct upload or YouTube extraction. Spotify is the lookup layer, not the audio source. |

# 16. Audio to Sheet Music — Technical Pipeline

The pipeline separates the song into individual stems before transcribing each independently. This is what makes it more accurate than off-the-shelf tools that attempt full-mix transcription. It is one of four AI systems in Graceful (see Section 17).

## 16.1 Five-Stage Pipeline

1. **Source separation** — Split the full mix into stems: vocals, drums, bass, guitar, piano, and other. Transcribing a dense mix directly is the root cause of inaccuracy in off-the-shelf tools. *Tools: Meta Demucs (htdemucs_6s) — 6 stems*
2. **Per-stem note detection** — Each stem is transcribed independently. Monophonic stems (bass, vocals) use CREPE for fundamental frequency tracking. Polyphonic stems (piano, guitar, other) use Spotify Basic Pitch with frequency-constrained thresholds per stem type. *Tools: CREPE (monophonic) + Spotify Basic Pitch (polyphonic)*
3. **Quantization & beat tracking** — Align raw note events to a musical beat grid. Detect tempo (BPM) and time signature so output renders as proper notation with correct bar lines and rhythmic values. *Tools: madmom (RNN beat tracking) + librosa.beat*
4. **Key detection & transposition** — Detect the original key automatically. Transpose all note data to whatever key the worship leader selected for this song in the platform. *Tools: music21 + Krumhansl-Schmuckler key profiles*
5. **Notation rendering & export** — Convert quantized, transposed MIDI to MusicXML, engrave into a PDF. Output stored in Cloudflare R2 and auto-attached to the song in the church group library. *Tools: music21 + MuseScore CLI + Cloudflare R2*

## 16.2 Accuracy Levels

| Feature | Phase | Description |
| --- | --- | --- |
| **Level 1 — No training** | Ph.3 | Separation + per-stem frequency constraints (bass capped at 300Hz, etc.). Outperforms most commercial tools on dense material with zero training data. |
| **Level 2 — Fine-tune Basic Pitch** | Ph.3 | Fine-tune on Slakh2100 (synthesized multi-instrument audio + MIDI) to build per-instrument detectors matched to Demucs stem types. |
| **Level 3 — Refinement model** | Ph.4 | A second neural model that takes Basic Pitch output + raw spectral features and produces cleaned note events trained against ground-truth MIDI. |

## 16.3 Evaluation

- mir_eval — note-level precision, recall, and F1 with onset tolerance. Required for every pipeline change.
- MAESTRO — piano recordings with perfectly aligned MIDI. Clean baseline for the full chain.
- Slakh2100 — synthesized multi-instrument stems with MIDI ground truth. Primary benchmark for per-stem accuracy.

# 17. AI Systems

Graceful contains four distinct AI pipelines (updated in v0.7 to include Pipeline 4: Sermon Topic Song Suggestion). Each has its own architecture, training data requirements, and delivery phase. They are built and deployed independently.

| Pipeline | Name | Type | Data needs | Phase |
| --- | --- | --- | --- | --- |
| **Pipeline 1** | Music Transcription | DSP + ML | Trains on public datasets — no Graceful user data needed | Ph.3 |
| **Pipeline 2** | Member Scheduling | Recommendation model | Needs 3-6 months of scheduling history | Ph.4 |
| **Pipeline 3** | Setlist Prediction | Compatibility + sequencing model | Needs extensive setlist history | Ph.4 |

## 17.1 Pipeline 1 — Music Transcription

Converts audio into transposed sheet music PDF. This pipeline is fully independent — it trains on public music datasets and does not require any Graceful user data. It is the furthest along in design and the first AI feature that ships.

| Aspect | Detail |
| --- | --- |
| **Inputs** | Audio file (MP3/WAV/M4A), target key selected by worship leader |
| **Outputs** | Transposed PDF sheet music, MIDI file (optional), attached to song in library |
| **Training data** | MAESTRO (piano, public), Slakh2100 (multi-instrument, public), GuitarSet, MusicNet. No Graceful data required. |
| **Architecture** | Demucs (source sep) → CREPE / Basic Pitch (note detection) → madmom (beat) → music21 (key/transpose) → MuseScore (render) |
| **Target phase** | Level 1-2 in Phase 3. Level 3 refinement model in Phase 4. |

## 17.2 Pipeline 2 — Member Scheduling Model

Predicts who should be invited for a given week and suggests replacement members when someone denies an invitation or drops out after confirming. This is what powers the AI replacement suggestion in conflict and denial notifications.

| Aspect | Detail |
| --- | --- |
| **Inputs** | Member profiles (instruments, vocal capability), availability history, past roster assignments, who filled in for whom, attendance outcomes, workload balance per member |
| **Outputs** | Ranked roster suggestion for a given week, ranked fill-in suggestions when a slot opens (with availability and instrument match score) |
| **Training data** | Graceful scheduling history — minimum 3-6 months of real data before the model is meaningfully predictive. Cannot be trained on synthetic data. |
| **Architecture** | Feature-based classification or collaborative filtering. Input features: instrument match, availability score, days since last scheduled, past cancellation rate, fill-in history. Output: ranked candidate list per role. |
| **Target phase** | Phase 4. Requires Phase 1 to have been running for at least one full season (3-6 months) with a consistent team. |

## 17.3 Pipeline 3 — Setlist Prediction Model

The most complex of the three. Solves two related problems: which songs work well together in a service (song-to-song compatibility), and which people perform which songs well together (person-to-song and team compatibility). Eventually it can suggest a full draft setlist given a team composition and a theme.

| Aspect | Detail |
| --- | --- |
| **Inputs** | Song metadata (BPM, key, genre, tags, mood), past setlist sequences and order, team composition per week, setlist feedback signals (if added), song familiarity ratings from members |
| **Outputs** | Song suggestions for a given team + service theme, song ordering recommendations, compatibility scores for proposed pairings, team-to-song affinity scores |
| **Training data** | Graceful setlist history (extensive — needs at least 6-12 months and 50+ distinct setlists before useful signal emerges). Song metadata can be pre-seeded from Spotify API. External worship music datasets (e.g. SongSelect metadata) may help cold-start. |
| **Architecture** | Two sub-models: (1) Song-to-song compatibility — embedding model trained on setlist co-occurrence and ordering patterns. (2) Person-to-song / team affinity — relational model using member-song history, instrument coverage, and outcome feedback. Both can share a song embedding space. |
| **Target phase** | Phase 4. Lowest priority of the three pipelines — requires the most data and the longest collection window. Do not design for it in Phase 1-3 beyond ensuring the data is being logged correctly. |

## 17.4 Pipeline 4 — Sermon Topic Song Suggestion

Takes the sermon topic, scripture references, and service theme and suggests songs from the church group's library that complement the message. A Set Leader planning around a specific biblical theme gets ranked suggestions instead of manually browsing the catalog.

| Aspect | Detail |
| --- | --- |
| **Inputs** | Sermon title, topic or theme summary, scripture references, speaker name, service date context, church group's full song catalog with tags, genre, mood, and past usage. |
| **Outputs** | Ranked song suggestions from the library with a plain-language explanation per suggestion (e.g. 'Suggested because it shares the theme of redemption and references Romans 8'). Optionally surfaces songs from a broader catalog if no strong library matches exist. |
| **Training data** | Historical pairings of sermon topics with songs chosen by Set Leaders in Graceful. External corpus of worship planning resources. Song metadata enriched from Spotify and the church group's own tags. Cannot be trained until meaningful setlist and service history exists from Phase 1-2. |
| **Architecture** | NLP embedding model (e.g. sentence-transformers) encoding sermon text into a semantic vector. Song catalog encoded with the same model using title, tags, themes, and usage history. Cosine similarity search returns ranked matches. Optional RAG layer using a small LLM to generate natural-language explanations. |
| **Evaluation** | Manual quality review by Set Leaders using real sermon notes. Tracking of whether suggested songs are actually chosen. Feedback loop: Set Leader rates each suggestion (used / ignored / irrelevant) to improve future results. |
| **Sermon topic field** | A sermon topic/theme field is added to the service week creation form in Phase 1. This field is not used for AI in Phase 1 — it only becomes the input for Pipeline 4 in Phase 4. Logging it from day one ensures the data exists when needed. |
| **Target phase** | Phase 4. Lowest implementation effort of the four pipelines once the embedding infrastructure from Pipeline 3 is in place. Both share the same song vector space. |

## 17.5 Data Logging Requirements (Phase 1 foundation)

All four AI pipelines depend on structured historical data. The following must be logged from day one in Phase 1, even though the models are not built until Phase 4:

- Every invitation sent: member, week, role, timestamp
- Every accept/deny: response, reason, time-to-respond
- Every conflict and fill-in: who replaced whom, when, for what role
- Every setlist: songs in order, keys, team composition, date
- Every event attendance: who showed up, who did not
- Song familiarity ratings when members submit them
- Any setlist feedback the worship leader provides (optional but valuable)

# 18. Tech Stack & Costs

Stack is fully confirmed and free-tier-first. Real cost estimate for a typical church team: $0/month in Phase 1 (Pingram free tier covers beta SMS volume). Costs rise only when volume exceeds free tier limits or Phase 3 GPU compute begins.

| Service | Free tier | Paid starts at | Notes & scalability |
| --- | --- | --- | --- |
| **Vercel** | 100GB bandwidth, unlimited deploys, serverless functions | $20/mo Pro | Hosts Next.js frontend + API routes. Free tier covers a small-to-medium church with ease. |
| **Supabase** | 500MB DB, 1GB storage, 50k MAU, 2M realtime msgs/mo | $25/mo Pro | All-in-one: Postgres, auth, file storage, and realtime chat. Pro removes the inactivity pause on idle projects. |
| **Clerk (Auth)** | 10,000 MAU free | $25/mo | Role-based auth. 10k MAU covers most churches indefinitely on the free tier. |
| **Resend (Email)** | 3,000 emails/mo, 100/day free | $20/mo (50k emails) | Transactional email. 3k/mo is enough for a church team on Phase 1-2. |
| **Pingram (SMS)** | 100 SMS + 100 calls/month free. No credit card required. | Pay per SMS after free tier | Purpose-built for transactional product-to-user SMS. Handles US A2P 10DLC registration end-to-end. Free tier covers all Phase 1-2 beta usage. Same API pattern as all major SMS providers — migration later is a 1-hour code change. |
| **Google Calendar** | Free (Google Calendar API) | Free up to quota | 10M requests/day on free tier — far beyond any church's needs. Standard OAuth flow. |
| **Upstash Redis** | 10,000 req/day free | $0.20/100k req | Powers BullMQ job queue for transcription. Free tier covers dev and early production. |
| **Upstash QStash** | 500 messages/day free | $1/100k msgs | Durable job scheduling. 500/day = enough for dozens of song uploads per day. |
| **Cloudflare R2** | 10GB storage, 10M writes, 100M reads free — zero egress | $0.015/GB/mo | Church document and sheet music storage. Zero egress fees. 10GB covers thousands of PDFs. |
| **Modal (GPU)** | $30 free GPU credits/mo | Pay per second | Runs Demucs + Basic Pitch on GPU. Full song transcription costs ~$0.01-0.05. $30/mo = 600-3000 songs free. |
| **yt-dlp** | Free, open source | Free | YouTube audio extraction. No cost — note ToS considerations (see Section 8). Self-hosted on the Python worker. |
| **Spotify API** | Free (metadata only) | Free up to quota | Used for song search and metadata only (title, BPM, key, album art). Full audio is not available via API. |

✅ SMS provider confirmed: Pingram. Free tier (100 SMS/month, no credit card) covers all Phase 1-2 beta usage. A2P 10DLC registration is handled by Pingram end-to-end, removing a common friction point. When volume exceeds the free tier or reliability requirements grow, migrating to Telnyx or another provider is a 1-hour code change — the API pattern is identical across all major SMS providers.

### Phase cost estimates

- Phase 1 (core scheduling + setlist): $0/month — Pingram free tier (100 SMS/month) covers Phase 1 beta. Everything else free.
- Phase 2 (+ chat + documents): ~$3-8/month — Supabase and Cloudflare R2 free tiers cover small-scale use
- Phase 3 (+ audio pipeline): +$1-5/month — Modal GPU compute at ~$0.01-0.05/song transcription
- Phase 4 (+ AI model serving): TBD on inference volume — Modal per-second billing keeps costs low at church scale

## 18.1 Free-Tier Scalability Notes

All free-tier services used in Phase 1-3 have clear, low-friction upgrade paths. Hitting these ceilings is a good problem — it means the platform is growing. These upgrade decisions are deferred and out of scope until needed, but the thresholds below make the trigger points explicit.

| Service | Free limit | Upgrade trigger | Upgrade path |
| --- | --- | --- | --- |
| **Supabase** | 500MB DB, 1GB storage, 2M realtime msgs/mo | DB nearing 400MB, chat volume spikes, or inactivity pause becomes painful | $25/mo Pro — no architecture change, plan upgrade only |
| **Vercel** | 100GB bandwidth, 100GB-hrs compute | Traffic grows beyond early-adopter church use | $20/mo Pro — no architecture change |
| **Cloudflare R2** | 10GB storage, zero egress | Document library exceeds ~8GB (thousands of PDFs) | $0.015/GB/mo — linear cost, no migration needed |
| **Clerk** | 10,000 MAU | Only relevant if multi-church is enabled in future | $25/mo — single church will never hit 10k MAU |
| **Upstash Redis** | 10,000 req/day | High transcription job volume in Phase 3 | $0.20/100k requests — pay per use, no plan change |

Action item: when building the data model in Phase 1, add church_group_id as a foreign key on every table and enforce it through Supabase RLS policies from the first migration. This is the single most important scalability preparation — retrofitting it later is a painful and risky refactor.

## 18.2 Python Pipeline — Concurrency & Memory Design

The audio transcription pipeline runs on Modal GPU workers. Each job is memory-intensive — Demucs alone requires approximately 4GB of RAM per concurrent job — and can run 2-5 minutes per song. Concurrency design must be explicit from Phase 3 to prevent resource exhaustion and ensure fair queue behavior.

| Feature | Phase | Description |
| --- | --- | --- |
| **Max concurrency cap** | Ph.3 | Modal workers are configured with an explicit max concurrent job limit (recommend starting at 3-5). Jobs beyond this limit wait in the queue rather than being rejected. The cap is configurable without a code deploy. |
| **Queue with position feedback** | Ph.3 | When a transcription job is submitted and the queue is full, the UI shows the user their position in queue and a time estimate. The job status is polled via the API and updated in real time. |
| **Job timeout handling** | Ph.3 | Each job has a hard timeout (10 minutes). If a job exceeds this — due to an unusually long or complex audio file — it is marked as failed, the user is notified, and the slot is freed. No silent hangs. |
| **Memory-safe stem processing** | Ph.3 | Demucs processes one stem at a time in memory, not all six simultaneously. Stems are written to disk after separation and loaded individually for transcription, keeping peak RAM usage bounded. |
| **Audio file size limit** | Ph.3 | Uploaded audio files are capped at 50MB (approximately 50 minutes of MP3 audio). Files exceeding this limit are rejected at upload with a clear error message before entering the queue. |
| **Job queue persistence** | Ph.3 | The BullMQ job queue is backed by Upstash Redis with persistence enabled. If the Modal worker crashes mid-job, the job is retried up to 2 times before being marked as failed. No jobs are silently lost. |
| **Horizontal scaling path** | — | Out of scope for Phase 3. If volume grows (multi-church future), Modal's autoscaling can spin additional workers automatically. The queue architecture supports this without any changes to the job format. |

# 19. System Architecture

Graceful is a layered web application with an isolated Python ML worker. The browser never communicates with any backend service except the Next.js API — every other connection is mediated through it. This section documents every component and connection. A visual diagram is provided as a companion file.

> 📁 Companion file: `graceful_architecture.xml` — paste into app.diagrams.net (Extras → Edit Diagram → paste → OK) for the interactive visual version.

## 19.1 Layer Overview & Components

Seven layers, each with a distinct responsibility. No layer skips past its neighbor — every request flows through the layer above it.

| Layer | Component | Role |
| --- | --- | --- |
| **Client** | Browser / PWA | React frontend. The ONLY thing that runs here. Never talks directly to Supabase, Pingram, Resend, Spotify, Modal, or Cloudflare R2 — every action goes through Next.js API routes. |
| **Auth** | Clerk | Issues the JWT on login. Every Next.js API route verifies this token before doing anything else. Stores the user's role claim so it can be read from the token without a database query. |
| **Application** | Vercel / Next.js | Hosts both frontend (SSR pages) and backend (API routes as serverless functions) as one deployable unit. All business logic, auth checks, and role validation live here. |
| **Data** | Supabase PostgreSQL | Primary database. All relational data. RLS policies on every table enforce church_group_id isolation as a second line of defense behind the API. |
| **Data** | Supabase Realtime | WebSocket layer for live chat. Browsers subscribe to a channel scoped to a chat_room_id. New messages broadcast instantly to all subscribers. |
| **Storage** | Cloudflare R2 | All file storage — documents, sheet music PDFs, instrumentals, temporary uploaded audio. All buckets private. Access only via signed URLs (30-min expiry) generated by the API. |
| **Async** | Upstash Redis | Backs the BullMQ job queue for transcription. Persistent — jobs survive worker crashes. API enqueues; Modal worker dequeues. |
| **Async** | Modal GPU Worker | Isolated Python 3.11 container running the 5-stage transcription pipeline. NO access to Supabase. Reaches only: Redis (queue), R2 (pre-signed upload URL), and one API webhook endpoint. |
| **External** | Pingram | SMS dispatch. API calls outbound; Pingram calls back via delivery-status webhook. |
| **External** | Resend | Email dispatch. Same webhook pattern as Pingram. |
| **External** | Google Calendar API | OAuth event sync, write-only scope (calendar.events). API calls outbound using encrypted tokens stored per member. |
| **External** | Spotify API | Read-only metadata enrichment (title, BPM, key, album art). Never provides audio. API key stays server-side. |
| **Monitoring** | Sentry / Vercel Analytics / Better Uptime | Phase 5. Passive observers — not in the main request path. Capture errors, performance, and uptime. |

## 19.2 Component Connections & Data Flows

Every arrow is labeled with what it carries. The most important rule in the whole diagram: every arrow from the client layer terminates at Next.js — never at any backend service directly.

| From | To | Carries / Triggers |
| --- | --- | --- |
| Browser | Clerk | Login / signup. Returns JWT, stored client-side, attached to every subsequent API request. |
| Browser | Next.js API | Every data request. The only path the browser has to the backend. |
| Next.js API | Clerk | Validates JWT on every single route before any business logic runs. |
| Next.js API | Supabase Postgres | All reads/writes via Supabase client. RLS enforces church_group_id isolation regardless of what the API requests. |
| Next.js API | Supabase Realtime | Manages channel subscriptions for chat rooms. |
| Supabase Realtime | Browser | Broadcasts new chat messages instantly to all subscribed clients (WebSocket push). |
| Next.js API | Cloudflare R2 | Generates pre-signed upload and signed read URLs after verifying auth + church group membership. |
| Browser | Cloudflare R2 | Direct upload/download using the signed URL — the file itself never passes through the API server. |
| Next.js API | Pingram / Resend | Outbound SMS and email dispatch on notification events. |
| Pingram / Resend | Next.js API | Delivery status webhooks. |
| Next.js API | Google Calendar API | OAuth create / update / delete event calls using encrypted member tokens. |
| Next.js API | Upstash Redis | Enqueues transcription jobs; reads queue position for UI display. |
| Modal Worker | Upstash Redis | Dequeues jobs. Polling, not pushed. |
| Modal Worker | Cloudflare R2 | Uploads completed PDF/MIDI via the pre-signed URL provided at enqueue time. Cannot write anywhere else in R2. |
| Modal Worker | Next.js API | Webhook call on job completion (success or failure) — the ONLY way the worker reports results back. |
| Next.js API | Spotify API | Read-only metadata calls. API key never reaches the browser. |
| Next.js API / Modal | Sentry | Error reporting from both the application layer and the Python worker. |
| Better Uptime | Next.js API | Pings /api/health every 3 minutes. |

## 19.3 Critical Architecture Rules

Four rules that must hold true regardless of how the implementation evolves. Violating any of these reopens a security or reliability gap this document was written to close.

- Every arrow from the browser terminates at Next.js API — never directly at Supabase, R2, Pingram, Resend, Google Calendar, or Spotify. This is the single most important rule in the architecture.
- The Supabase service role key (which bypasses RLS) never appears in any API route a user can call. It exists only in trusted migration scripts.
- PostgREST — Supabase's auto-generated REST API — is disabled. All data access goes through the application's own API routes, which enforce business logic before touching the database.
- The Modal worker is network-isolated. It cannot reach Supabase, Pingram, Resend, or Google Calendar under any circumstance. Its only three reachable destinations are Redis, R2 (via pre-signed URL), and the one webhook endpoint on the API.

# 20. Data Model / Schema

24 tables across 6 clusters. Every table except church_groups carries a church_group_id foreign key — the column that makes Row-Level Security enforceable on every query. All primary keys are UUID v4. All timestamps are timestamptz, stored in UTC, displayed in the church group's configured timezone.

> 📁 Companion file: `graceful_schema.dbml` — paste into dbdiagram.io (paste entire file — renders instantly) for the interactive visual version.

## 20.1 Schema Overview

| Cluster | Tables | Purpose |
| --- | --- | --- |
| **1. Organization** | 3 | church_groups, users, member_profiles — the root entity and everyone in it. |
| **2. Instruments** | 2 | instruments, member_instruments — the global list and who plays what. |
| **3. Scheduling core** | 7 | service_weeks, setlists, setlist_songs, events, invitations, event_attendees, conflicts — the heart of the app. |
| **4. Music & files** | 4 | songs, song_documents, documents, transcription_jobs — metadata for everything stored in R2. |
| **5. Communication & state** | 6 | chat_rooms, chat_messages, chat_mentions, availability, notification_preferences, notifications. |
| **6. Auth & audit** | 2 | google_calendar_tokens, audit_logs — encrypted credentials and the immutable action log. |

## 20.2 Enums

Nine enumerated types used across the schema, defined once and referenced by multiple tables.

| Enum | Values |
| --- | --- |
| **user_role** | admin, set_leader, member, guest |
| **invitation_status** | pending, accepted, denied, withdrawn |
| **event_type** | pre_practice, rehearsal, sound_check, service |
| **job_status** | queued, processing, complete, failed, cancelled |
| **audio_source** | upload, youtube, spotify_assisted |
| **vocal_capability** | none, lead, harmony, both |
| **chat_pref** | all, mentions (default) |
| **resolution_type** | replaced, withdrawn, member_reconfirmed, admin_dismissed |
| **setlist_status** | draft, published |

## 20.3 Cluster 1 — Organization

**church_groups** — Root entity. Every other table (except this one) has a church_group_id FK.

| Column | Type | Null? | Notes |
| --- | --- | --- | --- |
| id | uuid | Yes | Primary key |
| name | varchar(100) | Yes | |
| denomination | varchar(100) | Yes | |
| timezone | varchar(50) | Yes | IANA timezone, default 'America/Chicago' |
| logo_url | text | Yes | R2 object key — never a public URL |
| invite_code | varchar(20) | Yes | Unique. Used in /join/[code] links. |
| created_at / updated_at | timestamptz | Yes | |

**users** — One per person. role governs ALL permissions. email is nullable — guests may be added by phone only.

| Column | Type | Null? | Notes |
| --- | --- | --- | --- |
| id | uuid | Yes | Primary key |
| clerk_id | varchar(50) | Yes | Unique. Verifies JWT on every request. |
| church_group_id | uuid | Yes | FK → church_groups.id |
| role | user_role | Yes | Default 'member' |
| name | varchar(100) | Yes | |
| email | varchar(255) | Yes | Unique constraint only — NOT required. Allows guest accounts created by phone. |
| phone | varchar(20) | Yes | US only (+1). Required if sms_opted_in = true. |
| sms_opted_in | boolean | Yes | Default false. Explicit consent required before any SMS. |
| created_at / updated_at | timestamptz | Yes | |

**member_profiles** — Extended musician profile. One per user. Guests typically skip this.

| Column | Type | Null? | Notes |
| --- | --- | --- | --- |
| id | uuid | Yes | Primary key |
| user_id | uuid | Yes | Unique FK → users.id |
| vocal_capability | vocal_capability | Yes | Default 'none' |
| bio | text | Yes | |
| created_at | timestamptz | Yes | |

## 20.4 Cluster 2 — Instruments

**instruments** — 9 platform defaults seeded on group creation. Admins can add more.

| Column | Type | Null? | Notes |
| --- | --- | --- | --- |
| id | uuid | Yes | Primary key |
| church_group_id | uuid | Yes | FK → church_groups.id |
| name | varchar(100) | Yes | |
| is_default | boolean | Yes | Default false. True for the 9 platform defaults. |
| created_by | uuid | Yes | FK → users.id. Null for platform defaults. |
| created_at | timestamptz | Yes | |

**member_instruments** — Join table — many-to-many between members and instruments.

| Column | Type | Null? | Notes |
| --- | --- | --- | --- |
| id | uuid | Yes | Primary key |
| member_profile_id | uuid | Yes | FK → member_profiles.id |
| instrument_id | uuid | Yes | FK → instruments.id |

## 20.5 Cluster 3 — Scheduling Core

**availability** — One per user per calendar date. Triggers conflict detection if changed after confirmation.

| Column | Type | Null? | Notes |
| --- | --- | --- | --- |
| id | uuid | Yes | Primary key |
| user_id | uuid | Yes | FK → users.id |
| church_group_id | uuid | Yes | FK → church_groups.id |
| date | date | Yes | |
| is_available | boolean | Yes | Default true |
| note | text | Yes | e.g. 'available after 10am only' |
| created_at | timestamptz | Yes | |

**service_weeks** — Central organizing unit. One per service date. sermon_topic/scripture are AI Pipeline 4 inputs (captured Phase 1, used Phase 4).

| Column | Type | Null? | Notes |
| --- | --- | --- | --- |
| id | uuid | Yes | Primary key |
| church_group_id | uuid | Yes | FK → church_groups.id |
| service_date | date | Yes | |
| title | varchar(100) | Yes | e.g. 'Easter Sunday' |
| sermon_topic | text | Yes | AI Pipeline 4 input |
| sermon_scripture | text | Yes | Scripture refs for Pipeline 4 |
| speaker_name | varchar(100) | Yes | |
| notes | text | Yes | |
| is_cancelled | boolean | Yes | Default false. BR-17: cancelling preserves all data, only flips this flag. |
| created_by | uuid | Yes | FK → users.id |
| created_at | timestamptz | Yes | |

**setlists** — One per service week. Draft until published. Zero songs is valid.

| Column | Type | Null? | Notes |
| --- | --- | --- | --- |
| id | uuid | Yes | Primary key |
| church_group_id | uuid | Yes | FK → church_groups.id |
| service_week_id | uuid | Yes | Unique FK → service_weeks.id |
| status | setlist_status | Yes | Default 'draft' |
| published_at | timestamptz | Yes | Set when status → published |
| notes | text | Yes | |
| created_by | uuid | Yes | FK → users.id |
| created_at / updated_at | timestamptz | Yes | |

**setlist_songs** — Ordered songs within a setlist. No duplicates allowed (BR-07).

| Column | Type | Null? | Notes |
| --- | --- | --- | --- |
| id | uuid | Yes | Primary key |
| setlist_id | uuid | Yes | FK → setlists.id |
| song_id | uuid | Yes | FK → songs.id |
| position | integer | Yes | 1-indexed ordering |
| key_override | varchar(5) | Yes | Overrides song.default_key for this service only |
| notes | text | Yes | e.g. 'Start slow, build into chorus' |

**events** — Practice sessions, sound checks, services within a week.

| Column | Type | Null? | Notes |
| --- | --- | --- | --- |
| id | uuid | Yes | Primary key |
| church_group_id | uuid | Yes | FK → church_groups.id |
| service_week_id | uuid | Yes | FK → service_weeks.id |
| type | event_type | Yes | |
| name | varchar(100) | Yes | |
| location | text | Yes | |
| start_time / end_time | timestamptz | Yes | end_time must be after start_time |
| google_calendar_event_id | varchar(100) | Yes | Stored to enable UPDATE/DELETE GCal sync |
| notes | text | Yes | |
| created_by | uuid | Yes | FK → users.id |
| created_at | timestamptz | Yes | |

**invitations** — Full lifecycle of every set invitation. State machine: pending → accepted / denied / withdrawn.

| Column | Type | Null? | Notes |
| --- | --- | --- | --- |
| id | uuid | Yes | Primary key |
| church_group_id | uuid | Yes | FK → church_groups.id |
| service_week_id | uuid | Yes | FK → service_weeks.id |
| user_id | uuid | Yes | FK → users.id — the invitee |
| role_note | text | Yes | e.g. 'Acoustic guitar + lead communion song' |
| status | invitation_status | Yes | Default 'pending' |
| response_token | varchar(64) | Yes | Unique. 72hr expiry. Embedded in SMS/email links. |
| responded_at | timestamptz | Yes | |
| denial_reason | text | Yes | |
| denial_count | integer | Yes | Default 0. Max 3 per BR-08. |
| response_deadline | timestamptz | Yes | Optional hard cutoff set by set leader |
| invited_by | uuid | Yes | FK → users.id |
| created_at | timestamptz | Yes | |

**event_attendees** — Which confirmed members are assigned to which events.

| Column | Type | Null? | Notes |
| --- | --- | --- | --- |
| id | uuid | Yes | Primary key |
| event_id | uuid | Yes | FK → events.id |
| user_id | uuid | Yes | FK → users.id |
| created_at | timestamptz | Yes | |

**conflicts** — Auto-created when an accepted member goes unavailable. Admin resolves via 3 paths.

| Column | Type | Null? | Notes |
| --- | --- | --- | --- |
| id | uuid | Yes | Primary key |
| church_group_id | uuid | Yes | FK → church_groups.id |
| invitation_id | uuid | Yes | FK → invitations.id |
| triggered_by | uuid | Yes | FK → users.id — who changed availability |
| trigger_reason | text | Yes | |
| replacement_suggestion_user_id | uuid | Yes | FK → users.id. AI Pipeline 2 output — Phase 4 only. |
| resolved_at | timestamptz | Yes | |
| resolution_type | resolution_type | Yes | Set when admin resolves |
| created_at | timestamptz | Yes | |

## 20.6 Cluster 4 — Music & Files

**songs** — Church group's persistent song catalog. Every song ever used.

| Column | Type | Null? | Notes |
| --- | --- | --- | --- |
| id | uuid | Yes | Primary key |
| church_group_id | uuid | Yes | FK → church_groups.id |
| title | varchar(200) | Yes | |
| artist | varchar(200) | Yes | |
| default_key | varchar(5) | Yes | Must be a valid musical key (BR-09) |
| bpm | integer | Yes | |
| tags | varchar[] | Yes | e.g. {upbeat, contemporary, communion} |
| spotify_id | varchar(50) | Yes | Metadata enrichment, read-only |
| created_by | uuid | Yes | FK → users.id |
| created_at | timestamptz | Yes | |

**song_documents** — Files attached to a specific song: chord charts, PDFs, audio references.

| Column | Type | Null? | Notes |
| --- | --- | --- | --- |
| id | uuid | Yes | Primary key |
| song_id | uuid | Yes | FK → songs.id |
| church_group_id | uuid | Yes | Denormalized for RLS query efficiency |
| name | varchar(200) | Yes | e.g. 'Chord chart — G major' |
| file_key | text | Yes | R2 object key. NEVER a public URL. |
| file_type | varchar(50) | Yes | MIME type |
| file_size_bytes | integer | Yes | |
| uploaded_by | uuid | Yes | FK → users.id |
| created_at | timestamptz | Yes | |

**documents** — Church group general shared library. Not song-specific. All members have read access.

| Column | Type | Null? | Notes |
| --- | --- | --- | --- |
| id | uuid | Yes | Primary key |
| church_group_id | uuid | Yes | FK → church_groups.id |
| name | varchar(200) | Yes | |
| file_key | text | Yes | R2 object key |
| file_type | varchar(50) | Yes | |
| file_size_bytes | integer | Yes | |
| folder | varchar(100) | Yes | e.g. 'Training', 'Past Setlists' |
| description | text | Yes | |
| uploaded_by | uuid | Yes | FK → users.id |
| created_at | timestamptz | Yes | |

**transcription_jobs** — Full lifecycle of every audio→sheet-music request. Audio source ALWAYS deleted after job completion, failure, OR cancellation.

| Column | Type | Null? | Notes |
| --- | --- | --- | --- |
| id | uuid | Yes | Primary key |
| church_group_id | uuid | Yes | FK → church_groups.id |
| song_id | uuid | Yes | FK → songs.id |
| status | job_status | Yes | Default 'queued'. 'cancelled' set if user cancels a queued or processing job. |
| audio_source_type | audio_source | Yes | |
| audio_source_url | text | Yes | YouTube URL if source = youtube |
| audio_file_key | text | Yes | R2 key of uploaded audio. Set to null after processing. |
| target_key | varchar(5) | Yes | Musical key to transpose into |
| output_pdf_key / output_midi_key | text | Yes | Set on success |
| queue_position | integer | Yes | Updated in real time |
| error_message | text | Yes | Set if status = failed |
| retry_count | integer | Yes | Default 0. Max 2 auto-retries. |
| started_at / completed_at | timestamptz | Yes | |
| created_by | uuid | Yes | FK → users.id |
| created_at | timestamptz | Yes | |

## 20.7 Cluster 5 — Communication & User State

**chat_rooms** — One per service week. Created on group creation, activated when first member confirms.

| Column | Type | Null? | Notes |
| --- | --- | --- | --- |
| id | uuid | Yes | Primary key |
| church_group_id | uuid | Yes | FK → church_groups.id |
| service_week_id | uuid | Yes | Unique FK → service_weeks.id |
| is_archived | boolean | Yes | Default false. True after service date passes — readable, not writable. |
| created_at | timestamptz | Yes | |

**chat_messages** — Individual messages. 2000 char max enforced at API layer. Soft-delete only.

| Column | Type | Null? | Notes |
| --- | --- | --- | --- |
| id | uuid | Yes | Primary key |
| chat_room_id | uuid | Yes | FK → chat_rooms.id |
| user_id | uuid | Yes | FK → users.id — sender |
| content | text | Yes | Max 2000 chars |
| is_deleted | boolean | Yes | Default false. Soft delete. |
| created_at | timestamptz | Yes | |

**chat_mentions** — @mention tracking. Fires mention notifications regardless of chat_pref setting.

| Column | Type | Null? | Notes |
| --- | --- | --- | --- |
| id | uuid | Yes | Primary key |
| message_id | uuid | Yes | FK → chat_messages.id |
| mentioned_user_id | uuid | Yes | FK → users.id |

**notification_preferences** — Per-user channel settings. One per user. At least one invitation channel must stay active (BR-14).

| Column | Type | Null? | Notes |
| --- | --- | --- | --- |
| id | uuid | Yes | Primary key |
| user_id | uuid | Yes | Unique FK → users.id |
| invitation_sms / invitation_email / invitation_inapp | boolean | Yes | All default true. At least one must remain true. |
| reminder_sms / reminder_email | boolean | Yes | Defaults true / false |
| reminder_hours_before | integer | Yes | Default 24 |
| setlist_sms / setlist_email | boolean | Yes | Both default true |
| chat_preference | chat_pref | Yes | Default 'mentions' |
| gcal_sync_enabled | boolean | Yes | Default false |

**notifications** — In-app inbox. ALWAYS created regardless of SMS/email settings — the source of truth for every notification (Section 13.2).

| Column | Type | Null? | Notes |
| --- | --- | --- | --- |
| id | uuid | Yes | Primary key |
| church_group_id | uuid | Yes | FK → church_groups.id |
| user_id | uuid | Yes | FK → users.id — recipient |
| type | notification_type | Yes | |
| title | varchar(200) | Yes | |
| body | text | Yes | |
| link_entity_type / link_entity_id | varchar(50) / uuid | Yes | Deep-link target, e.g. 'invitation' + the invitation ID |
| is_read | boolean | Yes | Default false |
| created_at | timestamptz | Yes | |

## 20.8 Cluster 6 — Auth & Audit

**google_calendar_tokens** — Encrypted OAuth tokens. AES-256 at rest. One per user.

| Column | Type | Null? | Notes |
| --- | --- | --- | --- |
| id | uuid | Yes | Primary key |
| user_id | uuid | Yes | Unique FK → users.id |
| access_token_encrypted | text | Yes | AES-256 encrypted. Never logged in plaintext. |
| refresh_token_encrypted | text | Yes | AES-256 encrypted |
| token_expiry | timestamptz | Yes | |
| calendar_id | varchar(200) | Yes | Specific calendar to write to |
| scope | text | Yes | Always calendar.events (write-only) |
| created_at / updated_at | timestamptz | Yes | |

**audit_logs** — Append-only. No row is ever updated or deleted (BR-13).

| Column | Type | Null? | Notes |
| --- | --- | --- | --- |
| id | uuid | Yes | Primary key |
| church_group_id | uuid | Yes | FK → church_groups.id |
| user_id | uuid | Yes | FK → users.id. Null for system-triggered actions. |
| action | varchar(100) | Yes | Dot-notation: invitation.sent, setlist.published, role.changed |
| entity_type / entity_id | varchar(50) / uuid | Yes | |
| metadata | jsonb | Yes | e.g. old_value → new_value for role changes |
| created_at | timestamptz | Yes | Immutable timestamp |

## 20.9 Relationships Summary

- **One-to-many:** church_groups → users, service_weeks, songs, documents, instruments, audit_logs, notifications. service_weeks → events, invitations. setlists → setlist_songs. events → event_attendees. songs → song_documents, transcription_jobs. chat_rooms → chat_messages.
- **One-to-one:** users → member_profiles, notification_preferences, google_calendar_tokens. service_weeks → setlists, chat_rooms.
- **Many-to-many (via join table):** member_profiles ↔ instruments (member_instruments). setlists ↔ songs (setlist_songs — carries position + key_override). events ↔ users (event_attendees).

# 21. User Flows

Six flows covering every major decision point and state transition in the system. Each is documented step-by-step below; a fully diagrammed visual version with branching decision points exists as a companion file.

> 📁 Companion file: `graceful_flows.xml` — paste into app.diagrams.net (6 pages in one file — one per flow) for the interactive visual version.

## 21.1 Flow 1 — Onboarding & Church Group Setup

| # | Actor | Action | System outcome |
| --- | --- | --- | --- |
| 1 | User | Visits Graceful, creates an account via Clerk (email or Google OAuth) | Clerk session created |
| 2 | User | Decides: create a new church group, or join an existing one with an invite code | Branch point |
| 2a | System | CREATE path: enters group name, timezone, denomination (optional) | church_groups record created, unique invite_code generated |
| 2b | System | CREATE path continued | users record created with role 'admin'. 9 default instruments seeded. |
| 3a | System | JOIN path: enters 8-char invite code | If invalid: error shown, retry. If valid: users record created with role 'member'. |
| 4 | User | Completes profile: selects instruments, sets vocal capability, optional bio | member_profiles + member_instruments records created |
| 5 | User | Optionally connects Google Calendar via OAuth | Tokens encrypted and stored in google_calendar_tokens |
| 6 | User | Sets notification preferences (SMS / email / in-app per type) | notification_preferences record created |
| 7 | System | User is now visible in the member directory | Onboarding complete |

## 21.2 Flow 2 — Invitation Lifecycle

| # | Actor | Action | System outcome |
| --- | --- | --- | --- |
| 1 | Set leader | Opens roster for a service week, views availability grid | Queries availability table for all members across the date range |
| 2 | Set leader | Selects a member for a slot | System checks: is this member already confirmed for an overlapping date? |
| 3 | System | If overlap found: shows warning. Set leader can proceed or cancel. | Decision point — admin retains final say |
| 4 | Set leader | Enters optional role note, sends invitation | invitations record created, status 'pending', response_token generated (72hr expiry) |
| 5 | System | Fires SMS (Pingram) + email (Resend) + in-app notification | Member notified via all enabled channels |
| 6 | Member | Clicks accept/deny link or responds in-app | Token validated: expired? already responded? Both checked before showing the invitation. |
| 7a | Member | ACCEPT path | status → 'accepted'. Added to chat room. GCal events synced. Admin notified. |
| 7b | Member | DENY path (optional reason, max 200 chars) | status → 'denied', denial_count++. If count reaches 3, no further invites for this week. Admin notified with reason. Slot reopens. |
| 8 | System | If no response within 24hr | Reminder sent to BOTH member and admin. Repeats every 24hr until response or withdrawal. |
| 9 | Admin | Can withdraw a pending invitation at any time | status → 'withdrawn'. Member notified. Slot reopens. |

## 21.3 Flow 3 — Conflict Detection & Resolution

| # | Actor | Action | System outcome |
| --- | --- | --- | --- |
| 1 | Member | Changes availability to unavailable for a date | System queries invitations: accepted status + matching service_week date |
| 2 | System | If an accepted invitation is found for that date | conflicts record created. Admin alerted via SMS + email immediately. |
| 3 | Admin | Reviews the conflict on the roster view | Sees member name, affected date, AI replacement suggestion (Phase 4 only) |
| 4a | Admin | Path A — Withdraw invitation | status → 'withdrawn'. Removed from event_attendees. GCal events deleted. Slot reopens for reassignment. |
| 4b | Member | Path B — Member re-confirms availability | conflicts.resolution_type → 'member_reconfirmed'. Member stays on roster. |
| 4c | Admin | Path C — Admin dismisses the conflict | conflicts.resolution_type → 'admin_dismissed'. Member stays on roster despite the flag. |

## 21.4 Flow 4 — Setlist Build & Publish

| # | Actor | Action | System outcome |
| --- | --- | --- | --- |
| 1 | Set leader | Creates a service week: date, title, sermon topic/scripture (optional) | service_weeks record created. Draft setlist + inactive chat room auto-created. |
| 2 | Set leader | Creates events for the week (practice, sound check, service) | events records created with type, location, start/end time |
| 3 | Set leader | Opens setlist builder, searches the song catalog | Optional Spotify metadata enrichment shown for display |
| 4 | Set leader | Adds a song to the setlist | System checks: is this song already in the setlist? Duplicate rejected (BR-07). |
| 5 | Set leader | Sets key override (optional), adds notes, drags to reorder | setlist_songs record created/updated with position |
| 6 | Set leader | Clicks Publish (zero songs is a valid state) | System checks confirmed member count — notification copy differs if zero |
| 7 | System | Notifies all confirmed members | setlist.status → 'published', published_at set. Setlist becomes read-only. |
| 8 | Set leader | Wants to edit after publishing | Confirmation dialog warns that editing re-notifies all confirmed members |

## 21.5 Flow 5 — Transcription Job

| # | Actor | Action | System outcome |
| --- | --- | --- | --- |
| 1 | Set leader | Selects 'Generate Sheet Music' on a song | System checks for an existing in-progress job on this song — rejects duplicates |
| 2 | Set leader | Chooses audio source: upload, YouTube, or Spotify-assisted | Three-way branch |
| 2a | System | Upload path: validates file size (≤50MB) and MIME type | Rejects before reaching the queue if invalid |
| 2b | System | YouTube path: validates URL against domain allowlist | Rejects non-YouTube domains before yt-dlp is ever invoked (SSRF protection) |
| 2c | System | Spotify-assisted: metadata only | User must still choose upload or YouTube for the actual audio |
| 3 | Set leader | Selects target key, submits job | transcription_jobs record created (status 'queued'), enqueued in Redis |
| 4 | System | Queue position shown to user | Modal worker dequeues when its turn comes; status → 'processing' |
| 5 | System | Runs 5-stage pipeline | Demucs → CREPE/Basic Pitch → madmom → music21 → MuseScore |
| 6a | System | SUCCESS | PDF/MIDI uploaded to R2. Audio source deleted within 60 sec. song_documents record created. User notified. |
| 6b | System | FAILURE | Audio source deleted immediately. retry_count checked — under 2: re-enqueue. At 2: permanent failure, user notified with error. |

## 21.6 Flow 6 — Guest Invitation

| # | Actor | Action | System outcome |
| --- | --- | --- | --- |
| 1 | Admin/Set leader | Invites a speaker or guest by email address with a role note | System checks: is this email already a Graceful user? |
| 2a | System | EXISTING user path | invitations record created directly, user_id already known |
| 2b | System | NEW user path | Invitation email sent with account creation link. Guest creates Clerk account, auto-joins church group as role 'guest', invitation linked. |
| 3 | Guest | Receives invitation (SMS if phone set, + email + in-app) | Clicks link or responds in-app |
| 4 | Guest | Views service details: date, events, what the set is about | Token validated for expiry and prior response, same as member flow |
| 5a | Guest | ACCEPT | status → 'accepted'. Scoped access granted: setlist (read), events, roster, week chat, week documents. NO music roster slot, NO instrument/key UI. |
| 5b | Guest | DENY | status → 'denied'. Admin notified. No further access granted. |

# 22. API Specifications

All endpoints are Next.js API routes under /api/. Every route validates the Clerk JWT first, then checks church group membership before touching any data. Success responses follow `{ data: ... }`. Errors follow `{ error: string, code: string }`. The Auth column shows which roles can call each route — entries marked with an asterisk (*) are scoped further within the route handler (e.g. a Member only sees their own records, a Guest only sees their invited week).

## 22.1 Church Group & Members

| Method | Endpoint | Auth | Description |
| --- | --- | --- | --- |
| GET | /api/church-group | Any | Get the authenticated user's church group details |
| PUT | /api/church-group | Admin | Update group name, timezone, denomination |
| POST | /api/church-group/join | Public | Join via invite code. Creates a user with role 'member'. |
| GET | /api/church-group/members | Any | List all members with profiles, instruments, and availability status |
| PATCH | /api/church-group/members/:id/role | Admin | Change a user's role. Enforced at the API — Set Leaders and Members cannot call this regardless of UI. |
| DELETE | /api/church-group/members/:id | Admin | Remove a member. PII anonymized; historical scheduling/setlist records retained. |
| GET | /api/church-group/audit-log | Admin | Paginated, read-only audit log entries |

## 22.2 Profile

| Method | Endpoint | Auth | Description |
| --- | --- | --- | --- |
| GET | /api/profile | Any | Get own member_profiles record and selected instruments |
| PUT | /api/profile | Any | Update vocal_capability, bio, and instrument selections (member_instruments) |

## 22.3 Instruments

| Method | Endpoint | Auth | Description |
| --- | --- | --- | --- |
| GET | /api/instruments | Any | List the church group's instrument list |
| POST | /api/instruments | Admin | Add an instrument to the global list |
| POST | /api/instruments/custom | Member* | Submit a custom instrument, pending admin promotion |
| POST | /api/instruments/:id/promote | Admin | Promote a member-submitted custom instrument to the global list |
| DELETE | /api/instruments/:id | Admin | Remove an instrument |

## 22.4 Availability

| Method | Endpoint | Auth | Description |
| --- | --- | --- | --- |
| GET | /api/availability | Any* | Get own availability records. *Set Leader/Admin can pass a user_id to view a specific member's. |
| GET | /api/availability/team | Set Leader / Admin | Get all members' availability for a date range — powers the roster planning grid |
| PUT | /api/availability | Any* | Set availability for one or more dates. Triggers conflict detection if the date has an accepted invitation. |
| DELETE | /api/availability/:date | Any* | NEW. Clears an availability declaration, reverting to unset/unknown (distinct from explicitly marking available). Triggers conflict detection per BR-15 if the user has an accepted invitation for that date. |

## 22.5 Service Weeks

| Method | Endpoint | Auth | Description |
| --- | --- | --- | --- |
| GET | /api/service-weeks | Any* | List service weeks. *Guests only see weeks they're invited to. |
| POST | /api/service-weeks | Set Leader / Admin | Create a service week (date, title, sermon_topic, sermon_scripture, speaker_name) |
| GET | /api/service-weeks/:id | Any* | Full week details. *Guests only see weeks they're invited to. |
| PUT | /api/service-weeks/:id | Set Leader / Admin | Update week metadata |
| DELETE | /api/service-weeks/:id | Admin | NEW. Hard delete — only allowed if service_date is in the future AND zero accepted invitations exist (BR-16). 409 returned otherwise, directing the admin to /cancel instead. |
| POST | /api/service-weeks/:id/cancel | Admin | NEW. Soft cancellation — sets is_cancelled = true, notifies every member with a pending or accepted invitation, archives the week's chat room, removes synced Google Calendar events. All underlying data (setlist, events, invitations) is preserved (BR-17). |
| POST | /api/service-weeks/:id/reactivate | Admin | NEW. Reverses a cancellation made in error. Sets is_cancelled = false, re-notifies affected members. |

## 22.6 Setlists

| Method | Endpoint | Auth | Description |
| --- | --- | --- | --- |
| GET | /api/service-weeks/:id/setlist | Any* | *Members/Guests only see published setlists |
| POST | /api/service-weeks/:id/setlist | Set Leader / Admin | Create a draft setlist |
| PUT | /api/setlists/:id | Set Leader / Admin | Update song ordering and key overrides (draft only, or unlocked-published) |
| POST | /api/setlists/:id/songs | Set Leader / Admin | Add a song to the setlist. Rejects duplicates per BR-07. |
| DELETE | /api/setlists/:id/songs/:songId | Set Leader / Admin | NEW. Removes one song from the setlist and recompacts remaining position values. |
| POST | /api/setlists/:id/publish | Set Leader / Admin | Publish — fires notifications. Zero-song setlists allowed per BR-01. |
| POST | /api/setlists/:id/unlock | Set Leader / Admin | Unlock a published setlist for editing — requires confirmation, triggers re-notification on save |

## 22.7 Events

| Method | Endpoint | Auth | Description |
| --- | --- | --- | --- |
| GET | /api/events | Any* | Admin: all events, unscoped. Set Leader/Member/Guest: only events for weeks they're assigned to or invited to. |
| POST | /api/events | Set Leader / Admin | Create an event |
| PUT | /api/events/:id | Set Leader / Admin | Update — triggers Google Calendar sync for assigned members |
| DELETE | /api/events/:id | Set Leader / Admin | Delete — removes from assigned members' Google Calendars |
| POST | /api/events/:id/attendees | Set Leader / Admin | Assign a confirmed member to the event |
| DELETE | /api/events/:id/attendees/:userId | Set Leader / Admin | Remove a member from an event |

## 22.8 Invitations & Conflicts

| Method | Endpoint | Auth | Description |
| --- | --- | --- | --- |
| GET | /api/invitations | Any* | Admin/Set Leader: all for the group. Member/Guest: own only. |
| POST | /api/invitations | Set Leader / Admin | Send an invitation. Checks double-booking (BR-05), warns on overlap. |
| POST | /api/invitations/:id/accept | Member / Guest | Accept via token (SMS/email link) or session (in-app) |
| POST | /api/invitations/:id/deny | Member / Guest | Deny with optional reason. Increments denial_count, blocks after 3 (BR-08). |
| DELETE | /api/invitations/:id | Set Leader / Admin | Withdraw a pending invitation |
| GET | /api/invitations/respond/:token | Public | Token-based lookup for SMS/email links — no session required |
| GET | /api/conflicts | Set Leader / Admin | List open conflicts for the church group |
| POST | /api/conflicts/:id/resolve | Set Leader / Admin | Resolve via withdraw / member_reconfirmed / admin_dismissed |

## 22.9 Songs & Documents

| Method | Endpoint | Auth | Description |
| --- | --- | --- | --- |
| GET | /api/songs | Any | Search/list the song catalog |
| POST | /api/songs | Set Leader / Admin | Add a song, optional Spotify metadata enrichment |
| GET | /api/songs/:id/documents | Any | Chord charts/PDFs attached to a song |
| POST | /api/songs/:id/documents/upload-url | Set Leader / Admin | Get a pre-signed R2 upload URL |
| POST | /api/songs/:id/documents | Set Leader / Admin | Register a completed upload |
| DELETE | /api/songs/:id/documents/:docId | Set Leader / Admin | NEW. Remove a song-attached document — closes a gap, the original spec only had upload, no removal. |
| GET | /api/documents | Any | Browse the general shared library, filterable by folder |
| POST | /api/documents/upload-url | Admin | Pre-signed R2 upload URL for general documents |
| GET | /api/documents/:id/download-url | Any* | Signed 30-min read URL. *Guests scoped to their invited week's documents only. |
| DELETE | /api/documents/:id | Admin | Remove a document |

## 22.10 Transcription Jobs

| Method | Endpoint | Auth | Description |
| --- | --- | --- | --- |
| POST | /api/transcription/jobs | Set Leader / Admin | Submit a job (upload / YouTube / Spotify-assisted source). Rejects duplicate in-progress jobs for the same song. |
| GET | /api/transcription/jobs/:id | Set Leader / Admin | Job status, queue position, output URLs if complete |
| DELETE | /api/transcription/jobs/:id | Set Leader / Admin | NEW. Cancels a queued or processing job. Queued: removed from Redis, audio deleted immediately. Processing: Modal's native function-call cancellation stops the worker, audio deleted. Already complete/failed: 409 returned. |
| POST | /api/transcription/jobs/:id/webhook | Internal (Modal only) | Callback from the worker reporting job completion — not user-callable |

## 22.11 Chat

| Method | Endpoint | Auth | Description |
| --- | --- | --- | --- |
| GET | /api/chat-rooms | Any | List rooms the user belongs to |
| GET | /api/chat-rooms/:id/messages | Any* | Paginated. *Only for confirmed members/guests of that week. |
| POST | /api/chat-rooms/:id/messages | Any* | Send a message — rejected if the room is archived |

## 22.12 Notifications (In-App Inbox)

| Method | Endpoint | Auth | Description |
| --- | --- | --- | --- |
| GET | /api/notifications | Any | Get the user's inbox, paginated, filterable by type |
| GET | /api/notifications/unread-count | Any | For the badge counter |
| PATCH | /api/notifications/:id/read | Any | Mark a single notification read |
| POST | /api/notifications/mark-all-read | Any | Bulk mark-as-read |
| GET | /api/notifications/preferences | Any | Get the user's channel preferences |
| PUT | /api/notifications/preferences | Any | Update preferences. Rejects disabling all 3 invitation channels (BR-14). |

## 22.13 Google Calendar

| Method | Endpoint | Auth | Description |
| --- | --- | --- | --- |
| POST | /api/google-calendar/connect | Any | Initiate OAuth flow |
| GET | /api/google-calendar/callback | Any | OAuth callback — exchanges code for encrypted tokens |
| DELETE | /api/google-calendar/disconnect | Any | Revoke and delete stored tokens |

## 22.14 System

| Method | Endpoint | Auth | Description |
| --- | --- | --- | --- |
| GET | /api/health | Public | Health check — DB, Redis, R2 status. Polled by Better Uptime every 3 minutes. |

# 23. Wireframes / Screen Descriptions

Text descriptions of the 8 highest-traffic screens — enough for a developer or designer to start layout work without guessing at structure. Each covers layout, key elements, and role-specific variations. Replace with visual wireframes (Figma or similar) before frontend build begins.

### Screen 1 — Week View
*Admin / Set Leader — desktop-first*

The primary planning workspace. Header bar: service date, theme title, publish status badge, week navigation arrows. Below: a roster grid showing each slot with member avatar, name, and a status badge (Open / Pending / Confirmed / Declined / Conflict — conflict shown in red). Empty slots show a '+ Invite' button. A collapsible sidebar shows the team availability grid. An events timeline lists practice/sound check/service with time, location, attendee count, and a '+ Add event' button. A setlist preview card shows song count and a Publish or Edit-setlist button depending on state. A floating chat icon shows unread count and expands the week chat inline.

### Screen 2 — Invitation Response
*Member / Guest — mobile-first, no login required*

Reached from the SMS/email link via response_token — must work without a session. Minimal header with the Graceful logo. A card shows the service date, role note, and a list of events (time, location). Two large, separated buttons: Accept (primary, green, 44×44px minimum touch target) and Decline (secondary, outlined). Tapping Decline reveals an optional reason field and a confirm button. On success: a checkmark state with a link into the full app. Expired or already-used tokens redirect to the app rather than showing a raw error.

### Screen 3 — Member Week View
*Member / Guest — mobile*

Home screen for a confirmed member during their service week. Header: date and confirmation status. Setlist section: songs and keys if published, or 'Setlist not yet released' if draft. Events section: everything the member is assigned to, tappable into a detail view with a Maps link. Team section: confirmed members with instruments, tappable into the week chat. Documents section: chord charts and sheet music for this week's songs, opening via signed URL. Floating chat button matches Screen 1.

### Screen 4 — Document Library
*All roles, scoped per role*

Admin view has an Upload button and folder management with delete-on-hover. A search bar filters by name. Folder tabs (Chord Charts, Past Setlists, Training, General) only appear if non-empty. Below: a grid or list showing document name, file type badge, upload date, size. Member view is identical minus upload/delete. Guest view is restricted to only documents shared for their specific invited week — no folder browsing, no full-library access.

### Screen 5 — Setlist Builder
*Set Leader / Admin — desktop-first*

Two-panel layout. Left: song search with results showing title, artist, default key, Spotify metadata where available, with a quick-add form if no match exists. Right: the setlist itself — songs in order with position number, title, artist, a key dropdown (defaults to library key, overridable), a notes field, drag handle, and a remove button (calls DELETE /api/setlists/:id/songs/:songId). Bottom bar shows song count and a Publish button — not disabled at zero songs per BR-01, but always shows a confirmation step.

### Screen 6 — Notification Inbox
*All roles*

Accessed from a persistent icon in the main nav with an unread count badge. A vertical list of notifications, each with a type icon, title, short body, and relative timestamp — unread ones visually distinct. Tapping deep-links into the relevant screen (an invitation notification opens accept/deny, a conflict notification opens the roster view). A filter row narrows by type (Invitations, Setlists, Events, Chat, System). A 'mark all read' action sits in the header.

### Screen 7 — Conflict Resolution
*Set Leader / Admin*

Reached from a conflict notification or a flagged roster slot. Shows the affected member's name, service date, original role, and their reason if provided. Three clearly labeled action buttons matching the resolution paths: 'Find a Replacement' (opens the invitation flow, slot pre-selected), 'Mark as Resolved' (member re-confirmed), and 'Dismiss' (keep the member despite the flag). In Phase 4, an AI-suggested replacement appears above these as a recommendation — the three manual options always remain available.

### Screen 8 — Admin Global Dashboard
*Admin only — NEW, closes a gap from Section 5's persona definition*

Section 5 explicitly defines the Admin persona as having visibility into all weekly events across the church group without needing to be added to any specific set — this screen is where that capability lives, since no prior wireframe covered it. A calendar or list view spanning all upcoming and recent service weeks across the entire group, regardless of which weeks the admin personally has a roster slot in. Each week shows its publish status, roster fill rate (e.g. '5 of 7 confirmed'), and any open conflicts. Filters by date range and by cancelled/active status (post-BR-17). This is the admin's single source of truth for the health of the whole group, distinct from the per-week focus of Screen 1.

# 24. Migration & Onboarding Strategy

How a real church team actually moves off WhatsApp and Google Sheets and onto Graceful. This is an adoption question, not a technical one — there's no clean data export from a group chat, so the plan accounts for that reality rather than relying on import tooling that doesn't exist.

### Phase 1: Admin-Only Setup

- The worship leader creates the church group alone, before any member sees the app.
- Song catalog is manually re-entered — the one real 'data migration' step. No automated import exists in Phase 1. A fast-add flow (title + artist + key, with Spotify autocomplete) keeps this from being painful — target under 30 minutes for a typical 40-60 song catalog.
- Instrument list is customized if it differs from the 9 defaults.
- One real upcoming service week is built as a trial run, so the worship leader experiences the full flow once before explaining it to anyone.

### Phase 2: Soft Launch

- 2-3 trusted, tech-comfortable members are invited first — not the whole team at once.
- This validates the invitation flow and surfaces UI confusion before it hits everyone.
- Creates a few people who can help others during the full rollout.
- Runs for one real service week before expanding further.

### Phase 3: Full Team Rollout

- Remaining team members are invited, ideally timed to a real upcoming set invitation — so a new member's first action in the app is something they actually need to do, not an abstract setup task.
- The beta first-login walkthrough (Section 34.1) handles in-app education at this point. No separate migration-specific tutorial is needed — the existing onboarding walkthrough covers what a new member needs to know.

### Phase 4: Sunset the Old System

- The WhatsApp group chat is archived (not deleted) once the team has run 2-3 consecutive service weeks fully inside Graceful.
- The spreadsheet is kept as a backup reference for one full month, then retired.
- This phased sunset avoids a hard cutover that leaves people stuck if they miss something during the adjustment period.

## 24.1 What Doesn't Need to Be Built

- No CSV import tool for Phase 1 — manual setup by one motivated worship leader is faster and more reliable than building import tooling for data that isn't structured anywhere.
- No WhatsApp message parsing or history import.
- No automated Planning Center Online export/import. Worth revisiting if Graceful scales to many churches migrating from a paid competitor, but not for the first pilot churches.

# 25. Security Requirements

Security is not a phase — it is a baseline requirement enforced from the first line of production code. The items in this section are non-negotiable pre-launch requirements unless explicitly marked as a later phase. Each one is assigned to the phase in which the relevant feature is built.

## 25.1 Database Security — Row-Level Security (RLS)

Every table in the Supabase Postgres database must have Row-Level Security enabled and enforced. This ensures that even a direct API call bypassing the frontend cannot read another church group's data. This is the most critical security primitive in the entire application.

| Feature | Phase | Description |
| --- | --- | --- |
| **church_group_id on all tables** | MVP | Every user-data table (members, setlists, songs, events, documents, invitations, chat messages) must have a church_group_id foreign key column from the first migration. No exceptions. |
| **RLS policies on every table** | MVP | Supabase RLS policy on every table: SELECT, INSERT, UPDATE, DELETE all require that church_group_id matches the authenticated user's church group. Test these policies with a dedicated test suite before first deploy. |
| **Role-based access policies** | MVP | Admin-only tables (invitations, conflict alerts, AI suggestions) have an additional RLS check that the user's role is admin. Member-level access policies enforce read-only on setlists until published. |
| **Service role key never exposed** | MVP | The Supabase service role key (which bypasses RLS) is never used in frontend code or API routes accessible to users. It is used only in trusted server-side migration scripts and the Python pipeline callback. |
| **No direct table exposure** | MVP | Supabase's auto-generated REST API (PostgREST) is disabled for all tables. All data access goes through Next.js API routes that enforce business logic before hitting the database. |

## 25.2 File Storage Security

All files stored in Cloudflare R2 or Supabase Storage — sheet music PDFs, chord charts, audio files, and documents — must be private by default. No file should ever have a permanent public URL.

| Feature | Phase | Description |
| --- | --- | --- |
| **Signed URLs only** | MVP | Every file access generates a short-lived signed URL (15-60 minutes expiry). The signed URL is generated server-side after verifying the requesting user belongs to the church group that owns the file. |
| **No public bucket access** | MVP | All R2 and Supabase Storage buckets are configured as private at creation. Public access is never enabled, even temporarily during development. |
| **File ownership enforcement** | MVP | Before generating a signed URL, the API verifies: (1) the user is authenticated, (2) the user belongs to the church group, (3) the file belongs to that church group. All three checks must pass. |
| **Audio file deletion post-pipeline** | Ph.3 | Source audio files uploaded for transcription (MP3/WAV extracted from YouTube or uploaded directly) are permanently deleted from storage after the pipeline completes — whether it succeeds or fails. Only the generated PDF and MIDI are retained. Retaining copyrighted audio creates legal and storage risk. |
| **File type validation** | Ph.3 | Uploaded files are validated by MIME type and file extension on the server, not just the filename. The yt-dlp worker validates that the extracted file is an audio format before accepting it into the queue. |

## 25.3 API Authorization

Every API route must enforce authentication and authorization independently. The frontend not showing a button is not security — the API must reject unauthorized requests even if someone calls it directly.

| Feature | Phase | Description |
| --- | --- | --- |
| **Auth check on every route** | MVP | Every API route begins with a Clerk session check. Unauthenticated requests return 401 before any database query runs. |
| **Church group membership check** | MVP | After auth, every route verifies the authenticated user belongs to the church group referenced in the request. A member from Church A cannot read or write Church B's data even with a valid session token. |
| **Role check on admin routes** | MVP | Routes that perform admin actions (send invitation, publish setlist, manage members, promote instruments) verify the user's role is admin before executing. Members hitting these routes receive 403. |
| **Rate limiting** | MVP | API rate limiting on all endpoints using an in-memory or Redis-backed limiter. Stricter limits on: auth endpoints (login/signup), SMS notification triggers, and the yt-dlp job submission endpoint. |
| **Input validation and sanitization** | MVP | All user inputs are validated with a schema (Zod) before processing. String fields are length-limited. No raw SQL or template strings are ever constructed from user input — all queries use parameterized queries or the Supabase SDK. |

## 25.4 Audio Pipeline Security

The yt-dlp integration is the highest-risk attack surface in the application because it runs a subprocess on the server with a user-provided URL. Without strict controls it is vulnerable to Server-Side Request Forgery (SSRF).

| Feature | Phase | Description |
| --- | --- | --- |
| **YouTube URL allowlist** | Ph.3 | The yt-dlp endpoint validates that the submitted URL is a YouTube domain (youtube.com, youtu.be, m.youtube.com) before passing it to the subprocess. Any other domain is rejected with a 400 error. No DNS resolution is performed before this check. |
| **No internal network access** | Ph.3 | The Modal worker running yt-dlp runs in an isolated container with no access to internal Graceful infrastructure. It can only write its output to a pre-signed R2 upload URL provided by the job queue — no other network destinations. |
| **Subprocess sandboxing** | Ph.3 | yt-dlp runs as a non-root user inside the container with a restricted set of allowed formats (audio-only, no video). The output path is a fixed temporary directory. The container is destroyed after job completion. |
| **File content scanning** | Ph.3 | After yt-dlp extraction, the output file is validated as a legitimate audio file (by reading its MIME type, not just the extension) before being passed to the Demucs pipeline. A non-audio file causes job failure, not a pipeline crash. |
| **Job submission authentication** | Ph.3 | The transcription job endpoint requires a valid authenticated session. It also enforces a per-user job submission rate limit (e.g. max 5 jobs per hour) to prevent abuse. |

## 25.5 OAuth & Credential Security

Google Calendar OAuth tokens are high-value credentials. SMS API keys and other secrets require the same level of care.

| Feature | Phase | Description |
| --- | --- | --- |
| **Google Calendar token encryption** | MVP | OAuth access and refresh tokens are encrypted at rest in the database using AES-256 before storage. The encryption key is stored in an environment variable, never in the database or source code. |
| **Minimal OAuth scope** | MVP | Google Calendar integration requests only the calendar.events scope (write events to a calendar the user designates). It does not request read access to existing events. Scope is declared explicitly in the OAuth consent screen. |
| **Token revocation handling** | MVP | If a Google Calendar token is revoked by the member, the integration gracefully degrades — events continue to be created in Graceful but Google Calendar sync silently stops and the member is notified with a re-auth prompt. The app never crashes on a revoked token. |
| **No secrets in source code** | MVP | All API keys (Pingram, Resend, Supabase, Clerk, Google, Cloudflare, Modal, Upstash) are stored as environment variables. They are never committed to the git repository. A .env.example file with placeholder values is committed instead. Git history is scanned for accidental secret commits before first deploy. |
| **Secret rotation plan** | MVP | All third-party API keys are documented in a secrets registry (a private note, not the repo) with their rotation cadence. Keys are rotated immediately if a team member with access leaves the project. |

## 25.6 Data Privacy & Compliance

Even for a single-church US deployment, GDPR-aligned data practices are worth building from the start. They are good engineering and protect members regardless of jurisdiction.

| Feature | Phase | Description |
| --- | --- | --- |
| **Member data deletion (right to erasure)** | MVP | Admins can permanently delete a member from the church group. On deletion: the member's account is anonymized (name and contact details removed, replaced with a deleted-user placeholder), their future schedule data is removed, but historical setlist participation is retained in anonymized form for the AI training pipeline. |
| **Data retention policy** | MVP | Scheduling history, setlist data, and chat messages are retained indefinitely for AI training and archive purposes. Audio source files are deleted immediately after pipeline processing. Members can view all data held about them on request. |
| **PII minimization** | MVP | Graceful stores only: name, email, phone number, instrument list, and availability. No payment information, no location data beyond event venues, no device fingerprinting. Member chat messages are stored encrypted at rest. |
| **SMS consent** | MVP | Members must explicitly opt in to SMS notifications during onboarding with clear language about what messages they will receive. Opt-out is available at any time and is honored within one message cycle. |
| **Audit logging** | MVP | All admin actions are logged with timestamp and actor: invitations sent, members removed, documents deleted, setlists published. Logs are retained for 12 months and are readable by admins but not editable by anyone. |

## 25.7 Infrastructure Security

| Feature | Phase | Description |
| --- | --- | --- |
| **HTTPS everywhere** | MVP | Enforced by Vercel on all routes. HTTP requests are automatically redirected to HTTPS. No exceptions, including API routes and webhooks. |
| **Content Security Policy headers** | MVP | CSP headers configured on the Next.js app to prevent XSS. Strict CSP: script-src limited to self and Clerk, no inline scripts, no eval. Tested against OWASP CSP validator before launch. |
| **Webhook signature verification** | MVP | All incoming webhooks (Pingram SMS status callbacks, Clerk user events) verify the request signature before processing. Unsigned or invalid webhook requests are rejected with 401. |
| **Dependency scanning** | MVP | bun audit and pip-audit run in CI on every pull request. Any high-severity vulnerability blocks the merge. Dependabot is enabled on the repository for automated dependency update PRs. |
| **Environment isolation** | MVP | Three environments: development (local), staging (mirrors production config, uses test API keys), and production. Production secrets are never used in development or staging. Staging uses separate Supabase project, R2 bucket, and Pingram test environment. |

# 26. Testing & Quality Assurance

Testing is structured in five layers, each covering a different failure mode. All layers run automatically in CI on every pull request. No code merges to main without passing all tests in its layer. New features are not considered done until tests are written.

## 26.1 Unit & Integration Tests

Cover individual functions and API routes in isolation. Written in Jest (TypeScript) and pytest (Python). Target: 80% line coverage on business-critical modules from Phase 1.

| Feature | Phase | Description |
| --- | --- | --- |
| **Availability logic** | MVP | Unit tests for all conflict detection scenarios: member goes unavailable after confirming, availability changes before invitation, overlapping events. |
| **Invitation state machine** | MVP | Tests for all invitation transitions: pending → accepted, pending → denied, accepted → conflict, withdrawn. Invalid transitions must throw, not silently fail. |
| **Notification trigger logic** | MVP | Tests that the correct notifications fire for each event, that 24hr reminder logic counts correctly, and that opted-out members are excluded. |
| **Key transposition** | Ph.3 | Unit tests for music21 transposition: given an input key and a target key, verify the MIDI output is shifted by the correct number of semitones across all 12 key combinations. |
| **RLS policy tests** | MVP | Dedicated Supabase RLS test suite: for each table, verify that a user from Church A cannot SELECT, INSERT, UPDATE, or DELETE rows belonging to Church B. Run against a real test database instance, not mocks. |
| **API route integration tests** | MVP | Each API route tested with: valid authenticated admin request, valid authenticated member request hitting an admin route (expect 403), unauthenticated request (expect 401), malformed input (expect 400 with validation error). |
| **Job queue behavior** | Ph.3 | Integration tests for BullMQ: job is enqueued, worker picks it up, result is stored, status is updated correctly. Failed job retry behavior is tested explicitly. |

## 26.2 End-to-End Tests

Full user journey tests using Playwright, running against the staging environment. These tests exercise real database writes, real file storage, and real notification triggers (against test phone numbers and email addresses). Target: all critical paths covered before Phase 1 launch.

| Feature | Phase | Description |
| --- | --- | --- |
| **Admin: full week setup flow** | MVP | Admin creates church group, invites member, member joins, admin builds setlist, admin creates events, admin sends set invitation, checks roster shows Pending. |
| **Member: accept invitation flow** | MVP | Member receives invitation notification link, opens it, accepts, roster updates to Confirmed, admin receives in-app notification. |
| **Member: deny flow** | MVP | Member denies invitation with reason, slot reopens in admin view, admin receives SMS + email with reason. |
| **24hr reminder flow** | MVP | Invitation sent, time is mocked to advance 24 hours, both member and admin receive reminder notification, tested against Pingram test environment. |
| **Conflict detection flow** | MVP | Member confirms invitation, then marks themselves unavailable for the event date, admin receives conflict notification, slot reopens. |
| **Setlist publish flow** | MVP | Admin builds setlist, publishes it, all confirmed members see it in their view, members who are pending do not. |
| **Document access flow** | MVP | Admin uploads a document to the shared library, member accesses it via signed URL, URL expires after the configured window, re-request generates a new valid URL. |
| **Google Calendar sync flow** | MVP | Admin creates an event, member has Google Calendar connected, event appears in member's Google Calendar. Admin updates the event, change propagates to Google Calendar. |
| **Transcription job flow** | Ph.3 | Admin uploads an audio file, job enters queue, worker processes it, PDF is stored, song in library shows the attached sheet music. Full pipeline E2E against a known short reference audio file with a known correct transcription. |
| **Chat flow** | Ph.2 | Member sends message in week chat, second member receives it in real time, @mention triggers notification to mentioned member regardless of notification preference. |

## 26.3 Security Tests

Run as a dedicated gate before the Phase 1 production launch and repeated before each subsequent phase launch. Combines automated scanning with manual review against the OWASP Top 10. A failing security test blocks the phase launch — not just the individual PR.

| Feature | Phase | Description |
| --- | --- | --- |
| **Auth bypass tests** | MVP | Automated tests that attempt every admin API route with: no session token, an expired token, a valid member token (not admin), and a valid admin token from a different church group. All must return 401 or 403. |
| **RLS bypass tests** | MVP | Automated tests that construct direct Supabase queries with a valid user JWT from Church A attempting to read Church B's setlists, members, documents, and invitations. All must return empty results or error. |
| **File access tests** | MVP | Verify that a signed URL for a Church A document cannot be used by a Church B user. Verify that an expired signed URL returns 403. Verify that no document URL is permanently accessible without re-authentication. |
| **SSRF / yt-dlp tests** | Ph.3 | Submit URLs to the transcription endpoint that point to: internal localhost, internal IP ranges (10.x, 192.168.x, 172.16.x), non-YouTube external domains. All must be rejected before yt-dlp is invoked. |
| **Input validation / injection** | MVP | Test all string input fields with: SQL injection payloads, XSS payloads, oversized strings, null bytes, and Unicode edge cases. All must be safely rejected or escaped. |
| **Rate limit tests** | MVP | Verify rate limits fire correctly on: the login endpoint, the SMS trigger endpoint, and the job submission endpoint. Exceeding the limit returns 429 with a Retry-After header. |
| **OWASP Top 10 checklist** | MVP | Manual review against OWASP Top 10 (2021) before Phase 1 launch: A01 Broken Access Control, A02 Cryptographic Failures, A03 Injection, A05 Security Misconfiguration, A07 Auth Failures. Document findings and resolutions. |
| **Dependency vulnerability scan** | MVP | bun audit --audit-level=high and pip-audit must both return zero high-severity findings before Phase 1 launch. This scan also runs in CI on every PR. |

## 26.4 Pipeline Accuracy Regression Tests

Every change to the audio transcription pipeline — whether a threshold tweak, a library version bump, or a model fine-tune — must be measured against the baseline before it can be merged. Accuracy cannot silently degrade between releases.

| Feature | Phase | Description |
| --- | --- | --- |
| **mir_eval baseline** | Ph.3 | The Level 1 pipeline (Demucs + Basic Pitch with frequency constraints) is benchmarked against a fixed test set from MAESTRO and Slakh2100 before any other changes. This score is the baseline all future changes are measured against. |
| **Merge gate on accuracy** | Ph.3 | A pipeline change must meet or exceed the baseline note-level F1 score (with 50ms onset tolerance) to merge. A PR that improves transcription speed but reduces accuracy by even 2% is blocked until the accuracy regression is resolved. |
| **Per-instrument accuracy tracking** | Ph.3 | Accuracy is tracked separately per stem type (piano, guitar, bass, vocals, other) not just as an aggregate. A change that improves piano accuracy but degrades bass accuracy is flagged even if the total F1 is unchanged. |
| **Reference audio test set** | Ph.3 | A curated set of 20-30 short reference audio clips with known ground-truth MIDI is stored in the repository (public domain or licensed recordings). These are run on every pipeline change. The test set includes worship music styles where possible. |
| **Level 2 and 3 regression** | Ph.4 | When Level 2 (fine-tuned) or Level 3 (refinement model) are added, they are each measured against the previous level's score as their baseline. Each level must strictly outperform the previous. |

## 26.5 CI/CD Pipeline

All tests run automatically on every pull request via GitHub Actions. No code merges to main without passing CI. The deployment pipeline enforces a staging deploy and smoke test before any production deploy.

| Feature | Phase | Description |
| --- | --- | --- |
| **Pull request checks** | MVP | On every PR: TypeScript type check, ESLint, Jest unit tests, Playwright E2E tests against staging, bun audit, RLS policy tests. All must pass before the PR can be reviewed and merged. |
| **Staging environment** | MVP | Staging mirrors production infrastructure exactly: same Vercel config, a separate Supabase project with identical schema, a separate R2 bucket, Pingram test environment, and Clerk test mode. Staging is always deployed from the main branch after merge. |
| **Production deploy gate** | MVP | Production deployments require: (1) all CI checks passed on main, (2) staging smoke test suite passed (a subset of E2E tests run against staging post-deploy), (3) manual approval from the deploying developer. No automatic production deploys without the smoke test gate. |
| **Migration safety** | MVP | Database migrations are run against staging before production. Migrations are written to be backward-compatible (add columns, never rename or drop without a deprecation period). A failed staging migration blocks the production deploy. |
| **Python worker CI** | Ph.3 | The Python pipeline has its own GitHub Actions workflow: pytest, pip-audit, and the accuracy regression test suite (against the reference audio set). Python worker deploys to Modal are gated on all three passing. |
| **Rollback plan** | MVP | Every production deploy is tagged in git. If a deploy causes a production issue, the rollback path is a Vercel instant rollback to the previous deployment. Database migrations include a documented down migration for any structural changes. |

## 26.6 Performance Tests

Run against staging before Phase 1 launch and before each major subsequent phase launch. Not in CI on every PR — they run on a schedule or as a manual pre-launch gate.

| Feature | Phase | Description |
| --- | --- | --- |
| **Concurrent user load test** | MVP | Simulate 100 concurrent users accessing the app simultaneously (the upper bound of a single large church) using k6 or Locust. All API endpoints must respond within 500ms at p95. Supabase connection pooling is verified under load. |
| **Notification delivery latency** | MVP | Measure time from event trigger (invitation sent, setlist published) to SMS delivery and email delivery. Target: SMS within 30 seconds, email within 60 seconds at p95. Test with 50 simultaneous notifications. |
| **Realtime chat latency** | Ph.2 | Message sent to message received by all connected clients within 500ms at p95. Tested with 20 concurrent users in the same week chat. |
| **Transcription job throughput** | Ph.3 | With max concurrency set to 5, submit 10 jobs simultaneously. Verify: the first 5 start immediately, the remaining 5 queue correctly with position updates, no jobs are lost if a worker crashes mid-run, all 10 eventually complete. |
| **Signed URL generation speed** | MVP | Document library with 500 files: signed URL generation for a single file must complete within 200ms. Tested across all file types and sizes in the test library. |

# 27. Build Order

Each phase delivers independently useful functionality before the next begins. Phase 1 alone replaces spreadsheets and group texts for most worship teams.

### Phase 1 — Core

Auth, church group setup, member profiles with custom instruments, availability, invite flow with 24hr reminders, setlist builder, event calendar, Google Calendar sync, SMS + email notifications.

- Church group creation and member directory
- User auth with admin/member roles (Clerk)
- Member profiles with default + custom instrument list
- Availability management (weekly and monthly)
- Set invitation with accept/deny and 24hr reminders to both parties
- Conflict detection (AI replacement placeholder for Phase 4)
- Setlist builder + song library with key selection
- Event calendar (practice, sound check, service)
- Google Calendar API sync for all events
- SMS (Pingram) and email (Resend) notifications

### Phase 2 — Collab

Social layer, document storage, Bible app integration, church group global library.

- Week team chat with @mention and notification preferences
- Church group global document library (Cloudflare R2)
- Past setlist archive, searchable by date / song / team
- Bible app (YouVersion) devotion import
- Member song familiarity tracking
- Mobile-responsive polish (PWA installable on phone home screen)

### Phase 3 — Pipeline

Audio to sheet music. Python worker, async job queue, three audio sources, Level 1 accuracy first.

- Audio ingestion: direct upload, YouTube (yt-dlp), or Spotify metadata + manual upload
- Python pipeline: Demucs + Basic Pitch + music21 + MuseScore
- Async job queue (BullMQ + Upstash Redis) + GPU worker (Modal)
- Level 1: frequency constraints per stem — no training needed
- Level 2: Basic Pitch fine-tune on Slakh2100
- Auto-attach transcriptions to global song library

### Phase 4 — AI

Three separate AI systems — each with its own architecture, training data, and deployment timeline.

- AI Pipeline 1 (Music Transcription): Level 3 refinement model + mir_eval benchmarking
- AI Pipeline 2 (Member Scheduling): roster prediction and conflict replacement suggestions
- AI Pipeline 3 (Setlist Prediction): song-to-song and person-to-song compatibility model
- All three require historical Graceful data to train — Phase 4 cannot start until meaningful history exists in Phase 1-2

# 28. Non-Functional Requirements

## 28.1 Performance Requirements

The music transcription pipeline runs as a background task. Users are never blocked at a loading screen waiting for transcription to complete. They submit the job and receive an in-app and email notification when the sheet music is ready.

| Requirement | Target | How measured / notes |
| --- | --- | --- |
| **Music → sheet music (background task)** | < 3 min (standard songs), < 5 min (long tracks) | Fully async. User submits and walks away. Queue position shown. Completion notification sent. 3 min target for songs up to 5 minutes long. 5 min for songs up to 10 minutes. Aspirational: < 90 seconds with Level 2+ pipeline. Job timeout at 10 minutes. |
| **AI inference — member scheduling + setlist suggestions** | < 500ms | Measured per API call in production. These are synchronous responses the user waits for. Cached where possible. |
| **Spotify API response (song metadata)** | < 500ms | Client-side timeout set to 500ms. If Spotify doesn't respond in time, fallback to manual entry is shown immediately. No user is blocked by a slow metadata call. |
| **Concurrent users** | Up to 100 simultaneous | Load tested with k6 at 100 concurrent users. All API endpoints must remain under their response time targets under this load. |
| **General app response time (p95)** | < 3 seconds | Applies to all page loads, navigation, form submissions, and document access (signed URL generation). 3 seconds is the ceiling, not the goal. Target is < 1 second for most interactions. |
| **API response time (p95)** | < 500ms | Measured on all Next.js API routes under normal load. Vercel Analytics tracks this in production. |
| **SMS delivery latency (p95)** | < 30 seconds | Pingram delivery webhooks logged per notification. Alert fires if delivery rate drops below 95% over 1 hour. |
| **Email delivery latency (p95)** | < 60 seconds | Resend delivery webhook timestamps tracked. |
| **Realtime chat delivery (p95)** | < 500ms | Supabase Realtime round-trip measured with 20 concurrent chat users. |
| **Signed URL generation** | < 200ms | Logged per API request. File access should feel instant. |

## 28.2 Availability & SLA

- Uptime target: 99.5% for the web application and API (approximately 3.6 hours unplanned downtime per month).
- Planned maintenance windows: Monday nights. Specific window communicated 48 hours in advance via email to all members. Duration should not exceed 2 hours.
- Critical blackout window: Saturday 6pm through Sunday 2pm local church timezone. No planned maintenance during this window — this is when the platform is most actively used.
- Status page: a public status page is maintained so members can check service health independently.
- Dependency SLA: Vercel (99.99% target), Supabase (99.9% target), Pingram (high availability, exact SLA TBC at scale). A full-stack outage requires simultaneous failures across multiple providers.

## 28.3 Accessibility Requirements

WCAG 2.1 AA compliance. All items below must be verified before each phase launches to production.

- **A-01:** All interactive elements — buttons, links, form fields, invitation accept/deny actions — are keyboard navigable and operable without a mouse. Tab order follows logical reading sequence.
- **A-02:** Color contrast minimum 4.5:1 for body text, 3:1 for large text and UI components. Status indicators (Pending, Confirmed, Declined) include a text label alongside any color coding.
- **A-03:** All images, icons, and decorative elements have appropriate alt text or aria-hidden attributes. Icon-only buttons (chat, notifications, upload) have aria-label values.
- **A-04:** Screen reader compatible with VoiceOver (iOS and macOS) and NVDA (Windows). Tested on Safari (iOS) and Chrome (desktop) at minimum.
- **A-05:** Focus indicators clearly visible on all interactive elements. Browser native focus ring is not suppressed without a visible replacement.
- **A-06:** All form fields have descriptive labels. Validation error messages programmatically associated with their field via aria-describedby so screen readers announce them.
- **A-07:** Dynamic content updates — new chat messages, roster status changes, job completion — announced to screen readers using ARIA live regions where appropriate.
- **A-08:** Touch targets on mobile minimum 44×44px. The accept/deny buttons on the invitation response screen are the highest-stakes taps in the app and must be comfortably large.
- **A-09:** PDF sheet music generated by the transcription pipeline includes document metadata (title, key, song name) accessible to assistive technology.

## 28.4 Localisation Scope

- Language: English only. All other languages are out of scope.
- String management: all user-facing strings extracted to an i18n key file (en.json) from day one, even though only English ships. Future localisation becomes a translation task, not a refactor.
- Date and time formatting: locale-aware using the Intl.DateTimeFormat API throughout. Never hardcode date format strings. Respect the church group's configured timezone for all event display.
- Phone number support: US numbers only (E.164 format, +1 country code). International phone numbers are out of scope. Validation uses a US-specific regex at the API layer.

## 28.5 Browser & Device Support

| Platform | Minimum version | Priority | Notes |
| --- | --- | --- | --- |
| **Chrome (desktop)** | v100+ | P0 — must work | Primary development and test browser |
| **Safari (desktop)** | v16+ | P0 — must work | Required for macOS users (worship leaders on MacBook) |
| **iOS Safari** | iOS 16+ | P0 — must work | Critical for PWA Add to Home Screen on iPhone |
| **Chrome (Android)** | v100+ | P0 — must work | Required for Android PWA install |
| **Samsung Internet** | v16+ | P1 — should work | Common on Samsung Android phones |
| **Firefox (desktop)** | v100+ | P1 — should work | |
| **Edge (desktop)** | v100+ | P1 — should work | Chromium-based, inherits Chrome coverage |
| **Internet Explorer (any)** | N/A | Not supported | No polyfills. IE11 is end-of-life. |

# 29. Monitoring & Observability — Phase 5

Monitoring is a dedicated phase (Phase 5) executed when the platform is approaching production readiness for real users. Testing tells you the app works before launch. Monitoring tells you when it breaks after launch. All tools selected are free-tier-first and integrate with the existing stack.

## 29.1 Tooling

| Tool | Purpose | Free tier | What it monitors |
| --- | --- | --- | --- |
| **Sentry** | Error tracking | 5k events/month, 2 users | Unhandled exceptions in Next.js frontend, API routes, and Modal Python worker. Captures stack trace, user context, and request metadata. Alert fires for any new error type within 5 minutes. |
| **Vercel Analytics** | Performance monitoring | Free with Vercel deployment | Core Web Vitals (LCP, CLS, FID) per page. API route latency per endpoint. Alert fires if p95 API latency exceeds 1 second. |
| **Better Uptime** | Uptime monitoring | 10 monitors, 3-min checks, email alerts | Pings /api/health every 3 minutes. Alert fires immediately on two consecutive failed checks. Public status page auto-updates. |
| **Upstash Dashboard** | Queue health | Built-in, free | Queue depth, job success/failure rate, average processing time. Alert fires if queue depth exceeds 20 jobs or failure rate exceeds 10%. |
| **Modal Dashboard** | GPU worker monitoring | Built-in, free | GPU utilization, job duration, error rate per deployment. Alert fires on 3 consecutive job failures. |

## 29.2 Health Endpoint

GET /api/health returns 200 with a JSON payload showing status of all dependent services. Used by Better Uptime and also callable manually.

- Response includes: database connectivity, Redis connectivity, R2 bucket reachability, overall status (healthy / degraded / down).
- If any service is unreachable, status returns 503 with the failing component identified. App may still function in a degraded state.

## 29.3 Alerting

- All alerts route to a designated email address (and optionally a free Slack workspace if set up).
- Alerts are deduplicated — no alert storms for recurring errors. Same error type groups into one alert until resolved.
- On-call: solo developer project. A simple email rule that flags monitoring alerts as high priority is sufficient for Phase 5. Formal on-call rotation is a future consideration for multi-developer teams.
- Incident runbook: a brief document (can be a Notion page) covering: how to rollback a Vercel deploy, how to check Supabase status, how to pause the Modal worker, how to disable the SMS gateway temporarily.

## 29.4 Phase 5 Deliverables

- Sentry integrated in Next.js and Python worker, alerts configured and tested with a real error
- Vercel Analytics enabled, baseline metrics established over one week of usage
- Better Uptime configured with /api/health endpoint, public status page live
- Upstash and Modal dashboards reviewed and alert thresholds set
- Health endpoint deployed and returning correct status for all dependent services
- Incident runbook written and accessible
- All alerting channels tested end-to-end (trigger a real alert, confirm delivery)

# 30. Notification Content Templates

Working copy for all notification types. SMS copy is kept under 160 characters. Email subjects are listed. In-app notifications show the Email column copy. These should be reviewed against brand voice before Phase 1 launch.

| Notification | SMS copy (< 160 chars) | Email subject / In-app copy |
| --- | --- | --- |
| **Set invitation** | *Graceful: You're invited to lead worship on [Date]. Role: [role_note]. Respond here: [link]* | Subject: You're invited to lead worship on [Date]. Preview: [Admin name] has selected you for [Date]. Tap to accept or decline. |
| **24hr reminder (member)** | *Graceful: Reminder - your invitation for [Date] is still pending. Respond: [link]* | Subject: Your invitation for [Date] needs a response. Preview: You haven't responded yet. Please accept or decline. |
| **24hr reminder (admin)** | *Graceful: [N] invitation(s) for [Date] still awaiting response. View roster: [link]* | Subject: [N] unanswered invitations for [Date]. Preview: The following members haven't responded: [names] |
| **Invitation accepted** | *(In-app only — admin sees live roster update)* | [Member name] accepted their invitation for [Date]. Your roster now has [N] confirmed members. |
| **Invitation denied** | *Graceful: [Member name] can't make [Date]. Reason: [reason]. View roster: [link]* | Subject: [Member name] declined for [Date]. Preview: Reason: [reason]. Open Graceful to find a replacement. |
| **Scheduling conflict** | *Graceful: CONFLICT - [Member] is now unavailable for [Date]. View: [link]* | Subject: Scheduling conflict for [Date]. Preview: [Member name] changed their availability after confirming. Action may be needed. |
| **Setlist published** | *Graceful: The setlist for [Date] is live. View it here: [link]* | Subject: Setlist for [Date] is ready. Preview: [N] songs planned. Open Graceful to see the full setlist and your chord charts. |
| **Practice reminder** | *Graceful: [Event name] is [tomorrow/today] at [Time] - [Location]* | Subject: Reminder: [Event name] in [N] hours. Preview: [Day, Date] at [Time] - [Location]. See you there. |
| **New document** | *(In-app only)* | New document added to [Church name] library: [Document name]. Tap to view. |
| **Transcription complete** | *(In-app only)* | Sheet music for '[Song title]' in the key of [Key] is ready. View it in the song library. |
| **Google Calendar event** | *(Email + GCal — no SMS)* | Subject: Calendar update: [Event name] on [Day, Date]. Preview: [Event name] is now [Day, Date] at [Time] - [Location]. Your Google Calendar has been updated. |

> **PROPOSED COPY — REQUIRES HUMAN APPROVAL.** The **Google Calendar event** row above was drafted in issue #69 (this table previously had no row for that email). Fired only on a material change — an event's start time, end time, or location changing, or an attendee being assigned — never on bare create or notes-only edits.

# 31. Timeline Estimates

Each phase is targeted at a maximum of 2 weeks of focused development. No hard deadline is set — quality and passing internal tests take priority over hitting a date. Phase 4 AI pipelines require historical data that can only accumulate over months of real usage; the 2-week estimate covers building the infrastructure, not waiting for the data.

| Phase | Est. | Deliverables |
| --- | --- | --- |
| **Phase 1** (Solo dev) | 2 weeks | User auth with admin and member roles (Clerk); church group creation and member directory; member profiles with instrument list and availability; set invitation flow with accept/deny and 24hr reminders; setlist builder with song library and key selection; event calendar with Google Calendar sync; SMS and email notifications (Pingram + Resend); all Phase 1 unit, integration, and E2E tests passing; all Phase 1 security tests passing. |
| **Phase 2** (Solo dev) | 2 weeks | Week team chat with @mention and notification preferences; church group global document library (Cloudflare R2); past setlist archive searchable by date, song, and team member; Bible app (YouVersion) devotion import; member song familiarity tracking; PWA offline caching for current week documents; mobile-responsive polish across all P0 browser targets. |
| **Phase 3** (Solo dev) | 2 weeks | Audio ingestion: direct upload, YouTube (yt-dlp), Spotify metadata assist; Python pipeline: Demucs + Basic Pitch + music21 + MuseScore (Level 1); async job queue (BullMQ + Upstash Redis) and Modal GPU worker; Level 2: Basic Pitch fine-tuned on Slakh2100; transcription job UI: queue position, progress, completion notification; auto-attach generated PDFs to song library entries; pipeline accuracy regression tests (mir_eval baseline established). |
| **Phase 4** (Solo dev + data) | 2 weeks | AI Pipeline 2: Member Scheduling model (requires Phase 1-2 history); AI Pipeline 3: Setlist Prediction model (requires 50+ setlists of history); AI Pipeline 1 Level 3: Refinement model for transcription accuracy; conflict replacement suggestion integrated into admin notifications; mir_eval benchmark suite enforced as CI merge gate. Note: model training cannot begin until sufficient historical data exists — Phase 4 may span a longer calendar period than 2 active development weeks. |
| **Phase 5** (Solo dev) | 2 weeks | Sentry error tracking integrated (frontend + Python worker); Vercel Analytics baseline metrics established; Better Uptime configured with /api/health, public status page live; queue and GPU worker dashboards configured with alert thresholds; incident runbook written and tested; all alerting channels verified end-to-end; production readiness checklist completed. |

Total estimated active development time: 10 weeks (approximately 2.5 months). Calendar time will be longer due to the Phase 4 data dependency and normal life/work scheduling.

# 32. Risk Register

Risks are scored as High / Medium / Low by combining probability and impact. Named risks are managed risks — each has a defined mitigation strategy.

| ID | Risk | Probability | Impact | Score | Mitigation |
| --- | --- | --- | --- | --- | --- |
| **R-01** | yt-dlp breaks due to YouTube API or ToS changes | High | Medium | **Medium** | Keep yt-dlp pinned to a tested version and subscribe to its release notes. Abstract the audio extraction layer so it can be swapped for an alternative (e.g. direct upload fallback) without changing the pipeline. Communicate the fallback clearly in the UI. |
| **R-02** | Insufficient AI training data for Phase 4 pipelines | Medium | High | **High** | Log all required data from Phase 1 day one (invitations, acceptances, setlists, team compositions). Build a 'manual suggestion' mode in Phase 2 that transitions to AI in Phase 4 without changing the UX surface. Set a minimum data threshold before training begins. |
| **R-03** | Low user adoption — teams don't switch from WhatsApp | Medium | High | **High** | Validate with at least one real team in Phase 1 before building Phase 2. Focus on reducing onboarding friction to under 10 minutes for a worship leader. Offer a migration guide from WhatsApp + Google Sheets. |
| **R-04** | Google Calendar OAuth scope deprecation or API changes | Low | High | **Medium** | Monitor Google's API deprecation announcements. The calendar.events write scope is stable and widely used. Implement graceful degradation: the platform works fully without calendar sync, it's a convenience not a core feature. |
| **R-05** | Modal cold start delays cause transcription to appear broken | Medium | Low | **Low** | Show clear queue position and estimated wait time. Add a 'your job is being prepared...' state before processing starts. Set a keep-warm schedule for Modal workers during peak usage hours (Sunday mornings, Wednesday evenings). |
| **R-06** | Demucs or Basic Pitch breaks on a dependency update | Low | Medium | **Low** | Pin all audio ML library versions in requirements.txt. Run the accuracy regression test suite in CI — any breaking change would fail the pipeline accuracy gate before it reaches production. |
| **R-07** | Supabase free tier limits hit during a growth spike | Low | Medium | **Low** | Monitor usage weekly via the Supabase dashboard. The free tier upgrade to Pro ($25/month) requires no architectural changes. Set an internal alert at 80% of free tier limits to allow time to plan the upgrade. |
| **R-08** | Development timeline slips due to competing priorities | High | Low | **Medium** | Build one phase at a time. Each phase delivers independently useful software so a slip in Phase 3 doesn't block Phase 1 users. Scope reduction between phases is acceptable; shipping broken phases is not. |

# 33. Glossary

Domain-specific terms used throughout this document. Any developer or contributor new to worship team coordination should read this section before working on the codebase.

| Term | Definition |
| --- | --- |
| **Set** | A collection of musicians assembled to lead worship for a specific service. Also called a 'service set' or 'week's team.' The set is defined by who is confirmed for a given service week. |
| **Service week** | The period surrounding a single worship service, typically Sunday through Sunday. The primary organizational unit in Graceful. A service week has a date, a setlist, a roster, and a set of events. |
| **Setlist** | The ordered list of songs planned for a worship service. Created and published by the worship leader. May have zero songs. Each song has a key setting that can differ from the song's default key. |
| **Roster** | The confirmed list of musicians and vocalists for a service week. A slot on the roster moves through states: Open → Pending → Confirmed or Denied. |
| **Worship leader** | The admin-role user responsible for planning and leading the musical component of a church service or ministry event. Builds the roster, creates the setlist, schedules events. May also serve as a musician on the set. |
| **Church group** | The top-level organizational unit in Graceful. Represents a single church, campus ministry, or band. All members, setlists, songs, and documents belong to a church group. Analogous to an 'organization' or 'workspace' in other SaaS platforms. |
| **CRU** | Campus Crusade for Christ — a large campus ministry organization and one of the primary target audiences for Graceful alongside local churches and independent worship bands. |
| **Stem** | An isolated audio track for a single instrument or vocal part, separated from a full audio mix by the Demucs source separation model. The transcription pipeline works stem-by-stem for higher accuracy. |
| **Transcription** | The process of converting audio into written musical notation (sheet music or chord charts). In Graceful, this refers specifically to the automated audio → MIDI → PDF pipeline. |
| **Invitation** | A formal request sent by a worship leader to a member asking them to serve on a specific service week. Must be explicitly accepted or denied. The roster is not confirmed until all invitations are responded to. |
| **Confirmation** | When a member has accepted an invitation and is officially part of a week's roster. Confirmed members receive setlist access, event assignments, Google Calendar sync, and team chat access. |
| **Conflict** | A scheduling issue that occurs when a confirmed member becomes unavailable for a date they have committed to. Detected automatically and reported to the worship leader immediately. |
| **Cajon** | A box-shaped percussion instrument commonly used in acoustic worship settings. One of the default instrument options in Graceful alongside acoustic guitar, electric guitar, bass, piano/keyboard, violin, vocalists, and drums. |
| **Signed URL** | A temporary, expiring URL that grants time-limited access to a private file stored in Cloudflare R2. Generated by the API layer after verifying authentication and church group membership. Default expiry: 30 minutes. |
| **PWA** | Progressive Web App. A web application installable on a mobile phone's home screen, launching full-screen like a native app without requiring the App Store or Google Play. Graceful's mobile strategy. |
| **RLS** | Row-Level Security. A Supabase and PostgreSQL feature that enforces data isolation at the database layer. Ensures a user from Church Group A cannot read or write data belonging to Church Group B, even via direct API calls. |
| **Availability** | A member's declared schedule showing which dates they can or cannot serve. Updated by the member at any time. Changes after a confirmation trigger a conflict alert to the worship leader. |
| **Double-booking** | When a member is confirmed for two service weeks that share the same calendar date. Not allowed. The system warns the worship leader before sending a conflicting invitation. |
| **Pipeline** | The multi-stage technical process for converting audio to sheet music: source separation (Demucs) → note detection (CREPE / Basic Pitch) → quantization (madmom) → key transposition (music21) → PDF rendering (MuseScore). |
| **Modal** | The GPU cloud compute platform used to run the audio transcription pipeline. Workers are isolated containers that spin up on demand, process a single transcription job, and are destroyed after completion. |

# 34. Out of Scope

The following are explicitly not in scope for Phase 1-4. Some are future considerations, some are out of scope entirely. Design decisions should not be constrained by these areas, but should not accidentally assume they exist.

| Out of scope | Rationale / future consideration |
| --- | --- |
| **Multi-church / multi-tenant** | Single-church architecture for Phase 1-3. Multi-tenancy requires tenant isolation, billing, subdomain routing, and per-org data separation. Design data models with future tenancy in mind — prefix tables with org_id — but do not build the admin console or billing layer yet. |
| **Native iOS / Android app** | Web-first. The web app will be fully mobile-responsive and installable as a PWA (Progressive Web App) via 'Add to Home Screen' on both iOS and Android. This gives a native-app feel without the App Store overhead. True native app is a future phase after the product is validated. |
| **Billing / subscription management** | Required when moving to multi-church SaaS. Not needed for single-church. Stripe integration will be scoped at that milestone. |
| **Live streaming integration** | Out of scope for the scheduling and setlist core. Could be explored as a future integration (e.g. link to YouTube Live or Church Online Platform). |
| **CCLI licensing integration** | CCLI (Christian Copyright Licensing) tracks which songs are covered for a church's license. Valuable but not in scope for v1. Could be a future metadata tag on songs in the library. |
| **Full audio mixing / production tools** | Graceful transcribes sheet music from audio but is not a DAW, mixer, or production tool. Audio files are ingested, not edited. |
| **Video playback / media hosting** | Documents and audio files are stored and linked. Video hosting (sermon recordings, tutorial videos) is out of scope — link to YouTube or Vimeo instead. |
| **Financial giving / tithing features** | Entirely outside the product scope. Graceful is a scheduling and music coordination platform. |
| **SMS provider migration to enterprise-grade service** | Pingram is the right choice for Phase 1-4 given its free tier and simple setup. When volume grows beyond the free tier, when uptime SLAs become critical (e.g. pre-service Sunday morning notifications), or when multi-country support is needed, migrating to Telnyx ($0.004/SMS), Sinch (global carrier-grade), or another provider becomes worth the engineering hour it takes. This migration is deliberately out of scope until the product has real usage that justifies it. |
| **Daily member check-in & practice tracking engine** | A feature that tracks how each member feels in preparation for their set, encourages them to practice more, suggests what to practice and for how long, and provides improvement recommendations. This is a valuable long-term vision but is out of scope for all current phases. It requires significant behavior data, push notification infrastructure beyond what Phase 1-2 needs, and a distinct product surface. Deferred to post-Phase 5 evaluation. |

## 34.1 Beta Phase Features

The following features are explicitly planned but scoped to the beta testing phase — not Phase 1 launch. They require a working product for users to interact with before they are meaningful.

| Beta feature | Description |
| --- | --- |
| **First-login feature walkthrough** | When a user logs in for the first time, an interactive walkthrough guides them through the key screens and actions: how to set availability, how to accept an invitation, where to find the setlist and documents, and how to use the week chat. The walkthrough can be dismissed at any time and reactivated from the profile settings menu at any point. Applies to all user types with a walkthrough tailored to each role. |

# 35. Open Questions

| Question | Notes |
| --- | --- |
| **Accept/deny hard deadline?** | What happens if a member never responds? Options: auto-escalate to admin only after N days, auto-deny after a set number of 24hr cycles, or keep alerting indefinitely. Recommend: admin sets a per-week deadline, after which an escalation is sent and the admin decides. |
| **yt-dlp legal posture?** | yt-dlp extraction is for internal church use only (transcription, not redistribution). Legal risk is low for a single-church internal tool, but should be noted in terms of service. Consider adding a ToS acknowledgement to the upload flow. |
| **Google Calendar scope?** | Two options: (1) write-only — Graceful creates events on members' calendars (simpler, one OAuth scope). (2) read+write — Graceful can also read conflicts from members' Google Calendars to improve availability accuracy. Recommend: start with write-only. |
| **Spotify song search UX?** | Spotify metadata is used for search/identification. When a worship leader searches for a song, should the app search Spotify first and populate metadata automatically, or use a manual entry form? |
| **Data retention and privacy?** | How long is scheduling and setlist history retained? Members have a right to see and delete their own data. GDPR/CCPA posture should be defined before launch even for a single church. |
| **AI cold-start for Phase 4?** | Pipelines 2 and 3 require months of data before they are useful. Consider building a lightweight 'manual suggestion' mode in Phase 2 (admin picks from a filtered member list) that later becomes AI-powered in Phase 4 without changing the UX surface. |

---

*End of requirements document — Graceful v0.10*
