-- authz.coach_assignment_guard: current definition (repeatable; db/functions/README.md).
-- Permission and scope for changing p_coach's team assignments (AD-11): an org
-- admin (access:manage) for anyone; coach:assign at org scope for anyone, at
-- hierarchy scope for users below the caller in reporting_closure. Never oneself
-- (that would widen one's own scope). Raises; returns nothing.
-- Change this file, not a new migration.

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.coach_assignment_guard(p_coach uuid)
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE actor uuid := authz.current_user_id();
BEGIN
  IF actor IS NULL OR NOT coalesce(authz.has_org('access:manage') OR authz.has_perm('coach:assign'), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_coach IS NOT DISTINCT FROM actor THEN
    RAISE EXCEPTION 'self_change' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT coalesce(
       authz.has_org('access:manage')
       OR authz.has_org('coach:assign')
       OR (EXISTS (SELECT 1 FROM authz.grants('coach:assign') g WHERE g.scope = 'hierarchy')
           AND EXISTS (SELECT 1 FROM eureka.reporting_closure rc
                       WHERE rc.ancestor_id = actor AND rc.descendant_id = p_coach)),
       false) THEN
    RAISE EXCEPTION 'not_in_scope' USING ERRCODE = 'insufficient_privilege';
  END IF;
END $function$;

REVOKE ALL ON FUNCTION authz.coach_assignment_guard(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.coach_assignment_guard(uuid) TO authz_definer;
RESET ROLE;
