-- authz.datahub_readable_folders: current definition (repeatable; db/functions/README.md).
-- Earlier bodies: migration 0075. DataHub folder creators (datahub:create,
-- docs/datahub-api.md DH-2a) added here. Change this file, not a new migration.

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.datahub_readable_folders()
 RETURNS uuid[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  WITH me AS (
    SELECT authz.current_user_id() AS id, authz.has_perm('datahub:read') AS staff, authz.datahub_my_roles() AS roles,
           authz.has_org('datahub:manage') AS org_mgr, authz.location_ids('datahub:manage') AS mgr_locs,
           authz.has_perm('datahub:create') AS creator),
  f AS (
    SELECT x.id, x.parent_id,
      coalesce(me.staff AND (
        x.level = 'internal'
        OR (x.level = 'confidential' AND (x.role_keys && me.roles OR me.org_mgr OR x.location_id = ANY (me.mgr_locs)
                                       OR (me.creator AND x.created_by = me.id)))
        OR (x.level = 'restricted' AND EXISTS (
              SELECT 1 FROM eureka.datahub_folder_member m WHERE m.folder_id = x.id AND m.user_id = me.id))), false) AS ok
    FROM eureka.datahub_folder x, me WHERE x.deleted_at IS NULL)
  SELECT coalesce(pg_catalog.array_agg(c.id), '{}') FROM f c LEFT JOIN f p ON p.id = c.parent_id
  WHERE c.ok AND (c.parent_id IS NULL OR coalesce(p.ok, false))
$function$;

REVOKE ALL ON FUNCTION authz.datahub_readable_folders() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.datahub_readable_folders() TO eureka_app;
RESET ROLE;
