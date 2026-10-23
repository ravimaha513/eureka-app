-- authz.current_user_id: current definition (repeatable; db/functions/README.md).
-- Earlier bodies: migrations 0004, 0033, 0041. Change this file, not a new migration.

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.current_user_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT CASE
    WHEN session_user::text IS DISTINCT FROM 'eureka_import' OR authz.import_active()
      THEN nullif(pg_catalog.current_setting('eureka.user_id', true), '')::uuid
  END
$function$;

REVOKE ALL ON FUNCTION authz.current_user_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.current_user_id() TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.current_user_id() TO eureka_owner;
GRANT EXECUTE ON FUNCTION authz.current_user_id() TO eureka_worker;
RESET ROLE;
