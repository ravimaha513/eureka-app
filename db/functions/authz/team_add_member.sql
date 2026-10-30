-- authz.team_add_member: current definition (repeatable; db/functions/README.md).
-- A team lead adds an unassigned recruiter to the team they lead (docs/admin-api.md
-- AD-10, team:add_member). The admin path stays authz.admin_add_team_member (0013).
-- Change this file, not a new migration.

-- 0310: branches on role traits (authz.user_has_trait), never on the role key (docs/roles-api.md).
SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.team_add_member(p_team uuid, p_user uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE actor uuid := authz.current_user_id(); t_lead uuid;
BEGIN
  IF actor IS NULL OR NOT coalesce(authz.has_perm('team:add_member'), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_user IS NOT DISTINCT FROM actor THEN
    RAISE EXCEPTION 'self_change' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT t.lead_id INTO t_lead FROM eureka.team t WHERE t.id = p_team;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'team_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  -- Own team: the one the actor leads. Wider grants (hierarchy, org) cover more teams.
  IF NOT coalesce(
       authz.has_org('team:add_member')
       OR t_lead = actor
       OR (p_team = ANY (authz.team_ids('team:add_member'))
           AND EXISTS (SELECT 1 FROM authz.grants('team:add_member') g WHERE g.scope = 'hierarchy')),
       false) THEN
    RAISE EXCEPTION 'not_in_scope' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF authz.admin_user_status(p_user) IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'user_inactive' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT authz.user_has_trait(p_user, 'recruiter') THEN
    RAISE EXCEPTION 'not_a_recruiter' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM eureka.team_member tm WHERE tm.user_id = p_user AND tm.valid @> pg_catalog.now()) THEN
    RAISE EXCEPTION 'already_member' USING ERRCODE = 'unique_violation';
  END IF;
  INSERT INTO eureka.team_member (team_id, user_id) VALUES (p_team, p_user);
END $function$;

REVOKE ALL ON FUNCTION authz.team_add_member(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.team_add_member(uuid, uuid) TO eureka_app;
RESET ROLE;
