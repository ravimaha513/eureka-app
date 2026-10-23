-- authz.datahub_managed_folders: current definition (repeatable; db/functions/README.md).
-- Earlier bodies: migration 0075. DataHub folder creators (datahub:create,
-- docs/datahub-api.md DH-2a) added here. Change this file, not a new migration.

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.datahub_managed_folders()
 RETURNS uuid[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  WITH me AS (SELECT authz.current_user_id() AS id, authz.has_perm('datahub:read') AS staff,
                     authz.has_org('datahub:manage') AS org_mgr, authz.location_ids('datahub:manage') AS mgr_locs,
                     authz.has_perm('datahub:create') AS creator)
  SELECT coalesce(pg_catalog.array_agg(x.id), '{}') FROM eureka.datahub_folder x, me
  WHERE x.deleted_at IS NULL AND me.staff AND (me.org_mgr OR x.location_id = ANY (me.mgr_locs)
                                   OR (me.creator AND x.created_by = me.id))
$function$;

REVOKE ALL ON FUNCTION authz.datahub_managed_folders() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.datahub_managed_folders() TO eureka_app;
RESET ROLE;
