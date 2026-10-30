-- authz.team_remove_member: current definition (repeatable; db/functions/README.md).
-- Take someone out of a team (docs/admin-api.md AD-14). Allowed for Users & Access
-- admins (access:manage, org) and for whoever may add to the team (team:add_member:
-- the team's lead, managers and associate directors above them) -- the same rule as
-- authz.team_add_member. The person's candidates on that team go to the team's lead,
-- as on a move (authz.move_team_member). Change this file, not a new migration.

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.team_remove_member(p_team uuid, p_user uuid)
 RETURNS TABLE (moved_candidates integer, reassigned_to uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE actor uuid := authz.current_user_id(); t_lead uuid; n integer;
BEGIN
  IF actor IS NULL OR NOT coalesce(authz.has_org('access:manage') OR authz.has_perm('team:add_member'), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_user IS NOT DISTINCT FROM actor THEN
    RAISE EXCEPTION 'self_change' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT t.lead_id INTO t_lead FROM eureka.team t WHERE t.id = p_team;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'team_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT coalesce(
       authz.has_org('access:manage')
       OR authz.has_org('team:add_member')
       OR t_lead = actor
       OR (p_team = ANY (authz.team_ids('team:add_member'))
           AND EXISTS (SELECT 1 FROM authz.grants('team:add_member') g WHERE g.scope = 'hierarchy')),
       false) THEN
    RAISE EXCEPTION 'not_in_scope' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM 1 FROM eureka.team_member tm
    WHERE tm.user_id = p_user AND tm.team_id = p_team AND tm.valid @> pg_catalog.now() FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_a_member' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM eureka.app_user u WHERE u.id = t_lead AND u.status = 'active') THEN
    RAISE EXCEPTION 'invalid_reassign_target' USING ERRCODE = 'check_violation';
  END IF;

  UPDATE eureka.candidate c SET recruiter_id = t_lead
    WHERE c.team_id = p_team AND c.recruiter_id = p_user;
  GET DIAGNOSTICS n = ROW_COUNT;
  UPDATE eureka.team_member SET valid = authz.ended(valid)
    WHERE user_id = p_user AND team_id = p_team AND valid @> pg_catalog.now();
  RETURN QUERY SELECT n, t_lead;
END $function$;

REVOKE ALL ON FUNCTION authz.team_remove_member(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.team_remove_member(uuid, uuid) TO eureka_app;
RESET ROLE;
