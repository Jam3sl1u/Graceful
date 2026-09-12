-- Migration: practice reminder scheduler — Issue #69 (OQ1 resolution)
--
-- PRD §14: "Practice reminder | Confirmed members | SMS + Email | Configurable
-- lead time before each event (24hr, 2hr, etc.)". Before #69 the copy builders
-- existed (lib/notifications/sms-templates.ts practiceReminderSms,
-- lib/resend/templates.ts practice_reminder) but nothing triggered them and
-- there was no scheduling infrastructure. Per the OQ1 resolution recorded in
-- .pipeline/spec.md (operator decision, 2026-08-31) this migration builds it:
--
--   * a new cron route app/api/cron/practice-reminders/route.ts + a matching
--     GitHub Actions workflow invoke this hourly with the CRON_SECRET bearer,
--   * lead time + channel choice are PER-USER, read from the reminder-specific
--     notification_preferences columns (reminder_hours_before default 24,
--     reminder_email default false, reminder_sms default true) — a bounded
--     overlap with #70, which still owns the preferences UI and all other
--     per-type channel gating,
--   * recipients are members with an accepted invitation for the event's
--     service week (deliberately broader than the GCal-event-email's
--     event_attendees scope: "come to Saturday's rehearsal" is relevant to the
--     whole confirmed team, not only those assigned to that one event),
--   * a per-(event, user) ledger makes sends idempotent across hourly runs.
--
-- SECURITY (review B2 / B2-R1 / B2-R2 / M3 / MED-1..3):
--
--   The cron job has no Clerk session and the service-role key is banned in
--   app/ and lib/ (scripts/check-service-role.mjs), so the RLS-protected reads
--   run through SECURITY DEFINER RPCs. Unlike the pre-existing
--   send_invitation_reminders() (whose anon grant is a separate, tracked
--   concern — its writes only defer a reminder 24h and it is designed to
--   re-send), a practice reminder is ONE-SHOT: a permanent "sent" marker is
--   required, and an anon-writable permanent marker is a product-wide
--   denial-of-service vector (an unauthenticated poller marks every due pair
--   "sent" and no member ever gets the reminder). So BOTH RPCs here are gated
--   on a shared secret the cron route holds (CRON_SECRET), matched against
--   public.app_secrets — RLS on, no policy, AND explicitly REVOKE'd from
--   PUBLIC/anon/authenticated (belt-and-braces, cf. audit_logs in
--   20260702000006). The secret row is seeded out-of-band after deploy (see
--   .pipeline/changes.md "Deploy notes"); until then both RPCs raise and the
--   cron 500s loudly (fail-closed).
--
--   The ledger is claim/confirm with expiry and PER-CHANNEL done flags:
--     * send_practice_reminders() claims each due pair (upsert claimed_at, bump
--       attempts) inside its own transaction — overlapping runs cannot
--       double-claim — and returns the existing sms_done / email_done so the
--       route re-sends ONLY the channel that has not yet succeeded (review
--       MED-1: a Resend-only outage must not re-send the SMS on retry).
--     * the route dispatches the still-needed channels, then calls
--       confirm_practice_reminder_sent() with the per-channel outcome.
--     * a pair not fully done within 90 minutes, and under 3 attempts, is
--       re-selected next run (review M3 — a transient outage is retried, not
--       lost). attempts >= 3 stops the loop (review B2-R2).
--     * LIMIT 100 per run so a backlog drains across runs instead of being
--       claimed-then-dropped when a single invocation times out (review MED-3);
--       the route dispatches sequentially and sets maxDuration accordingly.
--
-- NOTE: send_practice_reminders() creates an ON COMMIT DROP temp table, so it
-- must be called at most once per transaction (PostgREST gives each RPC its own
-- transaction, so the cron route is fine).
--
-- assert_cron_secret() compares the secret with plain `=` (not constant-time).
-- CRON_SECRET is high-entropy and the check is one round trip behind PostgREST,
-- so a practical timing attack is not a concern; noted for completeness.

-- ============ UP ============

-- Out-of-band secrets (never committed in a migration). RLS on + no policy +
-- REVOKE → unreachable except by the SECURITY DEFINER functions in this file.
CREATE TABLE IF NOT EXISTS public.app_secrets (
  key   text PRIMARY KEY,
  value text NOT NULL
);
ALTER TABLE public.app_secrets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.app_secrets FROM PUBLIC, anon, authenticated;

CREATE TABLE public.practice_reminder_sends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  sms_done boolean NOT NULL DEFAULT false,
  email_done boolean NOT NULL DEFAULT false,
  attempts int NOT NULL DEFAULT 1,
  UNIQUE (event_id, user_id)
);

-- Internal idempotency ledger: written only by the SECURITY DEFINER functions
-- below (which run as owner and bypass RLS). RLS on + no policy + REVOKE →
-- no direct access, same approach as audit_logs.
ALTER TABLE public.practice_reminder_sends ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.practice_reminder_sends FROM PUBLIC, anon, authenticated;

-- Raise FORBIDDEN unless the caller holds the cron secret. Inlined by both
-- RPCs below rather than exposed as its own grantable function.
CREATE OR REPLACE FUNCTION public.assert_cron_secret(p_cron_secret text)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
BEGIN
  IF p_cron_secret IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.app_secrets
    WHERE key = 'cron_secret' AND value = p_cron_secret
  ) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = 'P0001';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.assert_cron_secret(text) FROM PUBLIC;

-- public.send_practice_reminders(secret): claims up to 100 due (future event ×
-- confirmed member) pairs whose per-user lead time has been reached and that
-- are not fully sent / freshly claimed / exhausted, and returns the list the
-- cron route must dispatch (with the per-channel done flags). The claim (upsert)
-- happens in this function's own transaction so overlapping runs cannot
-- double-send.
CREATE OR REPLACE FUNCTION public.send_practice_reminders(p_cron_secret text)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  VOLATILE
  SET search_path = ''
AS $$
DECLARE
  v_result jsonb;
BEGIN
  PERFORM public.assert_cron_secret(p_cron_secret);

  -- Due pairs: event in the future, its service week live, the per-user lead
  -- time reached, an accepted invitation for that member, and no ledger row
  -- that is fully done for that member's enabled channels / claimed in the
  -- last 90 min / already tried 3×. DISTINCT ON collapses a member holding
  -- more than one accepted invitation for the same week.
  CREATE TEMPORARY TABLE due_practice_reminders ON COMMIT DROP AS
  SELECT * FROM (
    SELECT DISTINCT ON (e.id, inv.user_id)
      e.id                                            AS event_id,
      e.name                                          AS event_name,
      e.location                                      AS location,
      e.start_time                                    AS start_time,
      e.service_week_id                               AS service_week_id,
      inv.user_id                                     AS user_id,
      u.name                                          AS member_name,
      u.email                                         AS email,
      u.phone                                         AS phone,
      u.sms_opted_in                                  AS sms_opted_in,
      coalesce(np.reminder_hours_before, 24)          AS reminder_hours_before,
      coalesce(np.reminder_sms, true)                 AS reminder_sms,
      coalesce(np.reminder_email, false)              AS reminder_email,
      coalesce(prs.sms_done, false)                   AS sms_done,
      coalesce(prs.email_done, false)                 AS email_done
    FROM public.events e
    JOIN public.service_weeks sw ON sw.id = e.service_week_id
    JOIN public.invitations inv
      ON inv.service_week_id = e.service_week_id
     AND inv.status = 'accepted'
    JOIN public.users u ON u.id = inv.user_id
    LEFT JOIN public.notification_preferences np ON np.user_id = inv.user_id
    LEFT JOIN public.practice_reminder_sends prs
      ON prs.event_id = e.id AND prs.user_id = inv.user_id
    WHERE sw.is_cancelled = false
      AND e.start_time > now()
      AND now() >= e.start_time - (coalesce(np.reminder_hours_before, 24) || ' hours')::interval
      -- still has an enabled channel that has not succeeded
      AND (
        (coalesce(np.reminder_sms, true)    AND NOT coalesce(prs.sms_done, false))
        OR
        (coalesce(np.reminder_email, false) AND NOT coalesce(prs.email_done, false))
      )
      -- not freshly claimed by another run, and not exhausted
      AND (prs.claimed_at IS NULL OR prs.claimed_at <= now() - interval '90 minutes')
      AND coalesce(prs.attempts, 0) < 3
    ORDER BY e.id, inv.user_id
  ) sub
  ORDER BY start_time   -- soonest events first, so a backlog drains by urgency
  LIMIT 100;

  -- Claim them (this run owns each for the next 90 min). The DO UPDATE WHERE
  -- re-checks the freshness/attempt guard, so if a concurrent run claimed a
  -- pair between our SELECT and this INSERT, the update is skipped and the pair
  -- is NOT returned to this run — only genuinely new or stale-claimed pairs
  -- come back via RETURNING.
  WITH claimed AS (
    INSERT INTO public.practice_reminder_sends AS prs (event_id, user_id)
    SELECT event_id, user_id FROM due_practice_reminders
    ON CONFLICT (event_id, user_id) DO UPDATE
      SET claimed_at = now(),
          attempts   = prs.attempts + 1
      WHERE prs.claimed_at <= now() - interval '90 minutes'
        AND prs.attempts < 3
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
           'reminder_hours_before', d.reminder_hours_before,
           'reminder_sms', d.reminder_sms,
           'reminder_email', d.reminder_email,
           'sms_done', d.sms_done,
           'email_done', d.email_done
         )), '[]'::jsonb)
  INTO v_result
  FROM due_practice_reminders d
  JOIN claimed c ON c.event_id = d.event_id AND c.user_id = d.user_id;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.send_practice_reminders(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.send_practice_reminders(text) TO anon, authenticated;

-- public.confirm_practice_reminder_sent(secret, event, user, sms_done,
-- email_done): OR-merges the per-channel done flags for a claimed pair so a
-- succeeded channel is never re-sent. Called by the cron route after each
-- dispatch with p_*_done = "that channel did not hard-fail" (sent, skipped,
-- or not attempted). Returns true when the row's flags changed.
CREATE OR REPLACE FUNCTION public.confirm_practice_reminder_sent(
  p_cron_secret text,
  p_event_id    uuid,
  p_user_id     uuid,
  p_sms_done    boolean,
  p_email_done  boolean
)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  VOLATILE
  SET search_path = ''
AS $$
DECLARE
  v_count bigint;
BEGIN
  PERFORM public.assert_cron_secret(p_cron_secret);

  UPDATE public.practice_reminder_sends
  SET sms_done   = sms_done   OR coalesce(p_sms_done, false),
      email_done = email_done OR coalesce(p_email_done, false)
  WHERE event_id = p_event_id
    AND user_id = p_user_id
    AND (
      (coalesce(p_sms_done, false)   AND NOT sms_done)
      OR (coalesce(p_email_done, false) AND NOT email_done)
    );

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.confirm_practice_reminder_sent(text, uuid, uuid, boolean, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.confirm_practice_reminder_sent(text, uuid, uuid, boolean, boolean) TO anon, authenticated;

-- ============ DOWN ============
-- DROP FUNCTION IF EXISTS public.confirm_practice_reminder_sent(text, uuid, uuid, boolean, boolean);
-- DROP FUNCTION IF EXISTS public.send_practice_reminders(text);
-- DROP FUNCTION IF EXISTS public.assert_cron_secret(text);
-- DROP TABLE IF EXISTS public.practice_reminder_sends;
-- DROP TABLE IF EXISTS public.app_secrets;   -- only if no other consumer
