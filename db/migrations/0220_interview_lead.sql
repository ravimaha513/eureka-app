-- Interview Lead (head of the Interview Prep sub-department) and managed coach
-- assignments (docs/admin-api.md AD-11).
--   * New scope `coached_hierarchy`: the teams coached (coach_assignment) by the
--     caller or by anyone below them in reporting_closure. The Interview Lead
--     reports to the Associate Director and their coaches report to them, so
--     the lead sees what their coaches see. Mirrored in engine.ts
--     (subtreeCoachedTeamIds), training.ts and access.service.ts.
--   * authz.team_ids, authz.coached_team_ids (coach feedback kind) and
--     authz.training_batch_ids learn the new scope. team_ids keeps 0210's
--     reporting-line rules for team/hierarchy unchanged.
--   * authz_definer may insert coach_assignment rows: writes go through
--     authz.assign_coach / authz.unassign_coach (db/functions/authz/).
-- Tests: apps/api/test/coach-assignment.db.int.test.ts.
SET ROLE eureka_owner;

ALTER TABLE eureka.role_permission DROP CONSTRAINT role_permission_scope_check;
ALTER TABLE eureka.role_permission ADD CONSTRAINT role_permission_scope_check
  CHECK (scope IN ('own','team','coached','coached_hierarchy','hierarchy','location','org'));

GRANT INSERT ON eureka.coach_assignment TO authz_definer;
CREATE INDEX coach_assignment_coach ON eureka.coach_assignment (coach_id);
CREATE INDEX coach_assignment_team ON eureka.coach_assignment (team_id);

RESET ROLE;
SET ROLE authz_definer;

-- Teams covered by a coached or coached_hierarchy grant.
CREATE OR REPLACE FUNCTION authz.coached_team_ids(perm text) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH me AS (SELECT authz.current_user_id() AS id),
  scopes AS (SELECT DISTINCT scope FROM authz.grants(perm))
  SELECT coalesce(array_agg(DISTINCT ca.team_id), '{}')
  FROM eureka.coach_assignment ca, me
  WHERE ca.valid @> pg_catalog.now()
    AND ((ca.coach_id = me.id
          AND EXISTS (SELECT 1 FROM scopes WHERE scope IN ('coached','coached_hierarchy')))
      OR (ca.coach_id IN (SELECT rc.descendant_id FROM eureka.reporting_closure rc WHERE rc.ancestor_id = me.id)
          AND EXISTS (SELECT 1 FROM scopes WHERE scope = 'coached_hierarchy')))
$$;

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
        AND EXISTS (SELECT 1 FROM scopes WHERE scope IN ('coached','coached_hierarchy'))
    UNION ALL
    SELECT ca.team_id FROM eureka.coach_assignment ca JOIN eureka.reporting_closure rc ON rc.descendant_id = ca.coach_id, me
      WHERE rc.ancestor_id = me.id AND ca.valid @> pg_catalog.now()
        AND EXISTS (SELECT 1 FROM scopes WHERE scope = 'coached_hierarchy')
  ) s
$$;

-- TR-2 plus coached_hierarchy: batches trained by the caller or anyone below them.
CREATE OR REPLACE FUNCTION authz.training_batch_ids(perm text) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE
    WHEN perm NOT IN ('training:read', 'training:manage', 'training.progress:update') THEN '{}'::uuid[]
    WHEN authz.has_org(perm) THEN (SELECT coalesce(pg_catalog.array_agg(b.id), '{}') FROM eureka.batch b)
    ELSE (SELECT coalesce(pg_catalog.array_agg(b.id), '{}') FROM eureka.batch b
          WHERE b.location_id = ANY (authz.location_ids(perm))
             OR (b.trainer_id = authz.current_user_id()
                 AND EXISTS (SELECT 1 FROM authz.grants(perm) g WHERE g.scope IN ('coached','coached_hierarchy')))
             OR (b.trainer_id IN (SELECT rc.descendant_id FROM eureka.reporting_closure rc
                                   WHERE rc.ancestor_id = authz.current_user_id())
                 AND EXISTS (SELECT 1 FROM authz.grants(perm) g WHERE g.scope = 'coached_hierarchy')))
  END
$$;

RESET ROLE;
