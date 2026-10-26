-- Scope follows reporting lines, not upward team membership.
-- Orgs model a manager's leads as members of the manager's team (and managers as
-- members of the AD's team). authz.team_ids counted those member-of teams for
-- `team` and `hierarchy` grants, so a lead saw their manager's team and peers,
-- and a manager could move people in the AD's team. Now:
--   * team_ids, `team` scope: the teams one leads; only someone who leads none
--     gets the team they are a member of (recruiters).
--   * team_ids, `hierarchy` scope: led teams plus teams led below in
--     reporting_closure; member-of teams never count.
--   * actor_team: the led team first, membership as fallback, so records a lead
--     creates are stamped with the lead's own team.
--   * scope_user_ids: the team-member and team-lead branches never return
--     anyone above the caller in the reporting chain.
-- Mirrored in apps/api/src/platform/access.service.ts and engine.ts. Tests:
-- apps/api/test/hierarchy-scope.db.int.test.ts.
SET ROLE authz_definer;

CREATE OR REPLACE FUNCTION authz.team_ids(perm text) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH me AS (SELECT authz.current_user_id() AS id),
  scopes AS (SELECT DISTINCT scope FROM authz.grants(perm)),
  led AS (SELECT t.id FROM eureka.team t, me WHERE t.lead_id = me.id)
  SELECT coalesce(array_agg(DISTINCT x), '{}') FROM (
    SELECT id AS x FROM led WHERE EXISTS (SELECT 1 FROM scopes WHERE scope IN ('team','hierarchy'))
    UNION ALL
    SELECT tm.team_id FROM eureka.team_member tm, me
      WHERE tm.user_id = me.id AND tm.valid @> pg_catalog.now()
        AND NOT EXISTS (SELECT 1 FROM led)
        AND EXISTS (SELECT 1 FROM scopes WHERE scope = 'team')
    UNION ALL
    SELECT t.id FROM eureka.team t JOIN eureka.reporting_closure rc ON rc.descendant_id = t.lead_id, me
      WHERE rc.ancestor_id = me.id AND EXISTS (SELECT 1 FROM scopes WHERE scope = 'hierarchy')
    UNION ALL
    SELECT ca.team_id FROM eureka.coach_assignment ca, me
      WHERE ca.coach_id = me.id AND ca.valid @> pg_catalog.now()
        AND EXISTS (SELECT 1 FROM scopes WHERE scope = 'coached')
  ) s
$$;

-- The actor's current team: a team they lead first, else their membership.
CREATE OR REPLACE FUNCTION authz.actor_team() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce(
    (SELECT t.id FROM eureka.team t WHERE t.lead_id = authz.current_user_id() ORDER BY t.id LIMIT 1),
    (SELECT tm.team_id FROM eureka.team_member tm
      WHERE tm.user_id = authz.current_user_id() AND tm.valid @> pg_catalog.now() LIMIT 1))
$$;

CREATE OR REPLACE FUNCTION authz.scope_user_ids(perm text) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH s AS (SELECT authz.team_ids(perm) AS teams, authz.location_ids(perm) AS locs),
  above AS (SELECT rc.ancestor_id AS id FROM eureka.reporting_closure rc
             WHERE rc.descendant_id = authz.current_user_id())
  SELECT coalesce(pg_catalog.array_agg(DISTINCT x) FILTER (WHERE x IS NOT NULL), '{}') FROM (
    SELECT pg_catalog.unnest(authz.recruiter_ids(perm)) AS x
    UNION ALL
    SELECT tm.user_id FROM eureka.team_member tm, s
     WHERE tm.team_id = ANY (s.teams) AND tm.valid @> pg_catalog.now()
       AND NOT EXISTS (SELECT 1 FROM above WHERE above.id = tm.user_id)
    UNION ALL
    SELECT t.lead_id FROM eureka.team t, s WHERE t.id = ANY (s.teams)
       AND NOT EXISTS (SELECT 1 FROM above WHERE above.id = t.lead_id)
    UNION ALL
    SELECT tm.user_id FROM eureka.team_member tm JOIN eureka.team t ON t.id = tm.team_id, s
     WHERE t.location_id = ANY (s.locs) AND tm.valid @> pg_catalog.now()
    UNION ALL
    SELECT u.id FROM eureka.app_user u, s WHERE u.primary_location_id = ANY (s.locs)
  ) q
$$;

RESET ROLE;
