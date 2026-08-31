-- Migration: practice reminder scheduler — Issue #69 (OQ1 resolution)
--
-- PRD §14: "Practice reminder | Confirmed members | SMS + Email | Configurable
-- lead time before each event (24hr, 2hr, etc.)". Before #69 the copy builders
-- existed (lib/notifications/sms-templates.ts practiceReminderSms,
-- lib/resend/templates.ts practice_reminder) but nothing triggered them and
-- there was no scheduling infrastructure. Per the human OQ1 resolution
-- (.pipeline/spec.md) this migration builds it, mirroring the invitation
-- reminder scheduler (20260713000003_invitation_reminder_scheduler.sql):
--
--   * a new cron route app/api/cron/practice-reminders/route.ts + a matching
--     GitHub Actions workflow invoke this hourly with the CRON_SECRET bearer,
--   * lead time is PER-USER: notification_preferences.reminder_hours_before
--     (default 24) — the narrow read overlap with #70 is explicitly approved
--     for this purpose only,
--   * recipients are confirmed members (accepted invitation for the event's
--     service week),
--   * a new per-(event, user) sent-marker table makes sends idempotent across
--     hourly runs — a per-user lead time rules out a single events column.
--
-- Like send_invitation_reminders, the job has no Clerk session and the
-- service-role key is banned in app/ and lib/ (scripts/check-service-role.mjs),
-- so the RLS-protected reads (events, users, invitations,
-- notification_preferences) and the sent-marker writes run through a SECURITY
-- DEFINER RPC granted to `anon`. The RPC returns only the rows it *itself*
-- inserted into the marker table this run, so it is self-throttling: a stray
-- anon call can at most advance each (event, user) reminder once, ever. The
-- HTTP endpoint is additionally guarded by CRON_SECRET.

-- ============ UP ============

CREATE TABLE public.practice_reminder_sends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  sent_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, user_id)
);

-- Internal idempotency ledger: written only by send_practice_reminders()
-- (SECURITY DEFINER, runs as owner and bypasses RLS). No authenticated/anon
-- policy → all direct access is denied, same approach as audit_logs INSERT.
ALTER TABLE public.practice_reminder_sends ENABLE ROW LEVEL SECURITY;

-- public.send_practice_reminders(): finds every (future event × confirmed
-- member) pair whose per-user lead time has been reached and that has not
-- already been reminded, marks it sent, and returns the list the cron route
-- must dispatch SMS + Email for. Excludes cancelled service weeks. The
-- returned rows are exactly the marker rows THIS call inserted.
CREATE OR REPLACE FUNCTION public.send_practice_reminders()
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  VOLATILE
  SET search_path = ''
AS $$
DECLARE
  v_result jsonb;
BEGIN
  -- Due pairs: event in the future, its service week live, the per-user lead
  -- time reached, and no existing marker row. DISTINCT ON collapses a member
  -- who holds more than one accepted invitation for the same week.
  CREATE TEMPORARY TABLE due_practice_reminders ON COMMIT DROP AS
  SELECT DISTINCT ON (e.id, inv.user_id)
    e.id                                            AS event_id,
    e.name                                          AS event_name,
    e.location                                      AS location,
    e.start_time                                    AS start_time,
    e.service_week_id                               AS service_week_id,
    e.church_group_id                               AS church_group_id,
    inv.user_id                                     AS user_id,
    u.name                                          AS member_name,
    u.email                                         AS email,
    u.phone                                         AS phone,
    u.sms_opted_in                                  AS sms_opted_in,
    coalesce(np.reminder_hours_before, 24)          AS reminder_hours_before
  FROM public.events e
  JOIN public.service_weeks sw ON sw.id = e.service_week_id
  JOIN public.invitations inv
    ON inv.service_week_id = e.service_week_id
   AND inv.status = 'accepted'
  JOIN public.users u ON u.id = inv.user_id
  LEFT JOIN public.notification_preferences np ON np.user_id = inv.user_id
  WHERE sw.is_cancelled = false
    AND e.start_time > now()
    AND now() >= e.start_time - (coalesce(np.reminder_hours_before, 24) || ' hours')::interval
    AND NOT EXISTS (
      SELECT 1 FROM public.practice_reminder_sends prs
      WHERE prs.event_id = e.id AND prs.user_id = inv.user_id
    )
  ORDER BY e.id, inv.user_id;

  WITH inserted AS (
    INSERT INTO public.practice_reminder_sends (event_id, user_id)
    SELECT event_id, user_id FROM due_practice_reminders
    ON CONFLICT (event_id, user_id) DO NOTHING
    RETURNING event_id, user_id
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'event_id', d.event_id,
           'user_id', d.user_id,
           'member_name', d.member_name,
           'email', d.email,
           'phone', d.phone,
           'sms_opted_in', d.sms_opted_in,
           'event_name', d.event_name,
           'location', d.location,
           'start_time', d.start_time,
           'service_week_id', d.service_week_id,
           'reminder_hours_before', d.reminder_hours_before
         )), '[]'::jsonb)
  INTO v_result
  FROM due_practice_reminders d
  JOIN inserted i ON i.event_id = d.event_id AND i.user_id = d.user_id;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.send_practice_reminders() TO anon, authenticated;

-- ============ DOWN ============
-- DROP FUNCTION IF EXISTS public.send_practice_reminders();
-- DROP TABLE IF EXISTS public.practice_reminder_sends;
