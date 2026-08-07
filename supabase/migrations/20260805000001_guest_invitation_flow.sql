-- Migration: guest invitation flow — Issue #72
--
-- Adds the guest (4th role) invitation path (PRD Flow 6 §21.6). invitations.
-- user_id is uuid NOT NULL REFERENCES users(id) (20260702000003) — there is
-- no "email-only, no user row" invitation shape — so a brand-new guest email
-- must get a placeholder `users` row at invite time before an invitations
-- row can point at it. `users` has no authenticated INSERT policy
-- (20260704000001_rls_policies.sql:76-77 — "provisioning is service-role /
-- webhook only"), so both provisioning and the later account-claim run as
-- SECURITY DEFINER RPCs, mirroring join_church_group
-- (20260706000002_church_group_join_rpc.sql) and remove_church_group_member
-- (20260710000001_member_removal_rpc.sql).
--
-- Also supersedes accept_invitation (20260712000001) with a guest-aware
-- variant: a guest never occupies a music-roster slot, and event_attendees
-- IS that slot (it drives member-view's team, the attendees endpoints, and
-- the ICS feeds) — so accepting as a guest must add zero event_attendees
-- rows.

-- ============ UP ============

-- public.provision_guest_user(p_email, p_name): admin/set_leader-only
-- creation of a placeholder `users` row for a brand-new guest invitee.
-- clerk_id is a synthetic 'pending_guest_<32 hex>' placeholder (46 chars,
-- inside clerk_id varchar(50)) swapped for the real Clerk sub at claim time
-- by claim_guest_invitation. Uses md5(random()||clock_timestamp()) rather
-- than gen_random_uuid(): with search_path = '', pgcrypto's gen_random_uuid
-- would need a schema qualifier that differs between local and
-- Supabase-hosted installs, whereas md5/random/clock_timestamp are
-- pg_catalog builtins available unqualified either way.
CREATE OR REPLACE FUNCTION public.provision_guest_user(
  p_email text,
  p_name  text
)
  RETURNS public.users
  LANGUAGE plpgsql
  SECURITY DEFINER
  VOLATILE
  SET search_path = ''
AS $$
DECLARE
  v_clerk_id     text;
  v_caller_group uuid;
  v_caller_role  public.user_role;
  v_user         public.users%ROWTYPE;
BEGIN
  -- 1. auth
  v_clerk_id := auth.jwt() ->> 'sub';
  IF v_clerk_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  SELECT church_group_id, role INTO v_caller_group, v_caller_role
  FROM public.users
  WHERE clerk_id = v_clerk_id;

  IF v_caller_group IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  -- 2. admin/set_leader only. SECURITY DEFINER bypasses RLS, so this
  -- app-level check is the real enforcement point for this function, not
  -- defense in depth.
  IF v_caller_role NOT IN ('admin', 'set_leader') THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = 'P0001';
  END IF;

  -- 3. users.email is UNIQUE globally (not per group) — check across every
  -- group, not just the caller's, so the INSERT below never hits the
  -- constraint blind.
  IF EXISTS (SELECT 1 FROM public.users WHERE lower(email) = lower(p_email)) THEN
    RAISE EXCEPTION 'EMAIL_TAKEN' USING ERRCODE = 'P0001';
  END IF;

  -- 4. provision the placeholder guest.
  INSERT INTO public.users (clerk_id, church_group_id, role, name, email)
  VALUES (
    'pending_guest_' || md5(random()::text || clock_timestamp()::text),
    v_caller_group,
    'guest',
    left(p_name, 100),
    lower(p_email)
  )
  RETURNING * INTO v_user;

  RETURN v_user;
END;
$$;

GRANT EXECUTE ON FUNCTION public.provision_guest_user(text, text) TO authenticated;

-- public.claim_guest_invitation(p_response_token, p_name): a signed-in Clerk
-- user claims the placeholder `users` row created by provision_guest_user,
-- swapping its synthetic clerk_id for their real one. Modeled on
-- join_church_group for shape and on accept_invitation for the direct
-- audit_logs insert (both SECURITY DEFINER, both bypass RLS on tables the
-- claimer cannot otherwise write).
CREATE OR REPLACE FUNCTION public.claim_guest_invitation(
  p_response_token text,
  p_name           text
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  VOLATILE
  SET search_path = ''
AS $$
DECLARE
  v_clerk_id text;
  v_inv      public.invitations%ROWTYPE;
  v_guest    public.users%ROWTYPE;
BEGIN
  -- 1. auth
  v_clerk_id := auth.jwt() ->> 'sub';
  IF v_clerk_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  -- 2. resolve the invitation by token.
  SELECT * INTO v_inv FROM public.invitations WHERE response_token = p_response_token;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  -- 3. lock the placeholder guest row.
  SELECT * INTO v_guest FROM public.users WHERE id = v_inv.user_id FOR UPDATE;

  -- 4. idempotent re-claim: same Clerk user hitting the link twice (e.g.
  -- double-tap, browser back) returns the same result with no mutation and
  -- no second audit row.
  IF v_guest.clerk_id = v_clerk_id THEN
    RETURN jsonb_build_object(
      'user_id', v_guest.id,
      'church_group_id', v_guest.church_group_id,
      'invitation_id', v_inv.id,
      'service_week_id', v_inv.service_week_id,
      'already_claimed', true
    );
  END IF;

  -- 5. anonymized (removed) placeholder — treat as not found rather than
  -- leaking that it ever existed.
  IF v_guest.anonymized_at IS NOT NULL THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  -- 6. the invitation must still point at an unclaimed placeholder — a real
  -- account (existing-user invite path, or already claimed by someone else)
  -- cannot be claimed again.
  IF NOT starts_with(v_guest.clerk_id, 'pending_guest_') OR v_guest.role <> 'guest' THEN
    RAISE EXCEPTION 'ALREADY_CLAIMED' USING ERRCODE = 'P0001';
  END IF;

  -- 7. only a live invitation grants a claim — a withdrawn/denied/expired
  -- invitation must not seed a new account into the group.
  IF v_inv.status NOT IN ('pending', 'accepted') THEN
    RAISE EXCEPTION 'NOT_CLAIMABLE' USING ERRCODE = 'P0001';
  END IF;

  -- 8. the signed-in Clerk user must not already have an identity —
  -- accounts are never merged.
  IF EXISTS (SELECT 1 FROM public.users WHERE clerk_id = v_clerk_id) THEN
    RAISE EXCEPTION 'USER_ALREADY_IN_GROUP' USING ERRCODE = 'P0001';
  END IF;

  -- 9. claim it. Never touch email — the invited address is the identity
  -- we vetted at invite time, and overwriting it can trip the global unique
  -- index.
  UPDATE public.users
  SET clerk_id = v_clerk_id,
      name = COALESCE(NULLIF(left(p_name, 100), ''), name),
      updated_at = now()
  WHERE id = v_guest.id;

  -- 10. audit (insert directly — this is the no-JWT-derived-identity-safe
  -- equivalent of write_audit_log, which cannot be used here because the
  -- acting identity only becomes real inside this same statement).
  INSERT INTO public.audit_logs (church_group_id, user_id, action, entity_type, entity_id, metadata)
  VALUES (
    v_guest.church_group_id,
    v_guest.id,
    'invitation.guest_claimed',
    'invitation',
    v_inv.id,
    jsonb_build_object('user_id', v_guest.id)
  );

  RETURN jsonb_build_object(
    'user_id', v_guest.id,
    'church_group_id', v_guest.church_group_id,
    'invitation_id', v_inv.id,
    'service_week_id', v_inv.service_week_id,
    'already_claimed', false
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.claim_guest_invitation(text, text) TO authenticated;

-- public.accept_invitation(...): supersedes the version in
-- 20260712000001_accept_invitation_rpc.sql. Identical in every respect
-- except: a guest invitee (users.role = 'guest') never gets event_attendees
-- rows inserted, because event_attendees IS the music-roster slot (PRD
-- §10.1 / Flow 6 5a) and a guest must never occupy one — attendees_added is
-- reported as 0 for that branch instead. Status flip, admin notification,
-- and the audit_logs row are all unchanged.
CREATE OR REPLACE FUNCTION public.accept_invitation(
  p_invitation_id   uuid,
  p_response_token  text
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  VOLATILE
  SET search_path = ''
AS $$
DECLARE
  v_inv              public.invitations%ROWTYPE;
  v_clerk_id         text;
  v_caller_id        uuid;
  v_via              text;
  v_attendees_added  int;
  v_member_name      text;
  v_invitee_role     public.user_role;
  v_recipient        record;
BEGIN
  SELECT * INTO v_inv FROM public.invitations WHERE id = p_invitation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  -- Authorize.
  IF p_response_token IS NOT NULL THEN
    IF p_response_token <> v_inv.response_token THEN
      RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = 'P0001';
    END IF;
    v_via := 'token';
  ELSE
    v_clerk_id := auth.jwt() ->> 'sub';
    IF v_clerk_id IS NULL THEN
      RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = 'P0001';
    END IF;

    SELECT id INTO v_caller_id FROM public.users WHERE clerk_id = v_clerk_id;
    IF v_caller_id IS NULL OR v_caller_id <> v_inv.user_id THEN
      RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = 'P0001';
    END IF;
    v_via := 'session';
  END IF;

  -- Already responded (graceful, not an error): covers accepted/denied/withdrawn.
  IF v_inv.status <> 'pending' THEN
    RETURN jsonb_build_object(
      'status', v_inv.status,
      'already_responded', true,
      'attendees_added', 0
    );
  END IF;

  -- Expiry (checked after the already-responded check, so a previously
  -- accepted-but-now-past invite still returns 200 accepted above).
  IF v_inv.response_deadline IS NOT NULL AND now() > v_inv.response_deadline THEN
    RAISE EXCEPTION 'EXPIRED' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.invitations
  SET status = 'accepted', responded_at = now()
  WHERE id = p_invitation_id;

  -- #72: a guest never occupies a music-roster slot (PRD §10.1 / Flow 6 5a),
  -- and event_attendees IS that slot — skip the insert for guests.
  SELECT role INTO v_invitee_role FROM public.users WHERE id = v_inv.user_id;
  IF v_invitee_role = 'guest' THEN
    v_attendees_added := 0;
  ELSE
    -- event_attendees for every event of the week (idempotent; no-op when
    -- the week has no events yet — queued for #59/#60).
    INSERT INTO public.event_attendees (event_id, user_id)
    SELECT e.id, v_inv.user_id FROM public.events e
    WHERE e.service_week_id = v_inv.service_week_id
    ON CONFLICT (event_id, user_id) DO NOTHING;
    GET DIAGNOSTICS v_attendees_added = ROW_COUNT;
  END IF;

  -- Notify admin in-app: the inviting user if known, else every admin/
  -- set_leader in the group.
  SELECT name INTO v_member_name FROM public.users WHERE id = v_inv.user_id;

  IF v_inv.invited_by IS NOT NULL THEN
    INSERT INTO public.notifications
      (church_group_id, user_id, type, title, body, link_entity_type, link_entity_id)
    VALUES
      (v_inv.church_group_id, v_inv.invited_by, 'invitation_accepted', 'Invitation accepted',
       v_member_name || ' accepted their set invitation', 'invitation', v_inv.id);
  ELSE
    FOR v_recipient IN
      SELECT id FROM public.users
      WHERE church_group_id = v_inv.church_group_id
        AND role IN ('admin', 'set_leader')
    LOOP
      INSERT INTO public.notifications
        (church_group_id, user_id, type, title, body, link_entity_type, link_entity_id)
      VALUES
        (v_inv.church_group_id, v_recipient.id, 'invitation_accepted', 'Invitation accepted',
         v_member_name || ' accepted their set invitation', 'invitation', v_inv.id);
    END LOOP;
  END IF;

  -- Audit log (insert directly — this is the no-session-safe equivalent of
  -- write_audit_log, which cannot be used here because it derives identity
  -- from the JWT).
  INSERT INTO public.audit_logs (church_group_id, user_id, action, entity_type, entity_id, metadata)
  VALUES (v_inv.church_group_id, v_inv.user_id, 'invitation.accepted', 'invitation', v_inv.id,
    jsonb_build_object(
      'time_to_respond_seconds', floor(extract(epoch FROM (now() - v_inv.created_at)))::int,
      'via', v_via));

  -- TODO(#62): Google Calendar sync on accept.

  RETURN jsonb_build_object(
    'status', 'accepted',
    'already_responded', false,
    'attendees_added', v_attendees_added
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.accept_invitation(uuid, text) TO anon, authenticated;

-- ============ DOWN ============
-- DROP FUNCTION IF EXISTS public.claim_guest_invitation(text, text);
-- DROP FUNCTION IF EXISTS public.provision_guest_user(text, text);
-- Re-running 20260712000001_accept_invitation_rpc.sql's CREATE OR REPLACE
-- restores the pre-#72 accept_invitation body.
