-- Rule 3 inside the authz functions: authz.current_user_id() evaluated once
-- per call, never once per scanned row.
--
-- authz.grants filtered user_role with `ur.user_id = authz.current_user_id()`.
-- A STABLE function in a filter is evaluated per row unless the planner turns
-- it into an index key: with no statistics on user_role it probed the index
-- (one call); after an (auto)analyze it seq-scanned the small table and called
-- it per user_role row, and each call also runs authz.import_active(). Every
-- RLS InitPlan that reaches grants paid that, and the authz call count of one
-- statement moved from 137 to 555 on `ANALYZE eureka.user_role` alone, with
-- nothing else changed. `(SELECT authz.current_user_id())` is an InitPlan: one
-- call per execution of the function body, whatever the plan.
--
-- The same rewrite for every function that filters a query on
-- current_user_id() (the latest definition of each, otherwise verbatim):
-- grants, recruiter_ids, coached_team_ids, actor_team, hotlist_open,
-- checklist_item_texts (also its constant-argument placement_covered()),
-- session_is_mine, step_up_current, step_up_complete, step_up_fail.
-- None of these is redefined by 0054-0081, so the bodies below are still the
-- latest ones.
--
-- The functions added by 0054-0081 that the read path reaches (RLS InitPlans
-- and the API's list helpers) get the same treatment, with the other definer
-- calls in their filters wrapped too: datahub_my_roles (grants' shape),
-- chat_conversation_ids (also has_perm), my_hiring_job_ids,
-- my_interview_application_ids, my_interview_job_ids,
-- my_application_applicant_ids, training_batch_ids (also location_ids),
-- job_company_names (also my_interview_job_ids) and company_options (also
-- has_org_kind). datahub_readable_folders and datahub_managed_folders put the
-- caller's scope in a `me` CTE referenced once, which PostgreSQL inlines:
-- has_perm, has_org, location_ids and datahub_my_roles then ran once per
-- folder row (50 folders: has_perm 51 calls). `AS MATERIALIZED` evaluates
-- them once.
--
-- The single-row predicates application_readable, application_manageable and
-- job_visible (a primary-key probe, so at most one row is filtered) and
-- session_is_mine's top-level test are wrapped as well, so that no SQL
-- function in authz filters on the bare call (authz-initplan test).
--
-- Not changed: plpgsql uses outside a query filter (assignments, IF tests,
-- VALUES); team_ids/owned_team_ids, whose `me` CTE is referenced more than
-- once and therefore materialized already; and plpgsql write paths
-- (datahub_create_upload, the application_* and datahub_delete_* functions).
--
-- Same rows: an InitPlan returns the same value the direct call would, and a
-- NULL user id still matches nothing (`= NULL` is never true, `IS NOT NULL`
-- unchanged). CREATE OR REPLACE keeps owner, ACL and the pinned search_path;
-- the REVOKEs below restate rule 2. Numbered 0082, after main's 0081;
-- 0090-0099 are reserved for the CrewNex consolidation.
SET ROLE authz_definer;

CREATE OR REPLACE FUNCTION authz.grants(perm text)
 RETURNS TABLE(scope text, location_id uuid, is_sales boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT rp.scope, ur.location_id, r.is_sales
  FROM eureka.user_role ur
  JOIN eureka.app_user u ON u.id = ur.user_id AND u.status = 'active'
  JOIN eureka.role r ON r.key = ur.role_key
  JOIN eureka.role_permission rp ON rp.role_key = ur.role_key AND rp.permission = perm
  WHERE ur.user_id = (SELECT authz.current_user_id())
    AND ur.valid @> pg_catalog.now()
$function$
;

CREATE OR REPLACE FUNCTION authz.recruiter_ids(perm text)
 RETURNS uuid[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT coalesce(array_agg(DISTINCT x), '{}') FROM (
    SELECT authz.current_user_id() AS x
      WHERE EXISTS (SELECT 1 FROM authz.grants(perm) g WHERE g.scope IN ('own','team','hierarchy'))
    UNION ALL
    SELECT rc.descendant_id FROM eureka.reporting_closure rc
      WHERE rc.ancestor_id = (SELECT authz.current_user_id())
        AND EXISTS (SELECT 1 FROM authz.grants(perm) g WHERE g.scope = 'hierarchy')
  ) s
$function$
;

CREATE OR REPLACE FUNCTION authz.coached_team_ids(perm text)
 RETURNS uuid[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT coalesce(array_agg(DISTINCT ca.team_id), '{}')
  FROM eureka.coach_assignment ca
  WHERE ca.coach_id = (SELECT authz.current_user_id()) AND ca.valid @> pg_catalog.now()
    AND EXISTS (SELECT 1 FROM authz.grants(perm) g WHERE g.scope = 'coached')
$function$
;

CREATE OR REPLACE FUNCTION authz.actor_team()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT coalesce(
    (SELECT tm.team_id FROM eureka.team_member tm
      WHERE tm.user_id = (SELECT authz.current_user_id()) AND tm.valid @> pg_catalog.now() LIMIT 1),
    (SELECT t.id FROM eureka.team t WHERE t.lead_id = (SELECT authz.current_user_id()) ORDER BY t.id LIMIT 1))
$function$
;

CREATE OR REPLACE FUNCTION authz.hotlist_open()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT EXISTS (
      SELECT 1 FROM eureka.app_user u WHERE u.id = (SELECT authz.current_user_id()) AND u.status = 'active')
    AND EXISTS (
      SELECT 1 FROM authz.policy_setting WHERE key = 'hotlist_visibility' AND value = 'everyone')
$function$
;

CREATE OR REPLACE FUNCTION authz.checklist_item_texts(p_placement uuid)
 RETURNS TABLE(item_id uuid, notes text, status_reason text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT i.id, i.notes, i.status_reason FROM eureka.checklist_item i
   WHERE i.placement_id = p_placement AND (SELECT authz.current_user_id()) IS NOT NULL
     AND coalesce((SELECT authz.placement_covered(p_placement, 'document:read')), false)
$function$
;

CREATE OR REPLACE FUNCTION authz.session_is_mine(p_session bytea)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT p_session IS NOT NULL AND (SELECT authz.current_user_id()) IS NOT NULL AND EXISTS (
    SELECT 1 FROM eureka.session s JOIN eureka.app_user u ON u.id = s.user_id AND u.status = 'active'
    WHERE s.id_hash = p_session AND s.user_id = (SELECT authz.current_user_id())
      AND s.revoked_at IS NULL AND s.expires_at > pg_catalog.now())
$function$
;

CREATE OR REPLACE FUNCTION authz.step_up_current(p_session bytea)
 RETURNS TABLE(grant_id uuid, method text, auth_time timestamp with time zone, expires_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT g.id, g.method, g.auth_time, g.expires_at FROM eureka.step_up_grant g
  WHERE coalesce(authz.session_is_mine(p_session), false)
    AND g.session_hash = p_session AND g.user_id = (SELECT authz.current_user_id())
    AND g.expires_at > pg_catalog.now()
  ORDER BY g.expires_at DESC, g.id
  LIMIT 1
$function$
;

CREATE OR REPLACE FUNCTION authz.step_up_complete(p_session bytea, p_state_hash bytea, p_nonce_hash bytea, p_sub text, p_auth_time timestamp with time zone, p_max_age_seconds integer, p_ttl_minutes integer)
 RETURNS TABLE(outcome text, grant_id uuid, expires_at timestamp with time zone, return_to text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  c eureka.step_up_challenge%ROWTYPE;
  why text;
  max_age integer := LEAST(GREATEST(coalesce(p_max_age_seconds, 0), 0), 900);
  ttl integer := LEAST(GREATEST(coalesce(p_ttl_minutes, 1), 1), 15);
  g_id uuid; g_exp timestamptz;
BEGIN
  IF NOT coalesce(authz.session_is_mine(p_session), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO c FROM eureka.step_up_challenge x
   WHERE x.state_hash = p_state_hash AND x.session_hash = p_session AND x.user_id = (SELECT authz.current_user_id())
   FOR UPDATE;
  IF NOT FOUND THEN
    why := 'unknown_state';
  ELSIF c.used_at IS NOT NULL THEN
    why := 'replayed';
  ELSE
    IF NOT coalesce(c.expires_at > pg_catalog.now(), false) THEN
      why := 'expired';
    ELSIF p_nonce_hash IS NULL OR p_nonce_hash IS DISTINCT FROM c.nonce_hash THEN
      why := 'nonce_mismatch';
    ELSIF p_sub IS NULL OR NOT EXISTS (
        SELECT 1 FROM eureka.app_user u WHERE u.id = (SELECT authz.current_user_id()) AND u.google_sub = p_sub AND u.status = 'active') THEN
      why := 'wrong_account';
    ELSIF p_auth_time IS NULL
        OR NOT coalesce(p_auth_time >= c.created_at - interval '60 seconds', false)
        OR NOT coalesce(p_auth_time <= pg_catalog.now() + interval '60 seconds', false)
        OR NOT coalesce(p_auth_time >= pg_catalog.now() - pg_catalog.make_interval(secs => max_age), false) THEN
      why := 'stale_auth';
    ELSE
      why := 'granted';
    END IF;
    UPDATE eureka.step_up_challenge SET used_at = pg_catalog.now(), outcome = why WHERE state_hash = c.state_hash;
  END IF;

  IF why IS DISTINCT FROM 'granted' THEN
    INSERT INTO eureka.audit_event (actor_id, action, entity_type, entity_id, changes)
    VALUES (authz.current_user_id(), 'auth.step_up_failed', 'app_user', authz.current_user_id(),
            pg_catalog.jsonb_build_object('method', 'google', 'reason', why));
    RETURN QUERY SELECT why, NULL::uuid, NULL::timestamptz, c.return_to;
    RETURN;
  END IF;

  INSERT INTO eureka.step_up_grant AS g (session_hash, user_id, method, auth_time, expires_at)
  VALUES (p_session, authz.current_user_id(), 'google', p_auth_time, pg_catalog.now() + pg_catalog.make_interval(mins => ttl))
  RETURNING g.id, g.expires_at INTO g_id, g_exp;
  INSERT INTO eureka.audit_event (actor_id, action, entity_type, entity_id, changes)
  VALUES (authz.current_user_id(), 'auth.step_up', 'app_user', authz.current_user_id(),
          pg_catalog.jsonb_build_object('method', 'google', 'grantId', g_id, 'expiresAt', g_exp));
  RETURN QUERY SELECT 'granted'::text, g_id, g_exp, c.return_to;
END $function$
;

CREATE OR REPLACE FUNCTION authz.step_up_fail(p_session bytea, p_state_hash bytea, p_reason text)
 RETURNS TABLE(outcome text, return_to text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE c eureka.step_up_challenge%ROWTYPE; why text;
BEGIN
  IF NOT coalesce(authz.session_is_mine(p_session), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_reason IS NULL OR p_reason NOT IN ('cancelled', 'token_refused') THEN
    RAISE EXCEPTION 'invalid_step_up' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO c FROM eureka.step_up_challenge x
   WHERE x.state_hash = p_state_hash AND x.session_hash = p_session AND x.user_id = (SELECT authz.current_user_id())
   FOR UPDATE;
  IF NOT FOUND THEN
    why := 'unknown_state';
  ELSIF c.used_at IS NOT NULL THEN
    why := 'replayed';
  ELSE
    why := p_reason;
    UPDATE eureka.step_up_challenge SET used_at = pg_catalog.now(), outcome = why WHERE state_hash = c.state_hash;
  END IF;
  INSERT INTO eureka.audit_event (actor_id, action, entity_type, entity_id, changes)
  VALUES (authz.current_user_id(), 'auth.step_up_failed', 'app_user', authz.current_user_id(),
          pg_catalog.jsonb_build_object('method', 'google', 'reason', why));
  RETURN QUERY SELECT why, c.return_to;
END $function$
;

CREATE OR REPLACE FUNCTION authz.datahub_my_roles()
 RETURNS text[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT coalesce(pg_catalog.array_agg(DISTINCT ur.role_key), '{}')
  FROM eureka.user_role ur JOIN eureka.app_user u ON u.id = ur.user_id AND u.status = 'active'
  WHERE ur.user_id = (SELECT authz.current_user_id()) AND ur.valid @> pg_catalog.now()
$function$
;

CREATE OR REPLACE FUNCTION authz.datahub_readable_folders()
 RETURNS uuid[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  WITH me AS MATERIALIZED (
    SELECT (SELECT authz.current_user_id()) AS id, authz.has_perm('datahub:read') AS staff, authz.datahub_my_roles() AS roles,
           authz.has_org('datahub:manage') AS org_mgr, authz.location_ids('datahub:manage') AS mgr_locs),
  f AS (
    SELECT x.id, x.parent_id,
      coalesce(me.staff AND (
        x.level = 'internal'
        OR (x.level = 'confidential' AND (x.role_keys && me.roles OR me.org_mgr OR x.location_id = ANY (me.mgr_locs)))
        OR (x.level = 'restricted' AND EXISTS (
              SELECT 1 FROM eureka.datahub_folder_member m WHERE m.folder_id = x.id AND m.user_id = me.id))), false) AS ok
    FROM eureka.datahub_folder x, me WHERE x.deleted_at IS NULL)
  SELECT coalesce(pg_catalog.array_agg(c.id), '{}') FROM f c LEFT JOIN f p ON p.id = c.parent_id
  WHERE c.ok AND (c.parent_id IS NULL OR coalesce(p.ok, false))
$function$
;

CREATE OR REPLACE FUNCTION authz.datahub_managed_folders()
 RETURNS uuid[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  WITH me AS MATERIALIZED (SELECT authz.has_perm('datahub:read') AS staff, authz.has_org('datahub:manage') AS org_mgr,
                     authz.location_ids('datahub:manage') AS mgr_locs)
  SELECT coalesce(pg_catalog.array_agg(x.id), '{}') FROM eureka.datahub_folder x, me
  WHERE x.deleted_at IS NULL AND me.staff AND (me.org_mgr OR x.location_id = ANY (me.mgr_locs))
$function$
;

CREATE OR REPLACE FUNCTION authz.chat_conversation_ids()
 RETURNS uuid[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT coalesce(pg_catalog.array_agg(m.conversation_id), '{}')
    FROM eureka.chat_member m JOIN eureka.chat_conversation c ON c.id = m.conversation_id
   WHERE m.user_id = (SELECT authz.current_user_id()) AND m.left_at IS NULL AND c.deleted_at IS NULL
     AND coalesce((SELECT authz.has_perm('chat:use')), false)
$function$
;

CREATE OR REPLACE FUNCTION authz.my_hiring_job_ids()
 RETURNS uuid[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT coalesce(array_agg(j.id), '{}') FROM eureka.job j
   WHERE (SELECT authz.current_user_id()) IS NOT NULL AND j.hiring_manager_id = (SELECT authz.current_user_id())
$function$
;

CREATE OR REPLACE FUNCTION authz.my_interview_application_ids()
 RETURNS uuid[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT coalesce(array_agg(DISTINCT i.application_id), '{}') FROM eureka.application_interview i
   JOIN eureka.job_application a ON a.id = i.application_id
   WHERE (SELECT authz.current_user_id()) IS NOT NULL
     AND i.status IN ('scheduled', 'completed') AND a.status IN ('applied', 'shortlisted', 'interview_scheduled', 'offered')
     AND (i.lead_user_id = (SELECT authz.current_user_id())
          OR EXISTS (SELECT 1 FROM eureka.application_interview_panel p WHERE p.interview_id = i.id AND p.user_id = (SELECT authz.current_user_id())))
$function$
;

CREATE OR REPLACE FUNCTION authz.my_interview_job_ids()
 RETURNS uuid[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT coalesce(array_agg(DISTINCT a.job_id), '{}') FROM eureka.application_interview i
   JOIN eureka.job_application a ON a.id = i.application_id
   WHERE (SELECT authz.current_user_id()) IS NOT NULL
     AND i.status IN ('scheduled', 'completed') AND a.status IN ('applied', 'shortlisted', 'interview_scheduled', 'offered')
     AND (i.lead_user_id = (SELECT authz.current_user_id())
          OR EXISTS (SELECT 1 FROM eureka.application_interview_panel p WHERE p.interview_id = i.id AND p.user_id = (SELECT authz.current_user_id())))
$function$
;

CREATE OR REPLACE FUNCTION authz.my_application_applicant_ids()
 RETURNS uuid[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT coalesce(array_agg(DISTINCT x.applicant_id), '{}') FROM (
    SELECT a.applicant_id FROM eureka.job_application a
     JOIN eureka.job j ON j.id = a.job_id
     WHERE (SELECT authz.current_user_id()) IS NOT NULL AND j.hiring_manager_id = (SELECT authz.current_user_id())
    UNION
    SELECT a.applicant_id FROM eureka.application_interview i
     JOIN eureka.job_application a ON a.id = i.application_id
     WHERE (SELECT authz.current_user_id()) IS NOT NULL
       AND i.status IN ('scheduled', 'completed') AND a.status IN ('applied', 'shortlisted', 'interview_scheduled', 'offered')
       AND (i.lead_user_id = (SELECT authz.current_user_id())
            OR EXISTS (SELECT 1 FROM eureka.application_interview_panel p WHERE p.interview_id = i.id AND p.user_id = (SELECT authz.current_user_id())))
  ) x
$function$
;

CREATE OR REPLACE FUNCTION authz.training_batch_ids(perm text)
 RETURNS uuid[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT CASE
    WHEN perm NOT IN ('training:read', 'training:manage', 'training.progress:update') THEN '{}'::uuid[]
    WHEN authz.has_org(perm) THEN (SELECT coalesce(pg_catalog.array_agg(b.id), '{}') FROM eureka.batch b)
    ELSE (SELECT coalesce(pg_catalog.array_agg(b.id), '{}') FROM eureka.batch b
          WHERE b.location_id = ANY ((SELECT authz.location_ids(perm))::uuid[])
             OR (b.trainer_id = (SELECT authz.current_user_id())
                 AND EXISTS (SELECT 1 FROM authz.grants(perm) g WHERE g.scope = 'coached')))
  END
$function$
;

CREATE OR REPLACE FUNCTION authz.job_company_names(p_jobs uuid[])
 RETURNS TABLE(job_id uuid, name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT j.id, c.name
    FROM eureka.job j JOIN eureka.company c ON c.id = j.company_id
   WHERE (SELECT authz.current_user_id()) IS NOT NULL
     AND coalesce(cardinality(p_jobs), 0) BETWEEN 1 AND 500
     AND j.id = ANY (p_jobs) AND j.kind = 'internal_opening'
     AND (j.hiring_manager_id = (SELECT authz.current_user_id())
          OR (SELECT authz.has_org_kind('job:read', false))
          OR j.id = ANY ((SELECT authz.my_interview_job_ids())::uuid[]))
$function$
;

CREATE OR REPLACE FUNCTION authz.company_options()
 RETURNS TABLE(id uuid, name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT c.id, c.name FROM eureka.company c
   WHERE (SELECT authz.current_user_id()) IS NOT NULL AND (SELECT authz.has_org_kind('job:manage', false)) AND c.status = 'active'
   ORDER BY lower(c.name), c.id
$function$
;

CREATE OR REPLACE FUNCTION authz.application_readable(p_app uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT EXISTS (SELECT 1 FROM eureka.job_application a WHERE a.id = p_app AND (SELECT authz.current_user_id()) IS NOT NULL AND (
    authz.has_org('application:read') OR a.job_id = ANY (authz.my_hiring_job_ids()) OR a.id = ANY (authz.my_interview_application_ids())))
$function$
;

CREATE OR REPLACE FUNCTION authz.application_manageable(p_app uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT EXISTS (SELECT 1 FROM eureka.job_application a JOIN eureka.job j ON j.id = a.job_id
    WHERE a.id = p_app AND (SELECT authz.current_user_id()) IS NOT NULL
      AND (authz.has_org('application:manage') OR j.hiring_manager_id = (SELECT authz.current_user_id())))
$function$
;

CREATE OR REPLACE FUNCTION authz.job_visible(p_job uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM eureka.job j WHERE j.id = p_job AND (SELECT authz.current_user_id()) IS NOT NULL AND (
      j.hiring_manager_id = (SELECT authz.current_user_id())
      OR (j.kind = 'client_requirement' AND (
            authz.has_org_kind('job:read', true)
            OR j.owner_id = ANY (authz.recruiter_ids('job:read'))
            OR coalesce(j.team_id = ANY (authz.team_ids('job:read')), false)))
      OR (j.kind = 'internal_opening' AND authz.has_org_kind('job:read', false))))
$function$
;

REVOKE ALL ON FUNCTION authz.grants(text), authz.recruiter_ids(text), authz.coached_team_ids(text), authz.actor_team(),
  authz.hotlist_open(), authz.checklist_item_texts(uuid), authz.session_is_mine(bytea), authz.step_up_current(bytea),
  authz.step_up_complete(bytea, bytea, bytea, text, timestamptz, integer, integer), authz.step_up_fail(bytea, bytea, text),
  authz.datahub_my_roles(), authz.datahub_readable_folders(), authz.datahub_managed_folders(), authz.chat_conversation_ids(),
  authz.my_hiring_job_ids(), authz.my_interview_application_ids(), authz.my_interview_job_ids(),
  authz.my_application_applicant_ids(), authz.training_batch_ids(text), authz.job_company_names(uuid[]), authz.company_options(),
  authz.application_readable(uuid), authz.application_manageable(uuid), authz.job_visible(uuid)
  FROM PUBLIC;

RESET ROLE;
