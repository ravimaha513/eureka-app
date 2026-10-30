-- authz.org_chart_ladder_ok: current definition (repeatable; db/functions/README.md).
-- Ladder rule of the org chart (docs/roles-api.md, "Org chart"): true when p_manager's
-- highest ladder level is above p_user's. Levels are compared within the tracks the two
-- share; when they share none (an Interview Lead under an Associate Director), each
-- one's highest level counts. No roles on either side counts as level 0.

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.org_chart_ladder_ok(p_user uuid, p_manager uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE u_tracks text[]; m_tracks text[]; shared boolean; u_level integer; m_level integer;
BEGIN
  SELECT coalesce(array_agg(DISTINCT r.track), '{}') INTO u_tracks FROM eureka.user_role ur JOIN eureka.role r ON r.key = ur.role_key
   WHERE ur.user_id = p_user AND ur.valid @> pg_catalog.now();
  SELECT coalesce(array_agg(DISTINCT r.track), '{}') INTO m_tracks FROM eureka.user_role ur JOIN eureka.role r ON r.key = ur.role_key
   WHERE ur.user_id = p_manager AND ur.valid @> pg_catalog.now();
  shared := u_tracks && m_tracks;
  SELECT max(r.level) INTO u_level FROM eureka.user_role ur JOIN eureka.role r ON r.key = ur.role_key
   WHERE ur.user_id = p_user AND ur.valid @> pg_catalog.now() AND (NOT shared OR r.track = ANY (m_tracks));
  SELECT max(r.level) INTO m_level FROM eureka.user_role ur JOIN eureka.role r ON r.key = ur.role_key
   WHERE ur.user_id = p_manager AND ur.valid @> pg_catalog.now() AND (NOT shared OR r.track = ANY (u_tracks));
  RETURN coalesce(m_level, 0) > coalesce(u_level, 0);
END $function$;

REVOKE ALL ON FUNCTION authz.org_chart_ladder_ok(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.org_chart_ladder_ok(uuid, uuid) TO eureka_app, authz_definer;
RESET ROLE;
