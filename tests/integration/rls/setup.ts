/**
 * Global test setup for RLS integration tests.
 *
 * Checks required env vars are present and seeds the two-tenant test fixture
 * using the service-role client (bypasses RLS). Tests run against this snapshot
 * and must NOT mutate shared state — use per-test inserts/deletes inside
 * describe blocks with appropriate cleanup.
 *
 * Skip the entire suite when SUPABASE_TEST_URL is absent so unit-test runs
 * (which lack Docker / Supabase) are unaffected.
 */

import * as fs from "fs";
import * as path from "path";
import { getServiceClient } from "./client";

/** Shared flag: set to true only when all required env vars are present. */
export let rlsTestsEnabled = false;

/** IDs exported for use in individual test files. */
export const IDS = {
  churches: {
    A: "00000000-0000-4000-8000-000000000001",
    B: "00000000-0000-4000-8000-000000000002",
  },
  users: {
    adminA:   "00000000-0000-4000-8001-000000000001",
    leaderA:  "00000000-0000-4000-8001-000000000002",
    memberA:  "00000000-0000-4000-8001-000000000003",
    memberA2: "00000000-0000-4000-8001-000000000004",
    guestA:   "00000000-0000-4000-8001-000000000005",
    memberB:  "00000000-0000-4000-8002-000000000001",
    adminB:   "00000000-0000-4000-8002-000000000002",
  },
  clerkIds: {
    adminA:   "test_admin_a",
    leaderA:  "test_leader_a",
    memberA:  "test_member_a",
    memberA2: "test_member_a2",
    guestA:   "test_guest_a",
    memberB:  "test_member_b",
    adminB:   "test_admin_b",
  },
  instruments: {
    pianoA:  "00000000-0000-4000-8003-000000000001",
    guitarA: "00000000-0000-4000-8003-000000000002",
    drumsB:  "00000000-0000-4000-8003-000000000003",
  },
  serviceWeeks: {
    A1: "00000000-0000-4000-8005-000000000001",
    A2: "00000000-0000-4000-8005-000000000003",
    B1: "00000000-0000-4000-8005-000000000002",
  },
  setlists: {
    draftA:     "00000000-0000-4000-8006-000000000001",
    publishedA: "00000000-0000-4000-8006-000000000003",
    publishedB: "00000000-0000-4000-8006-000000000002",
  },
  songs: {
    A1: "00000000-0000-4000-8007-000000000001",
    A2: "00000000-0000-4000-8007-000000000002",
    B1: "00000000-0000-4000-8007-000000000003",
  },
  setlistSongs: {
    draftA:     "00000000-0000-4000-8008-000000000001",
    publishedA: "00000000-0000-4000-8008-000000000002",
    publishedB: "00000000-0000-4000-8008-000000000003",
  },
  events: {
    A: "00000000-0000-4000-8009-000000000001",
    B: "00000000-0000-4000-8009-000000000002",
  },
  invitations: {
    memberA:  "00000000-0000-4000-800a-000000000001",
    memberA2: "00000000-0000-4000-800a-000000000002",
    memberB:  "00000000-0000-4000-800a-000000000003",
  },
  conflicts: {
    A: "00000000-0000-4000-800b-000000000001",
    B: "00000000-0000-4000-800b-000000000002",
  },
  availability: {
    memberA:  "00000000-0000-4000-800c-000000000001",
    memberA2: "00000000-0000-4000-800c-000000000002",
    memberB:  "00000000-0000-4000-800c-000000000003",
  },
  notifications: {
    memberA: "00000000-0000-4000-800d-000000000001",
    memberB: "00000000-0000-4000-800d-000000000002",
  },
  auditLogs: {
    A: "00000000-0000-4000-800f-000000000001",
    B: "00000000-0000-4000-800f-000000000002",
  },
  gCalTokens: {
    memberA: "00000000-0000-4000-8010-000000000001",
    memberB: "00000000-0000-4000-8010-000000000002",
  },
  memberProfiles: {
    memberA:  "00000000-0000-4000-8004-000000000001",
    memberA2: "00000000-0000-4000-8004-000000000002",
    memberB:  "00000000-0000-4000-8004-000000000003",
  },
  memberInstruments: {
    memberA:  "00000000-0000-4000-8004-000000000010",
    memberA2: "00000000-0000-4000-8004-000000000011",
    memberB:  "00000000-0000-4000-8004-000000000012",
  },
  songDocuments: {
    A: "00000000-0000-4000-8011-000000000001",
    B: "00000000-0000-4000-8011-000000000002",
  },
  notificationPreferences: {
    memberA: "00000000-0000-4000-800e-000000000001",
    memberB: "00000000-0000-4000-800e-000000000002",
  },
  eventAttendees: {
    A: "00000000-0000-4000-8012-000000000001",
    B: "00000000-0000-4000-8012-000000000002",
  },
} as const;

const REQUIRED_VARS = [
  "SUPABASE_TEST_URL",
  "SUPABASE_TEST_ANON_KEY",
  "SUPABASE_TEST_SERVICE_ROLE_KEY",
  "SUPABASE_JWT_SECRET",
];

function checkEnv(): boolean {
  return REQUIRED_VARS.every((v) => Boolean(process.env[v]));
}

/** Call in beforeAll of each test file to gate the suite. */
export async function globalSetup(): Promise<void> {
  rlsTestsEnabled = checkEnv();
  if (!rlsTestsEnabled) {
    console.warn(
      "[RLS tests] Skipping — set SUPABASE_TEST_URL, SUPABASE_TEST_ANON_KEY, " +
        "SUPABASE_TEST_SERVICE_ROLE_KEY, SUPABASE_JWT_SECRET to enable.",
    );
    return;
  }

  const seedPath = path.resolve(__dirname, "../../../supabase/seed-rls-test.sql");
  const sql = fs.readFileSync(seedPath, "utf8");

  const svc = getServiceClient();
  const { error } = await svc.rpc("exec_sql", { query: sql }).single();

  if (error) {
    // Fallback: execute via raw query if exec_sql RPC not available.
    // The service client can run raw SQL through the pg REST extensions when
    // the Supabase local dev server is running. If that also fails, the error
    // will surface clearly from the test runner.
    console.error("[RLS tests] seed failed:", error.message);
    throw new Error(`RLS seed failed: ${error.message}`);
  }
}

/**
 * Lightweight alternative: seed by running individual INSERT statements via
 * the service client when the exec_sql RPC is not available.
 * Used as a fallback in beforeAll hooks.
 */
export async function seedViaServiceClient(): Promise<void> {
  if (!rlsTestsEnabled) return;

  const svc = getServiceClient();

  // Truncate in reverse FK order
  const tables = [
    "audit_logs", "google_calendar_tokens", "notification_preferences",
    "notifications", "availability", "song_documents", "songs",
    "conflicts", "event_attendees", "invitations", "events",
    "setlist_songs", "setlists", "service_weeks", "member_instruments",
    "member_profiles", "instruments", "users", "church_groups",
  ];

  for (const table of tables) {
    await svc.from(table).delete().neq("id", "00000000-0000-0000-0000-000000000000");
  }

  // Church groups
  await svc.from("church_groups").insert([
    { id: IDS.churches.A, name: "Church A", denomination: "Baptist",      timezone: "America/Chicago",      invite_code: "CHURCH-A-CODE" },
    { id: IDS.churches.B, name: "Church B", denomination: "Presbyterian", timezone: "America/Los_Angeles",  invite_code: "CHURCH-B-CODE" },
  ]);

  // Users
  await svc.from("users").insert([
    { id: IDS.users.adminA,   clerk_id: IDS.clerkIds.adminA,   church_group_id: IDS.churches.A, role: "admin",      name: "Admin A",   email: "admin_a@test.example" },
    { id: IDS.users.leaderA,  clerk_id: IDS.clerkIds.leaderA,  church_group_id: IDS.churches.A, role: "set_leader", name: "Leader A",  email: "leader_a@test.example" },
    { id: IDS.users.memberA,  clerk_id: IDS.clerkIds.memberA,  church_group_id: IDS.churches.A, role: "member",     name: "Member A",  email: "member_a@test.example" },
    { id: IDS.users.memberA2, clerk_id: IDS.clerkIds.memberA2, church_group_id: IDS.churches.A, role: "member",     name: "Member A2", email: "member_a2@test.example" },
    { id: IDS.users.guestA,   clerk_id: IDS.clerkIds.guestA,   church_group_id: IDS.churches.A, role: "guest",      name: "Guest A",   email: "guest_a@test.example" },
    { id: IDS.users.memberB,  clerk_id: IDS.clerkIds.memberB,  church_group_id: IDS.churches.B, role: "member",     name: "Member B",  email: "member_b@test.example" },
    { id: IDS.users.adminB,   clerk_id: IDS.clerkIds.adminB,   church_group_id: IDS.churches.B, role: "admin",      name: "Admin B",   email: "admin_b@test.example" },
  ]);

  // Instruments
  await svc.from("instruments").insert([
    { id: IDS.instruments.pianoA,  church_group_id: IDS.churches.A, name: "Piano",  is_default: true },
    { id: IDS.instruments.guitarA, church_group_id: IDS.churches.A, name: "Guitar", is_default: true },
    { id: IDS.instruments.drumsB,  church_group_id: IDS.churches.B, name: "Drums",  is_default: true },
  ]);

  // Member profiles
  await svc.from("member_profiles").insert([
    { id: IDS.memberProfiles.memberA,  user_id: IDS.users.memberA,  vocal_capability: "lead" },
    { id: IDS.memberProfiles.memberA2, user_id: IDS.users.memberA2, vocal_capability: "harmony" },
    { id: IDS.memberProfiles.memberB,  user_id: IDS.users.memberB,  vocal_capability: "lead" },
  ]);

  // Member instruments
  await svc.from("member_instruments").insert([
    { id: IDS.memberInstruments.memberA,  member_profile_id: IDS.memberProfiles.memberA,  instrument_id: IDS.instruments.pianoA },
    { id: IDS.memberInstruments.memberA2, member_profile_id: IDS.memberProfiles.memberA2, instrument_id: IDS.instruments.guitarA },
    { id: IDS.memberInstruments.memberB,  member_profile_id: IDS.memberProfiles.memberB,  instrument_id: IDS.instruments.drumsB },
  ]);

  // Service weeks
  await svc.from("service_weeks").insert([
    { id: IDS.serviceWeeks.A1, church_group_id: IDS.churches.A, service_date: "2026-07-06", title: "Service Week A1" },
    { id: IDS.serviceWeeks.A2, church_group_id: IDS.churches.A, service_date: "2026-07-13", title: "Service Week A2" },
    { id: IDS.serviceWeeks.B1, church_group_id: IDS.churches.B, service_date: "2026-07-06", title: "Service Week B1" },
  ]);

  // Setlists
  await svc.from("setlists").insert([
    { id: IDS.setlists.draftA,     church_group_id: IDS.churches.A, service_week_id: IDS.serviceWeeks.A1, status: "draft" },
    { id: IDS.setlists.publishedA, church_group_id: IDS.churches.A, service_week_id: IDS.serviceWeeks.A2, status: "published", published_at: new Date().toISOString() },
    { id: IDS.setlists.publishedB, church_group_id: IDS.churches.B, service_week_id: IDS.serviceWeeks.B1, status: "published" },
  ]);

  // Songs
  await svc.from("songs").insert([
    { id: IDS.songs.A1, church_group_id: IDS.churches.A, title: "Song A1", artist: "Artist A" },
    { id: IDS.songs.A2, church_group_id: IDS.churches.A, title: "Song A2", artist: "Artist A" },
    { id: IDS.songs.B1, church_group_id: IDS.churches.B, title: "Song B1", artist: "Artist B" },
  ]);

  // Setlist songs
  await svc.from("setlist_songs").insert([
    { id: IDS.setlistSongs.draftA,     setlist_id: IDS.setlists.draftA,     song_id: IDS.songs.A1, position: 1 },
    { id: IDS.setlistSongs.publishedA, setlist_id: IDS.setlists.publishedA, song_id: IDS.songs.A2, position: 1 },
    { id: IDS.setlistSongs.publishedB, setlist_id: IDS.setlists.publishedB, song_id: IDS.songs.B1, position: 1 },
  ]);

  // Events
  await svc.from("events").insert([
    { id: IDS.events.A, church_group_id: IDS.churches.A, service_week_id: IDS.serviceWeeks.A1, type: "rehearsal", name: "Rehearsal A", start_time: "2026-07-06T09:00:00Z", end_time: "2026-07-06T11:00:00Z" },
    { id: IDS.events.B, church_group_id: IDS.churches.B, service_week_id: IDS.serviceWeeks.B1, type: "rehearsal", name: "Rehearsal B", start_time: "2026-07-06T09:00:00Z", end_time: "2026-07-06T11:00:00Z" },
  ]);

  // Invitations
  await svc.from("invitations").insert([
    { id: IDS.invitations.memberA,  church_group_id: IDS.churches.A, service_week_id: IDS.serviceWeeks.A1, user_id: IDS.users.memberA,  status: "pending", response_token: "token-member-a-001" },
    { id: IDS.invitations.memberA2, church_group_id: IDS.churches.A, service_week_id: IDS.serviceWeeks.A1, user_id: IDS.users.memberA2, status: "pending", response_token: "token-member-a2-001" },
    { id: IDS.invitations.memberB,  church_group_id: IDS.churches.B, service_week_id: IDS.serviceWeeks.B1, user_id: IDS.users.memberB,  status: "pending", response_token: "token-member-b-001" },
  ]);

  // Conflicts
  await svc.from("conflicts").insert([
    { id: IDS.conflicts.A, church_group_id: IDS.churches.A, invitation_id: IDS.invitations.memberA },
    { id: IDS.conflicts.B, church_group_id: IDS.churches.B, invitation_id: IDS.invitations.memberB },
  ]);

  // Availability
  await svc.from("availability").insert([
    { id: IDS.availability.memberA,  user_id: IDS.users.memberA,  church_group_id: IDS.churches.A, date: "2026-07-06", is_available: true },
    { id: IDS.availability.memberA2, user_id: IDS.users.memberA2, church_group_id: IDS.churches.A, date: "2026-07-06", is_available: false },
    { id: IDS.availability.memberB,  user_id: IDS.users.memberB,  church_group_id: IDS.churches.B, date: "2026-07-06", is_available: true },
  ]);

  // Notifications
  await svc.from("notifications").insert([
    { id: IDS.notifications.memberA, church_group_id: IDS.churches.A, user_id: IDS.users.memberA, type: "set_invitation", title: "You have been invited" },
    { id: IDS.notifications.memberB, church_group_id: IDS.churches.B, user_id: IDS.users.memberB, type: "set_invitation", title: "Church B notification" },
  ]);

  // Notification preferences
  await svc.from("notification_preferences").insert([
    { id: IDS.notificationPreferences.memberA, user_id: IDS.users.memberA },
    { id: IDS.notificationPreferences.memberB, user_id: IDS.users.memberB },
  ]);

  // Audit logs
  await svc.from("audit_logs").insert([
    { id: IDS.auditLogs.A, church_group_id: IDS.churches.A, user_id: IDS.users.adminA, action: "user.role_changed", entity_type: "user", entity_id: IDS.users.memberA },
    { id: IDS.auditLogs.B, church_group_id: IDS.churches.B, user_id: IDS.users.adminB, action: "user.role_changed", entity_type: "user", entity_id: IDS.users.memberB },
  ]);

  // Google calendar tokens
  await svc.from("google_calendar_tokens").insert([
    { id: IDS.gCalTokens.memberA, user_id: IDS.users.memberA, access_token_encrypted: "enc_access", refresh_token_encrypted: "enc_refresh", token_expiry: new Date(Date.now() + 3600000).toISOString(), calendar_id: "cal@test.example", scope: "https://www.googleapis.com/auth/calendar" },
    { id: IDS.gCalTokens.memberB, user_id: IDS.users.memberB, access_token_encrypted: "enc_access", refresh_token_encrypted: "enc_refresh", token_expiry: new Date(Date.now() + 3600000).toISOString(), calendar_id: "cal-b@test.example", scope: "https://www.googleapis.com/auth/calendar" },
  ]);

  // Song documents
  await svc.from("song_documents").insert([
    { id: IDS.songDocuments.A, song_id: IDS.songs.A1, church_group_id: IDS.churches.A, name: "Chord Chart", file_key: "songs/chord-a1.pdf", file_type: "application/pdf", file_size_bytes: 12345 },
    { id: IDS.songDocuments.B, song_id: IDS.songs.B1, church_group_id: IDS.churches.B, name: "Chord Chart B", file_key: "songs/chord-b1.pdf", file_type: "application/pdf", file_size_bytes: 2222 },
  ]);

  // Event attendees (must come after events and users)
  await svc.from("event_attendees").insert([
    { id: IDS.eventAttendees.A, event_id: IDS.events.A, user_id: IDS.users.memberA },
    { id: IDS.eventAttendees.B, event_id: IDS.events.B, user_id: IDS.users.memberB },
  ]);
}
