-- Interview Lead: schedules interviews and sees every coach's calendar (owner request).
--   1. Coach calendar (docs/coach-calendar-api.md): an active holder of the system role
--      `interview_lead` sees every coach at full detail, like the CEO, without a grant. Fixed, like the
--      coach's own column; it does not let them manage grants (still the CEO alone). Checked on the role
--      key, as for `ceo` and `interview_coach` in 0540. CC-6 (Google events) follows coach_calendar_visible.
--   2. Scheduling (docs/interviews-settings-api.md IS-16): interview creation stays authorized against
--      the parent submission (design B4.8): submission:update over it, as before, OR a coached
--      interview:create grant covering the submission's team (authz.coached_team_ids, 0220; for the Lead
--      that is coached_hierarchy: teams coached by them or anyone below them). Only coached scopes count,
--      so no other role's reach changes. InitPlan, rule 3. The two definer functions create runs after the
--      insert, authz.set_interview_panel (0080) and authz.assert_interview_staff_free (0508), accept the
--      same coached path on the interview's team snapshot; bodies otherwise unchanged. The Lead holds no
--      interview:update, so the API does not let them edit an interview afterwards.
-- No new columns, events or audit fields (rule 5). Expressions are NULL-safe (rule 1).

SET ROLE eureka_owner;
ALTER POLICY interview_insert ON eureka.interview WITH CHECK (
  (SELECT authz.has_perm('interview:create'))
  AND EXISTS (SELECT 1 FROM eureka.submission s WHERE s.id = submission_id
              AND (authz.owns('submission:update', s.recruiter_id, s.team_id, s.location_id)
                   OR s.team_id = ANY ((SELECT authz.coached_team_ids('interview:create'))::uuid[])))
);
RESET ROLE;

SET ROLE authz_definer;
CREATE FUNCTION authz.is_interview_lead() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM eureka.user_role ur JOIN eureka.app_user u ON u.id = ur.user_id
     WHERE ur.user_id = authz.current_user_id() AND ur.role_key = 'interview_lead'
       AND ur.valid @> pg_catalog.now() AND u.status = 'active')
$$;
REVOKE ALL ON FUNCTION authz.is_interview_lead() FROM PUBLIC;

CREATE OR REPLACE FUNCTION authz.coach_calendar_visible()
RETURNS TABLE (coach_id uuid, coach_name text, detail text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH me AS (
    SELECT authz.current_user_id() AS id,
           coalesce(authz.is_ceo(), false) OR coalesce(authz.is_interview_lead(), false) AS sees_all
  ), mine AS (
    SELECT * FROM authz.coach_calendar_my_grants()
  ), coaches AS (
    SELECT DISTINCT u.id, u.display_name
      FROM eureka.app_user u JOIN eureka.user_role ur ON ur.user_id = u.id
     WHERE u.status = 'active' AND ur.role_key = 'interview_coach' AND ur.valid @> pg_catalog.now()
  )
  SELECT c.id, c.display_name::text,
         CASE WHEN me.sees_all OR c.id = me.id
                OR EXISTS (SELECT 1 FROM mine m WHERE m.detail = 'full' AND (m.all_coaches OR c.id = ANY (m.coach_ids)))
              THEN 'full' ELSE 'busy' END
    FROM coaches c, me
   WHERE me.id IS NOT NULL
     AND (me.sees_all OR c.id = me.id
          OR EXISTS (SELECT 1 FROM mine m WHERE m.all_coaches OR c.id = ANY (m.coach_ids)))
$$;

CREATE OR REPLACE FUNCTION authz.coach_calendar_can_view() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT authz.current_user_id() IS NOT NULL AND (
    coalesce(authz.is_ceo(), false)
    OR coalesce(authz.is_interview_lead(), false)
    OR EXISTS (SELECT 1 FROM eureka.user_role ur
                WHERE ur.user_id = authz.current_user_id() AND ur.role_key = 'interview_coach' AND ur.valid @> pg_catalog.now())
    OR EXISTS (SELECT 1 FROM authz.coach_calendar_my_grants()))
$$;

-- Unchanged from 0080 but for the coached interview:create path.
CREATE OR REPLACE FUNCTION authz.set_interview_panel(p_interview uuid, p_members uuid[], p_lead uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  perm constant text := 'interview:update';
  members uuid[] := coalesce(p_members, '{}');
  i record;
  n integer;
BEGIN
  IF authz.current_user_id() IS NULL OR p_interview IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT iv.recruiter_id, iv.team_id INTO i FROM eureka.interview iv WHERE iv.id = p_interview;
  IF NOT FOUND OR NOT coalesce(authz.has_org(perm)
       OR i.recruiter_id = ANY (authz.recruiter_ids(perm))
       OR i.team_id = ANY (authz.owned_team_ids(perm))
       OR i.team_id = ANY (authz.coached_team_ids('interview:create')), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- One writer per interview at a time (two concurrent replacements would
  -- otherwise both delete and then collide on the primary key).
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('interview_panel:' || p_interview::text, 0));

  n := coalesce(pg_catalog.cardinality(members), 0);
  IF n > 10 THEN
    RAISE EXCEPTION 'panel_too_large' USING ERRCODE = 'check_violation';
  END IF;
  IF pg_catalog.array_position(members, NULL) IS NOT NULL
     OR (SELECT count(DISTINCT m) FROM pg_catalog.unnest(members) AS m) IS DISTINCT FROM n::bigint THEN
    RAISE EXCEPTION 'invalid_panel' USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT count(*) FROM eureka.app_user u WHERE u.id = ANY (members) AND u.status = 'active') IS DISTINCT FROM n::bigint THEN
    RAISE EXCEPTION 'invalid_panel_member' USING ERRCODE = 'check_violation';
  END IF;
  IF p_lead IS NOT NULL AND NOT coalesce(p_lead = ANY (members), false) THEN
    RAISE EXCEPTION 'lead_not_in_panel' USING ERRCODE = 'check_violation';
  END IF;

  DELETE FROM eureka.interview_panelist WHERE interview_id = p_interview;
  INSERT INTO eureka.interview_panelist (interview_id, user_id, is_lead)
  SELECT p_interview, m, coalesce(m = p_lead, false) FROM pg_catalog.unnest(members) AS m;
  RETURN n;
END $$;

-- Unchanged from 0508 but for the coached interview:create path.
CREATE OR REPLACE FUNCTION authz.assert_interview_staff_free(p_interview uuid, p_users uuid[])
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  me record;
  users uuid[];
BEGIN
  IF authz.current_user_id() IS NULL OR p_interview IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT i.id, i.recruiter_id, i.team_id, i.location_id, i.starts_at, i.ends_at, i.call_status
    INTO me FROM eureka.interview i WHERE i.id = p_interview;
  IF NOT FOUND OR NOT coalesce(authz.owns('interview:update', me.recruiter_id, me.team_id, me.location_id)
                               OR authz.owns('submission:update', me.recruiter_id, me.team_id, me.location_id)
                               OR me.team_id = ANY (authz.coached_team_ids('interview:create')), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT coalesce(pg_catalog.array_agg(DISTINCT u ORDER BY u), '{}') INTO users
    FROM pg_catalog.unnest(p_users) AS u WHERE u IS NOT NULL;
  IF coalesce(pg_catalog.cardinality(users), 0) = 0
     OR coalesce(me.call_status IN ('cancelled', 'rescheduled', 'no_invite'), true) THEN
    RETURN;
  END IF;
  -- One booking check per person at a time, in a fixed order (no deadlocks
  -- between two writers sharing people).
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('interview_staff:' || u::text, 0))
    FROM pg_catalog.unnest(users) WITH ORDINALITY AS t(u, n) ORDER BY n;
  IF EXISTS (
       SELECT 1 FROM eureka.interview o
        WHERE o.id <> me.id
          AND o.call_status NOT IN ('cancelled', 'rescheduled', 'no_invite')
          AND o.starts_at < me.ends_at AND o.ends_at > me.starts_at
          AND (o.coach_id = ANY (users)
               OR o.id IN (SELECT p.interview_id FROM eureka.interview_panelist p WHERE p.user_id = ANY (users)))) THEN
    RAISE EXCEPTION 'interviewer_conflict' USING ERRCODE = 'exclusion_violation';
  END IF;
END $$;
RESET ROLE;
