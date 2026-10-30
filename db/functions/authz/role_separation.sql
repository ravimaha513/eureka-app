-- authz.role_separation: current definition (repeatable; db/functions/README.md).
-- Separation of duties (AD-3a): a role with the admin trait is never held together
-- with a role without it. Raises separation_of_duties when granting p_role to p_user
-- would break that. Called by request_role and approve_role_request.

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.role_separation(p_role text, p_user uuid)
 RETURNS void
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE adm boolean;
BEGIN
  SELECT ro.is_admin INTO adm FROM eureka.role ro WHERE ro.key = p_role;
  IF EXISTS (SELECT 1 FROM eureka.user_role ur JOIN eureka.role ro ON ro.key = ur.role_key
             WHERE ur.user_id = p_user AND ur.valid @> pg_catalog.now() AND ro.is_admin IS DISTINCT FROM coalesce(adm, false)) THEN
    RAISE EXCEPTION 'separation_of_duties' USING ERRCODE = 'check_violation';
  END IF;
END $function$;

REVOKE ALL ON FUNCTION authz.role_separation(text, uuid) FROM PUBLIC;
RESET ROLE;
