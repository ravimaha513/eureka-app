-- authz.is_interview_coach: current definition (repeatable; db/functions/README.md).
-- Earlier body: migration 0130. Change this file, not a new migration.
-- 0310: an active user whose role has the coach trait (docs/roles-api.md); the
-- eureka.interview_coach_guard trigger (0130) and the API call it.

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.is_interview_coach(p_user uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT authz.user_has_trait(p_user, 'coach')
$function$;

REVOKE ALL ON FUNCTION authz.is_interview_coach(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.is_interview_coach(uuid) TO eureka_app, eureka_owner;
RESET ROLE;
