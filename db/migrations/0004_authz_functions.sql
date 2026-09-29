-- Database-side scope computation (design B4.5, B4.8).
-- The only input from the application is eureka.user_id. Every function is
-- owned by authz_definer (BYPASSRLS, NOLOGIN), pins search_path, and is
-- executable only by the app and worker roles.
SET ROLE authz_definer;

CREATE FUNCTION authz.current_user_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT nullif(pg_catalog.current_setting('eureka.user_id', true), '')::uuid
$$;

-- Active grants (scope, location) the current user holds for a permission.
CREATE FUNCTION authz.grants(perm text)
RETURNS TABLE (scope text, location_id uuid, is_sales boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT rp.scope, ur.location_id, r.is_sales
  FROM eureka.user_role ur
  JOIN eureka.app_user u ON u.id = ur.user_id AND u.status = 'active'
  JOIN eureka.role r ON r.key = ur.role_key
  JOIN eureka.role_permission rp ON rp.role_key = ur.role_key AND rp.permission = perm
  WHERE ur.user_id = authz.current_user_id()
    AND ur.valid @> pg_catalog.now()
$$;

CREATE FUNCTION authz.has_perm(perm text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM authz.grants(perm))
$$;

CREATE FUNCTION authz.has_org(perm text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM authz.grants(perm) g WHERE g.scope = 'org')
$$;

CREATE FUNCTION authz.recruiter_ids(perm text) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce(array_agg(DISTINCT x), '{}') FROM (
    SELECT authz.current_user_id() AS x
      WHERE EXISTS (SELECT 1 FROM authz.grants(perm) g WHERE g.scope IN ('own','team','hierarchy'))
    UNION ALL
    SELECT rc.descendant_id FROM eureka.reporting_closure rc
      WHERE rc.ancestor_id = authz.current_user_id()
        AND EXISTS (SELECT 1 FROM authz.grants(perm) g WHERE g.scope = 'hierarchy')
  ) s
$$;

CREATE FUNCTION authz.team_ids(perm text) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH me AS (SELECT authz.current_user_id() AS id),
  scopes AS (SELECT DISTINCT scope FROM authz.grants(perm)),
  own_teams AS (
    SELECT tm.team_id FROM eureka.team_member tm, me
      WHERE tm.user_id = me.id AND tm.valid @> pg_catalog.now()
    UNION SELECT t.id FROM eureka.team t, me WHERE t.lead_id = me.id
  )
  SELECT coalesce(array_agg(DISTINCT x), '{}') FROM (
    SELECT team_id AS x FROM own_teams WHERE EXISTS (SELECT 1 FROM scopes WHERE scope IN ('team','hierarchy'))
    UNION ALL
    SELECT t.id FROM eureka.team t JOIN eureka.reporting_closure rc ON rc.descendant_id = t.lead_id, me
      WHERE rc.ancestor_id = me.id AND EXISTS (SELECT 1 FROM scopes WHERE scope = 'hierarchy')
    UNION ALL
    SELECT ca.team_id FROM eureka.coach_assignment ca, me
      WHERE ca.coach_id = me.id AND ca.valid @> pg_catalog.now()
        AND EXISTS (SELECT 1 FROM scopes WHERE scope = 'coached')
  ) s
$$;

CREATE FUNCTION authz.location_ids(perm text) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce(array_agg(DISTINCT g.location_id), '{}')
  FROM authz.grants(perm) g WHERE g.scope = 'location' AND g.location_id IS NOT NULL
$$;

-- "Open to all teams" applies to Sales roles for these permissions only (AS-07).
CREATE FUNCTION authz.all_teams(perm text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT perm IN ('candidate:read','hotlist:read','submission:create','placement:create')
     AND EXISTS (SELECT 1 FROM authz.grants(perm) g WHERE g.is_sales)
$$;

-- Ownership test used by triggers and definer functions (not the all-teams rule).
CREATE FUNCTION authz.owns(perm text, p_recruiter uuid, p_team uuid, p_location uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT authz.has_org(perm)
      OR p_recruiter = ANY (authz.recruiter_ids(perm))
      OR p_team      = ANY (authz.team_ids(perm))
      OR p_location  = ANY (authz.location_ids(perm))
$$;

-- Candidate visibility for a permission, reading candidate without RLS.
CREATE FUNCTION authz.candidate_visible(p_candidate uuid, perm text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM eureka.candidate c WHERE c.id = p_candidate AND (
      authz.owns(perm, c.recruiter_id, c.team_id, c.location_id)
      OR (authz.all_teams(perm) AND c.visibility = 'all_teams'
          AND c.marketing_status IN ('active','full_of_interviews'))))
$$;

-- Candidate owned (not via all-teams) for a permission; used by activity policies.
CREATE FUNCTION authz.candidate_owned(p_candidate uuid, perm text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM eureka.candidate c WHERE c.id = p_candidate
      AND authz.owns(perm, c.recruiter_id, c.team_id, c.location_id))
$$;

-- The actor's current team: membership first, else a team they lead.
CREATE FUNCTION authz.actor_team() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce(
    (SELECT tm.team_id FROM eureka.team_member tm
      WHERE tm.user_id = authz.current_user_id() AND tm.valid @> pg_catalog.now() LIMIT 1),
    (SELECT t.id FROM eureka.team t WHERE t.lead_id = authz.current_user_id() ORDER BY t.id LIMIT 1))
$$;

RESET ROLE;

DO $$
DECLARE f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'authz'
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO eureka_app, eureka_worker, eureka_owner', f.sig);
  END LOOP;
END $$;
