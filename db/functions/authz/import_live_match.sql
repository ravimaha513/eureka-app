-- authz.import_live_match: current definition (repeatable; db/functions/README.md).
-- Earlier bodies: migrations 0028, 0033, 0041. Change this file, not a new migration.

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.import_live_match(p_row uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT coalesce((SELECT authz.import_live_match_norm(x.norm) FROM eureka.import_row x
                    JOIN eureka.import_batch b ON b.id = x.batch_id
                   WHERE x.id = p_row AND x.sheet = 'sales' AND b.status = 'staged'), false)
$function$;

REVOKE ALL ON FUNCTION authz.import_live_match(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.import_live_match(uuid) TO eureka_import;
RESET ROLE;
