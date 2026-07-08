-- RLS Integration Test Seed Data
-- Applied via service role (bypasses RLS) — never used for test assertions.
-- IDs match the constants in tests/integration/rls/setup.ts.
--
-- Two-tenant topology:
--   Church A: adminA, leaderA, memberA, memberA2, guestA
--   Church B: memberB, adminB
--
-- Apply: psql "$SUPABASE_TEST_URL" -f supabase/seed-rls-test.sql

-- ============ TRUNCATE (idempotent re-seed) ============

TRUNCATE
  audit_logs, google_calendar_tokens, notification_preferences,
  notifications, availability, song_documents, songs,
  conflicts, event_attendees, invitations, events,
  setlist_songs, setlists, service_weeks,
  member_instruments, member_profiles,
  instruments, users, church_groups
CASCADE;

-- ============ CHURCH GROUPS ============

INSERT INTO church_groups (id, name, denomination, timezone, invite_code) VALUES
  ('00000000-0000-4000-8000-000000000001', 'Church A', 'Baptist',      'America/Chicago',     'CHURCH-A-CODE'),
  ('00000000-0000-4000-8000-000000000002', 'Church B', 'Presbyterian', 'America/Los_Angeles', 'CHURCH-B-CODE');

-- ============ USERS ============

INSERT INTO users (id, clerk_id, church_group_id, role, name, email) VALUES
  ('00000000-0000-4000-8001-000000000001', 'test_admin_a',   '00000000-0000-4000-8000-000000000001', 'admin',      'Admin A',   'admin_a@test.example'),
  ('00000000-0000-4000-8001-000000000002', 'test_leader_a',  '00000000-0000-4000-8000-000000000001', 'set_leader', 'Leader A',  'leader_a@test.example'),
  ('00000000-0000-4000-8001-000000000003', 'test_member_a',  '00000000-0000-4000-8000-000000000001', 'member',     'Member A',  'member_a@test.example'),
  ('00000000-0000-4000-8001-000000000004', 'test_member_a2', '00000000-0000-4000-8000-000000000001', 'member',     'Member A2', 'member_a2@test.example'),
  ('00000000-0000-4000-8001-000000000005', 'test_guest_a',   '00000000-0000-4000-8000-000000000001', 'guest',      'Guest A',   'guest_a@test.example'),
  ('00000000-0000-4000-8002-000000000001', 'test_member_b',  '00000000-0000-4000-8000-000000000002', 'member',     'Member B',  'member_b@test.example'),
  ('00000000-0000-4000-8002-000000000002', 'test_admin_b',   '00000000-0000-4000-8000-000000000002', 'admin',      'Admin B',   'admin_b@test.example');

-- ============ INSTRUMENTS ============

INSERT INTO instruments (id, church_group_id, name, is_default) VALUES
  ('00000000-0000-4000-8003-000000000001', '00000000-0000-4000-8000-000000000001', 'Piano',  true),
  ('00000000-0000-4000-8003-000000000002', '00000000-0000-4000-8000-000000000001', 'Guitar', true),
  ('00000000-0000-4000-8003-000000000003', '00000000-0000-4000-8000-000000000002', 'Drums',  true);

-- ============ MEMBER PROFILES ============

INSERT INTO member_profiles (id, user_id, vocal_capability) VALUES
  ('00000000-0000-4000-8004-000000000001', '00000000-0000-4000-8001-000000000003', 'lead'),
  ('00000000-0000-4000-8004-000000000002', '00000000-0000-4000-8001-000000000004', 'harmony'),
  ('00000000-0000-4000-8004-000000000003', '00000000-0000-4000-8002-000000000001', 'lead');

-- ============ MEMBER INSTRUMENTS ============

INSERT INTO member_instruments (id, member_profile_id, instrument_id) VALUES
  ('00000000-0000-4000-8004-000000000010', '00000000-0000-4000-8004-000000000001', '00000000-0000-4000-8003-000000000001'),
  ('00000000-0000-4000-8004-000000000011', '00000000-0000-4000-8004-000000000002', '00000000-0000-4000-8003-000000000002'),
  ('00000000-0000-4000-8004-000000000012', '00000000-0000-4000-8004-000000000003', '00000000-0000-4000-8003-000000000003');

-- ============ SERVICE WEEKS ============

INSERT INTO service_weeks (id, church_group_id, service_date, title) VALUES
  ('00000000-0000-4000-8005-000000000001', '00000000-0000-4000-8000-000000000001', '2026-07-06', 'Service Week A1'),
  ('00000000-0000-4000-8005-000000000003', '00000000-0000-4000-8000-000000000001', '2026-07-13', 'Service Week A2'),
  ('00000000-0000-4000-8005-000000000002', '00000000-0000-4000-8000-000000000002', '2026-07-06', 'Service Week B1');

-- ============ SETLISTS ============

INSERT INTO setlists (id, church_group_id, service_week_id, status) VALUES
  ('00000000-0000-4000-8006-000000000001', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8005-000000000001', 'draft'),
  ('00000000-0000-4000-8006-000000000003', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8005-000000000003', 'published'),
  ('00000000-0000-4000-8006-000000000002', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8005-000000000002', 'published');

-- ============ SONGS ============

INSERT INTO songs (id, church_group_id, title, artist) VALUES
  ('00000000-0000-4000-8007-000000000001', '00000000-0000-4000-8000-000000000001', 'Song A1', 'Artist A'),
  ('00000000-0000-4000-8007-000000000002', '00000000-0000-4000-8000-000000000001', 'Song A2', 'Artist A'),
  ('00000000-0000-4000-8007-000000000003', '00000000-0000-4000-8000-000000000002', 'Song B1', 'Artist B');

-- ============ SETLIST SONGS ============

INSERT INTO setlist_songs (id, setlist_id, song_id, position) VALUES
  ('00000000-0000-4000-8008-000000000001', '00000000-0000-4000-8006-000000000001', '00000000-0000-4000-8007-000000000001', 1),
  ('00000000-0000-4000-8008-000000000002', '00000000-0000-4000-8006-000000000003', '00000000-0000-4000-8007-000000000002', 1),
  ('00000000-0000-4000-8008-000000000003', '00000000-0000-4000-8006-000000000002', '00000000-0000-4000-8007-000000000003', 1);

-- ============ EVENTS ============

INSERT INTO events (id, church_group_id, service_week_id, type, name, start_time, end_time) VALUES
  ('00000000-0000-4000-8009-000000000001', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8005-000000000001', 'rehearsal', 'Rehearsal A', '2026-07-06 09:00:00+00', '2026-07-06 11:00:00+00'),
  ('00000000-0000-4000-8009-000000000002', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8005-000000000002', 'rehearsal', 'Rehearsal B', '2026-07-06 09:00:00+00', '2026-07-06 11:00:00+00');

-- ============ INVITATIONS ============

INSERT INTO invitations (id, church_group_id, service_week_id, user_id, status, response_token) VALUES
  ('00000000-0000-4000-800a-000000000001', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8005-000000000001', '00000000-0000-4000-8001-000000000003', 'pending', 'token-member-a-001'),
  ('00000000-0000-4000-800a-000000000002', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8005-000000000001', '00000000-0000-4000-8001-000000000004', 'pending', 'token-member-a2-001'),
  ('00000000-0000-4000-800a-000000000003', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8005-000000000002', '00000000-0000-4000-8002-000000000001', 'pending', 'token-member-b-001');

-- ============ CONFLICTS ============

INSERT INTO conflicts (id, church_group_id, invitation_id) VALUES
  ('00000000-0000-4000-800b-000000000001', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-800a-000000000001'),
  ('00000000-0000-4000-800b-000000000002', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-800a-000000000003');

-- ============ AVAILABILITY ============

INSERT INTO availability (id, user_id, church_group_id, date, is_available) VALUES
  ('00000000-0000-4000-800c-000000000001', '00000000-0000-4000-8001-000000000003', '00000000-0000-4000-8000-000000000001', '2026-07-06', true),
  ('00000000-0000-4000-800c-000000000002', '00000000-0000-4000-8001-000000000004', '00000000-0000-4000-8000-000000000001', '2026-07-06', false),
  ('00000000-0000-4000-800c-000000000003', '00000000-0000-4000-8002-000000000001', '00000000-0000-4000-8000-000000000002', '2026-07-06', true);

-- ============ NOTIFICATIONS ============

INSERT INTO notifications (id, church_group_id, user_id, type, title) VALUES
  ('00000000-0000-4000-800d-000000000001', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8001-000000000003', 'set_invitation', 'You have been invited'),
  ('00000000-0000-4000-800d-000000000002', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8002-000000000001', 'set_invitation', 'Church B notification');

-- ============ NOTIFICATION PREFERENCES ============

INSERT INTO notification_preferences (id, user_id) VALUES
  ('00000000-0000-4000-800e-000000000001', '00000000-0000-4000-8001-000000000003'),
  ('00000000-0000-4000-800e-000000000002', '00000000-0000-4000-8002-000000000001');

-- ============ GOOGLE CALENDAR TOKENS ============

INSERT INTO google_calendar_tokens (id, user_id, access_token_encrypted, refresh_token_encrypted, token_expiry, calendar_id, scope) VALUES
  ('00000000-0000-4000-8010-000000000001', '00000000-0000-4000-8001-000000000003', 'enc_access_a', 'enc_refresh_a', '2027-01-01 00:00:00+00', 'cal@test.example', 'https://www.googleapis.com/auth/calendar'),
  ('00000000-0000-4000-8010-000000000002', '00000000-0000-4000-8002-000000000001', 'enc_access_a', 'enc_refresh_a', '2027-01-01 00:00:00+00', 'cal-b@test.example', 'https://www.googleapis.com/auth/calendar');

-- ============ AUDIT LOGS ============

INSERT INTO audit_logs (id, church_group_id, user_id, action, entity_type, entity_id) VALUES
  ('00000000-0000-4000-800f-000000000001', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8001-000000000001', 'user.role_changed', 'user', '00000000-0000-4000-8001-000000000003'),
  ('00000000-0000-4000-800f-000000000002', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8002-000000000002', 'user.role_changed', 'user', '00000000-0000-4000-8002-000000000001');

-- ============ SONG DOCUMENTS ============

INSERT INTO song_documents (id, song_id, church_group_id, name, file_key, file_type, file_size_bytes) VALUES
  ('00000000-0000-4000-8011-000000000001', '00000000-0000-4000-8007-000000000001', '00000000-0000-4000-8000-000000000001', 'Chord Chart', 'songs/chord-a1.pdf', 'application/pdf', 12345),
  ('00000000-0000-4000-8011-000000000002', '00000000-0000-4000-8007-000000000003', '00000000-0000-4000-8000-000000000002', 'Chord Chart B', 'songs/chord-b1.pdf', 'application/pdf', 2222);

-- ============ EVENT ATTENDEES ============

INSERT INTO event_attendees (id, event_id, user_id) VALUES
  ('00000000-0000-4000-8012-000000000001', '00000000-0000-4000-8009-000000000001', '00000000-0000-4000-8001-000000000003'),
  ('00000000-0000-4000-8012-000000000002', '00000000-0000-4000-8009-000000000002', '00000000-0000-4000-8002-000000000001');
