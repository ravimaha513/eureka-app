-- Admin and team writes (docs/admin-api.md AD-1..AD-9, design B4.8 N1, N5, N12).
-- The API role gets no write privilege on org tables. Every admin write goes
-- through a SECURITY DEFINER function owned by authz_definer that re-checks,
-- inside the database, the permission (access:manage or team:move_member with
-- scope), the self-change rule and the second-approver rule. authz_definer
-- gets column-level privileges for exactly the columns these functions write.
-- Errors are raised with the contract's error code as the message, so the API
-- can map them to problem details.

-- ---------- restricted roles (AD-3), seeded from the catalog ----------
-- Defaults to true (fail closed) until the migration runner seeds it from
-- isRestrictedRole() in packages/shared.
SET ROLE eureka_owner;
ALTER TABLE eureka.role ADD COLUMN is_restricted boolean NOT NULL DEFAULT true;

-- ---------- role requests (AD-3, AD-7) ----------
CREATE TABLE eureka.role_request (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES eureka.app_user(id),
  role_key     text NOT NULL REFERENCES eureka.role(key),
  location_id  uuid REFERENCES eureka.location(id),
  requested_by uuid NOT NULL REFERENCES eureka.app_user(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL DEFAULT now() + interval '7 days',
  -- applied: a non-restricted role granted immediately (kept for the record).
  status       text NOT NULL DEFAULT 'pending'
               CHECK (status IN ('applied','pending','approved','rejected','expired')),
  decided_by   uuid REFERENCES eureka.app_user(id),
  decided_at   timestamptz,
  CHECK (requested_by <> user_id),
  CHECK (status <> 'approved' OR (decided_by IS NOT NULL AND decided_by <> user_id AND decided_by <> requested_by)),
  CHECK ((status IN ('pending','expired')) = (decided_at IS NULL))
);
CREATE INDEX role_request_status ON eureka.role_request (status, requested_at);
CREATE UNIQUE INDEX role_request_one_pending ON eureka.role_request (user_id, role_key, location_id)
  NULLS NOT DISTINCT WHERE status = 'pending';

-- The candidate column guard lets definer functions change recruiter_id (OD-07
-- move, lead change). Those functions check team:move_member or access:manage
-- themselves; team_id stays guarded for everyone. Otherwise unchanged from 0006.
CREATE OR REPLACE FUNCTION eureka.candidate_column_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  is_definer boolean := current_user = 'authz_definer';
  owns_old   boolean;
BEGIN
  -- Never changeable through the API.
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.person_id IS DISTINCT FROM OLD.person_id
     OR NEW.location_id IS DISTINCT FROM OLD.location_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'column is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Status columns change only through authz.transition_candidate (N2).
  IF (NEW.marketing_status IS DISTINCT FROM OLD.marketing_status
      OR NEW.bench_since IS DISTINCT FROM OLD.bench_since) AND NOT is_definer THEN
    RAISE EXCEPTION 'status changes must use a transition' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF (NEW.technology_id, NEW.gh_location_id, NEW.priority, NEW.marketing_email, NEW.vitel_number,
      NEW.marketing_start_date, NEW.in_person_ok)
     IS DISTINCT FROM
     (OLD.technology_id, OLD.gh_location_id, OLD.priority, OLD.marketing_email, OLD.vitel_number,
      OLD.marketing_start_date, OLD.in_person_ok)
     AND NOT authz.owns('candidate:update', OLD.recruiter_id, OLD.team_id, OLD.location_id) THEN
    RAISE EXCEPTION 'not permitted to update profile fields' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.technical_rating IS DISTINCT FROM OLD.technical_rating
     AND NOT authz.owns('candidate.rating:update', OLD.recruiter_id, OLD.team_id, OLD.location_id) THEN
    RAISE EXCEPTION 'not permitted to update technical rating' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.visibility IS DISTINCT FROM OLD.visibility
     AND NOT authz.owns('candidate.visibility:update', OLD.recruiter_id, OLD.team_id, OLD.location_id) THEN
    RAISE EXCEPTION 'not permitted to change visibility' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.team_id IS DISTINCT FROM OLD.team_id
     OR (NEW.recruiter_id IS DISTINCT FROM OLD.recruiter_id AND NOT is_definer) THEN
    owns_old := authz.owns('candidate:assign', OLD.recruiter_id, OLD.team_id, OLD.location_id);
    IF NOT owns_old
       OR NOT (authz.has_org('candidate:assign') OR NEW.team_id = ANY (authz.team_ids('candidate:assign'))) THEN
      RAISE EXCEPTION 'not permitted to reassign candidate' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  NEW.updated_at := now();
  NEW.row_version := OLD.row_version + 1;
  RETURN NEW;
END $$;
RESET ROLE;

-- role_request: readable by access:manage holders only; written only by definer functions.
ALTER TABLE eureka.role_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE eureka.role_request FORCE ROW LEVEL SECURITY;
CREATE POLICY role_request_admin_read ON eureka.role_request FOR SELECT TO eureka_app
  USING ((SELECT authz.has_org('access:manage')));
CREATE POLICY definer_read ON eureka.role_request FOR SELECT TO authz_definer USING (true);
CREATE POLICY definer_insert ON eureka.role_request FOR INSERT TO authz_definer WITH CHECK (true);
CREATE POLICY definer_update ON eureka.role_request FOR UPDATE TO authz_definer USING (true) WITH CHECK (true);
GRANT SELECT ON eureka.role_request TO eureka_app;
GRANT SELECT, INSERT ON eureka.role_request TO authz_definer;
GRANT UPDATE (status, decided_by, decided_at) ON eureka.role_request TO authz_definer;

-- ---------- column privileges for the definer functions below ----------
GRANT INSERT (email, display_name, designation, primary_location_id) ON eureka.app_user TO authz_definer;
GRANT UPDATE (status, access_version) ON eureka.app_user TO authz_definer;
GRANT INSERT (user_id, role_key, location_id, created_by, approved_by) ON eureka.user_role TO authz_definer;
GRANT UPDATE (valid) ON eureka.user_role TO authz_definer;
GRANT INSERT (name, lead_id, location_id) ON eureka.team TO authz_definer;
GRANT UPDATE (lead_id) ON eureka.team TO authz_definer;
GRANT INSERT (team_id, user_id) ON eureka.team_member TO authz_definer;
GRANT UPDATE (valid) ON eureka.team_member TO authz_definer;
GRANT INSERT (user_id, manager_id) ON eureka.reporting_line TO authz_definer;
GRANT UPDATE (valid) ON eureka.reporting_line TO authz_definer;
GRANT UPDATE (valid) ON eureka.coach_assignment TO authz_definer;
GRANT SELECT (user_id, revoked_at) ON eureka.session TO authz_definer;
GRANT UPDATE (revoked_at) ON eureka.session TO authz_definer;
GRANT UPDATE (recruiter_id) ON eureka.candidate TO authz_definer;

SET ROLE authz_definer;

-- Ends a validity range at now(); a range that starts later becomes empty.
CREATE FUNCTION authz.ended(r tstzrange) RETURNS tstzrange
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE WHEN pg_catalog.lower_inf(r) OR pg_catalog.lower(r) <= pg_catalog.now()
              THEN pg_catalog.tstzrange(pg_catalog.lower(r), pg_catalog.now())
              ELSE 'empty'::pg_catalog.tstzrange END
$$;

-- Caller must hold access:manage (org) and must not be the target (AD-1, AD-2).
-- Internal: not executable by the API role; called by the functions below.
CREATE FUNCTION authz.admin_guard(p_target uuid) RETURNS uuid
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE actor uuid := authz.current_user_id();
BEGIN
  IF actor IS NULL OR NOT authz.has_org('access:manage') THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_target IS NOT NULL AND p_target = actor THEN
    RAISE EXCEPTION 'self_change' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN actor;
END $$;

-- Target user must exist; returns its status.
CREATE FUNCTION authz.admin_user_status(p_user uuid) RETURNS text
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE s text;
BEGIN
  SELECT u.status INTO s FROM eureka.app_user u WHERE u.id = p_user;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'user_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  RETURN s;
END $$;

-- ---------- users ----------
CREATE FUNCTION authz.admin_create_user(p_email text, p_display_name text, p_designation text, p_location uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE new_id uuid;
BEGIN
  PERFORM authz.admin_guard(NULL);
  INSERT INTO eureka.app_user (email, display_name, designation, primary_location_id)
  VALUES (p_email, p_display_name, p_designation, p_location)
  RETURNING id INTO new_id;
  RETURN new_id;
END $$;

-- AD-5: deactivation ends open role, team and coach rows, revokes every
-- session and bumps access_version. Reactivation restores the status only.
CREATE FUNCTION authz.admin_set_user_status(p_user uuid, p_active boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM authz.admin_guard(p_user);
  PERFORM 1 FROM eureka.app_user u WHERE u.id = p_user FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'user_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF p_active THEN
    UPDATE eureka.app_user SET status = 'active', access_version = access_version + 1 WHERE id = p_user;
    RETURN;
  END IF;
  UPDATE eureka.app_user SET status = 'inactive', access_version = access_version + 1 WHERE id = p_user;
  UPDATE eureka.user_role SET valid = authz.ended(valid)
    WHERE user_id = p_user AND (pg_catalog.upper_inf(valid) OR pg_catalog.upper(valid) > pg_catalog.now());
  UPDATE eureka.team_member SET valid = authz.ended(valid)
    WHERE user_id = p_user AND (pg_catalog.upper_inf(valid) OR pg_catalog.upper(valid) > pg_catalog.now());
  UPDATE eureka.coach_assignment SET valid = authz.ended(valid)
    WHERE coach_id = p_user AND (pg_catalog.upper_inf(valid) OR pg_catalog.upper(valid) > pg_catalog.now());
  UPDATE eureka.session SET revoked_at = pg_catalog.now() WHERE user_id = p_user AND revoked_at IS NULL;
END $$;

-- AD-2, AD-9: reporting line; the closure trigger rebuilds and rejects cycles.
-- An admin cannot put anyone under themselves either (that would widen their
-- own hierarchy scope).
CREATE FUNCTION authz.admin_set_manager(p_user uuid, p_manager uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE actor uuid;
BEGIN
  actor := authz.admin_guard(p_user);
  IF p_manager IS NOT NULL AND p_manager = actor THEN
    RAISE EXCEPTION 'self_change' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM authz.admin_user_status(p_user);
  IF p_manager IS NOT NULL THEN
    IF p_manager = p_user THEN
      RAISE EXCEPTION 'cycle' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM eureka.app_user u WHERE u.id = p_manager AND u.status = 'active') THEN
      RAISE EXCEPTION 'invalid_manager' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  UPDATE eureka.reporting_line SET valid = authz.ended(valid)
    WHERE user_id = p_user AND (pg_catalog.upper_inf(valid) OR pg_catalog.upper(valid) > pg_catalog.now());
  IF p_manager IS NOT NULL THEN
    BEGIN
      INSERT INTO eureka.reporting_line (user_id, manager_id) VALUES (p_user, p_manager);
    EXCEPTION WHEN check_violation THEN
      RAISE EXCEPTION 'cycle' USING ERRCODE = 'check_violation';
    END;
  END IF;
END $$;

-- ---------- roles ----------
-- AD-3, AD-6: a restricted role becomes a pending request; any other role is
-- granted immediately. Returns the request id and 'applied' or 'pending_approval'.
CREATE FUNCTION authz.request_role(p_user uuid, p_role text, p_location uuid)
RETURNS TABLE (request_id uuid, request_status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE actor uuid; r record; req uuid;
BEGIN
  actor := authz.admin_guard(p_user);
  PERFORM authz.admin_user_status(p_user);
  SELECT ro.is_location_bound, ro.is_restricted INTO r FROM eureka.role ro WHERE ro.key = p_role;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown_role' USING ERRCODE = 'check_violation';
  END IF;
  IF r.is_location_bound AND p_location IS NULL THEN
    RAISE EXCEPTION 'location_required' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT r.is_location_bound AND p_location IS NOT NULL THEN
    RAISE EXCEPTION 'location_not_allowed' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM eureka.user_role ur WHERE ur.user_id = p_user AND ur.role_key = p_role
             AND ur.location_id IS NOT DISTINCT FROM p_location AND ur.valid @> pg_catalog.now()) THEN
    RAISE EXCEPTION 'role_already_held' USING ERRCODE = 'unique_violation';
  END IF;

  UPDATE eureka.role_request q SET status = 'expired'
    WHERE q.user_id = p_user AND q.role_key = p_role AND q.location_id IS NOT DISTINCT FROM p_location
      AND q.status = 'pending' AND q.expires_at <= pg_catalog.now();

  IF r.is_restricted THEN
    IF EXISTS (SELECT 1 FROM eureka.role_request q WHERE q.user_id = p_user AND q.role_key = p_role
               AND q.location_id IS NOT DISTINCT FROM p_location AND q.status = 'pending') THEN
      RAISE EXCEPTION 'request_pending' USING ERRCODE = 'unique_violation';
    END IF;
    INSERT INTO eureka.role_request (user_id, role_key, location_id, requested_by, status)
    VALUES (p_user, p_role, p_location, actor, 'pending')
    RETURNING id INTO req;
    RETURN QUERY SELECT req, 'pending_approval'::text;
  ELSE
    INSERT INTO eureka.user_role (user_id, role_key, location_id, created_by)
    VALUES (p_user, p_role, p_location, actor);
    INSERT INTO eureka.role_request (user_id, role_key, location_id, requested_by, status, decided_at)
    VALUES (p_user, p_role, p_location, actor, 'applied', pg_catalog.now())
    RETURNING id INTO req;
    RETURN QUERY SELECT req, 'applied'::text;
  END IF;
END $$;

-- AD-3: the approver holds access:manage and is neither the grantee nor the requester.
CREATE FUNCTION authz.approve_role_request(p_id uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE actor uuid; q record;
BEGIN
  actor := authz.admin_guard(NULL);
  SELECT rq.* INTO q FROM eureka.role_request rq WHERE rq.id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'request_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF q.status <> 'pending' THEN
    RAISE EXCEPTION 'request_not_pending' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF q.expires_at <= pg_catalog.now() THEN
    RAISE EXCEPTION 'request_expired' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF actor = q.user_id OR actor = q.requested_by THEN
    RAISE EXCEPTION 'second_approver_required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF EXISTS (SELECT 1 FROM eureka.user_role ur WHERE ur.user_id = q.user_id AND ur.role_key = q.role_key
             AND ur.location_id IS NOT DISTINCT FROM q.location_id AND ur.valid @> pg_catalog.now()) THEN
    RAISE EXCEPTION 'role_already_held' USING ERRCODE = 'unique_violation';
  END IF;
  INSERT INTO eureka.user_role (user_id, role_key, location_id, created_by, approved_by)
  VALUES (q.user_id, q.role_key, q.location_id, q.requested_by, actor);
  UPDATE eureka.role_request SET status = 'approved', decided_by = actor, decided_at = pg_catalog.now()
    WHERE id = p_id;
  RETURN 'approved';
END $$;

-- Rejection removes nothing, so the requester may withdraw; the grantee may not decide.
CREATE FUNCTION authz.reject_role_request(p_id uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE actor uuid; q record;
BEGIN
  actor := authz.admin_guard(NULL);
  SELECT rq.* INTO q FROM eureka.role_request rq WHERE rq.id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'request_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF q.status <> 'pending' THEN
    RAISE EXCEPTION 'request_not_pending' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF q.expires_at <= pg_catalog.now() THEN
    RAISE EXCEPTION 'request_expired' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF actor = q.user_id THEN
    RAISE EXCEPTION 'self_change' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE eureka.role_request SET status = 'rejected', decided_by = actor, decided_at = pg_catalog.now()
    WHERE id = p_id;
  RETURN 'rejected';
END $$;

-- AD-4: revocation is immediate. A NULL location revokes the role at every location.
CREATE FUNCTION authz.revoke_role(p_user uuid, p_role text, p_location uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE n integer;
BEGIN
  PERFORM authz.admin_guard(p_user);
  UPDATE eureka.user_role SET valid = authz.ended(valid)
    WHERE user_id = p_user AND role_key = p_role
      AND (p_location IS NULL OR location_id = p_location)
      AND (pg_catalog.upper_inf(valid) OR pg_catalog.upper(valid) > pg_catalog.now());
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN
    RAISE EXCEPTION 'role_not_held' USING ERRCODE = 'no_data_found';
  END IF;
  RETURN n;
END $$;

-- ---------- teams (AD-9) ----------
CREATE FUNCTION authz.admin_create_team(p_name text, p_lead uuid, p_location uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE new_id uuid;
BEGIN
  PERFORM authz.admin_guard(p_lead);
  IF NOT EXISTS (SELECT 1 FROM eureka.app_user u WHERE u.id = p_lead AND u.status = 'active') THEN
    RAISE EXCEPTION 'invalid_lead' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO eureka.team (name, lead_id, location_id) VALUES (p_name, p_lead, p_location)
  RETURNING id INTO new_id;
  RETURN new_id;
END $$;

-- Candidates the old lead recruited in this team go to the new lead, so the
-- recruiter/team invariant (N5) keeps holding.
CREATE FUNCTION authz.admin_set_team_lead(p_team uuid, p_lead uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE old_lead uuid;
BEGIN
  PERFORM authz.admin_guard(p_lead);
  SELECT t.lead_id INTO old_lead FROM eureka.team t WHERE t.id = p_team FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'team_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM eureka.app_user u WHERE u.id = p_lead AND u.status = 'active') THEN
    RAISE EXCEPTION 'invalid_lead' USING ERRCODE = 'check_violation';
  END IF;
  IF old_lead = p_lead THEN
    RETURN;
  END IF;
  UPDATE eureka.team SET lead_id = p_lead WHERE id = p_team;
  UPDATE eureka.candidate c SET recruiter_id = p_lead
    WHERE c.team_id = p_team AND c.recruiter_id = old_lead
      AND NOT EXISTS (SELECT 1 FROM eureka.team_member tm WHERE tm.team_id = p_team
                      AND tm.user_id = old_lead AND tm.valid @> pg_catalog.now());
END $$;

CREATE FUNCTION authz.admin_add_team_member(p_team uuid, p_user uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM authz.admin_guard(p_user);
  PERFORM 1 FROM eureka.team t WHERE t.id = p_team;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'team_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF authz.admin_user_status(p_user) <> 'active' THEN
    RAISE EXCEPTION 'user_inactive' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM eureka.team_member tm WHERE tm.user_id = p_user AND tm.valid @> pg_catalog.now()) THEN
    RAISE EXCEPTION 'already_member' USING ERRCODE = 'unique_violation';
  END IF;
  INSERT INTO eureka.team_member (team_id, user_id) VALUES (p_team, p_user);
END $$;

-- OD-07 / AD-8: move a member between teams in one transaction. Needs
-- team:move_member covering both teams. The mover's candidates stay with the
-- old team and go to p_reassign_to (an active member or the lead of the old
-- team), defaulting to the old team's lead.
CREATE FUNCTION authz.move_team_member(p_user uuid, p_from_team uuid, p_to_team uuid, p_reassign_to uuid)
RETURNS TABLE (moved_candidates integer, reassigned_to uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE actor uuid := authz.current_user_id(); from_lead uuid; target uuid; n integer;
BEGIN
  IF actor IS NULL OR NOT authz.has_perm('team:move_member') THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_user = actor THEN
    RAISE EXCEPTION 'self_change' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT (authz.has_org('team:move_member')
          OR (p_from_team = ANY (authz.team_ids('team:move_member'))
              AND p_to_team = ANY (authz.team_ids('team:move_member')))) THEN
    RAISE EXCEPTION 'not_in_scope' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT t.lead_id INTO from_lead FROM eureka.team t WHERE t.id = p_from_team;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM eureka.team t WHERE t.id = p_to_team) THEN
    RAISE EXCEPTION 'team_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF p_from_team = p_to_team THEN
    RAISE EXCEPTION 'same_team' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM 1 FROM eureka.team_member tm
    WHERE tm.user_id = p_user AND tm.team_id = p_from_team AND tm.valid @> pg_catalog.now() FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_a_member' USING ERRCODE = 'check_violation';
  END IF;

  target := coalesce(p_reassign_to, from_lead);
  IF target = p_user
     OR NOT EXISTS (SELECT 1 FROM eureka.app_user u WHERE u.id = target AND u.status = 'active')
     OR NOT (target = from_lead OR EXISTS (
          SELECT 1 FROM eureka.team_member tm
          WHERE tm.team_id = p_from_team AND tm.user_id = target AND tm.valid @> pg_catalog.now())) THEN
    RAISE EXCEPTION 'invalid_reassign_target' USING ERRCODE = 'check_violation';
  END IF;

  UPDATE eureka.candidate c SET recruiter_id = target
    WHERE c.team_id = p_from_team AND c.recruiter_id = p_user;
  GET DIAGNOSTICS n = ROW_COUNT;
  UPDATE eureka.team_member SET valid = authz.ended(valid)
    WHERE user_id = p_user AND team_id = p_from_team AND valid @> pg_catalog.now();
  INSERT INTO eureka.team_member (team_id, user_id) VALUES (p_to_team, p_user);
  RETURN QUERY SELECT n, target;
END $$;

RESET ROLE;

-- Internal helpers: no one but their owner (authz_definer) may execute them.
REVOKE ALL ON FUNCTION authz.ended(tstzrange) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.admin_guard(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.admin_user_status(uuid) FROM PUBLIC;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'authz.admin_create_user(text, text, text, uuid)',
    'authz.admin_set_user_status(uuid, boolean)',
    'authz.admin_set_manager(uuid, uuid)',
    'authz.request_role(uuid, text, uuid)',
    'authz.approve_role_request(uuid)',
    'authz.reject_role_request(uuid)',
    'authz.revoke_role(uuid, text, uuid)',
    'authz.admin_create_team(text, uuid, uuid)',
    'authz.admin_set_team_lead(uuid, uuid)',
    'authz.admin_add_team_member(uuid, uuid)',
    'authz.move_team_member(uuid, uuid, uuid, uuid)']
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO eureka_app', f);
  END LOOP;
END $$;
