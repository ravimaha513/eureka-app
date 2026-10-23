-- authz.datahub_create_folder: current definition (repeatable; db/functions/README.md).
-- Earlier bodies: migration 0075. DataHub folder creators (datahub:create,
-- docs/datahub-api.md DH-2a) added here. Change this file, not a new migration.

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.datahub_create_folder(p_parent uuid, p_name text, p_description text, p_level text, p_roles text[], p_members uuid[], p_members_can_upload boolean, p_location uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE par record; loc uuid; f_id uuid; nmembers integer := 0; plevel text;
BEGIN
  IF authz.current_user_id() IS NULL OR NOT coalesce(authz.has_perm('datahub:read'), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT coalesce(authz.has_perm('datahub:manage') OR authz.has_perm('datahub:create'), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_parent IS NOT NULL THEN
    -- FOR SHARE: serialises with a concurrent change or delete of the parent (FOR UPDATE there).
    SELECT x.id, x.parent_id, x.location_id, x.level INTO par FROM eureka.datahub_folder x
     WHERE x.id = p_parent AND x.deleted_at IS NULL FOR SHARE;
    IF NOT FOUND OR NOT (p_parent = ANY (authz.datahub_visible_folders())) THEN
      RAISE EXCEPTION 'not_found' USING ERRCODE = 'no_data_found';
    END IF;
    IF NOT (p_parent = ANY (authz.datahub_managed_folders())) THEN
      RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF par.parent_id IS NOT NULL THEN
      RAISE EXCEPTION 'too_deep' USING ERRCODE = 'check_violation';
    END IF;
    IF p_location IS NOT NULL AND p_location IS DISTINCT FROM par.location_id THEN
      RAISE EXCEPTION 'invalid_location' USING ERRCODE = 'check_violation';
    END IF;
    loc := par.location_id;
    plevel := par.level;
  ELSE
    loc := p_location;
    IF loc IS NULL AND NOT coalesce(authz.has_org('datahub:manage') OR authz.has_perm('datahub:create'), false) THEN
      RAISE EXCEPTION 'location_required' USING ERRCODE = 'check_violation';
    END IF;
    IF loc IS NOT NULL AND NOT coalesce(authz.has_org('datahub:manage') OR loc = ANY (authz.location_ids('datahub:manage')), false) THEN
      RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF loc IS NOT NULL AND NOT EXISTS (SELECT 1 FROM eureka.location l WHERE l.id = loc) THEN
      RAISE EXCEPTION 'invalid_location' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF p_level IS NULL OR p_level NOT IN ('internal', 'confidential', 'restricted') THEN
    RAISE EXCEPTION 'invalid_level' USING ERRCODE = 'check_violation';
  END IF;
  IF p_parent IS NOT NULL AND authz.datahub_stricter(p_level, plevel) IS DISTINCT FROM p_level THEN
    RAISE EXCEPTION 'level_below_parent' USING ERRCODE = 'check_violation';
  END IF;
  IF p_level = 'confidential' AND NOT coalesce(authz.datahub_valid_roles(p_roles), false) THEN
    RAISE EXCEPTION 'invalid_roles' USING ERRCODE = 'check_violation';
  END IF;
  IF p_level <> 'confidential' AND pg_catalog.cardinality(coalesce(p_roles, '{}')) > 0 THEN
    RAISE EXCEPTION 'invalid_roles' USING ERRCODE = 'check_violation';
  END IF;
  IF p_level <> 'restricted' AND pg_catalog.cardinality(coalesce(p_members, '{}')) > 0 THEN
    RAISE EXCEPTION 'invalid_member' USING ERRCODE = 'check_violation';
  END IF;
  IF pg_catalog.cardinality(coalesce(p_members, '{}')) > 200 THEN
    RAISE EXCEPTION 'invalid_member' USING ERRCODE = 'check_violation';
  END IF;
  IF p_name IS NULL OR NOT coalesce(char_length(p_name) BETWEEN 1 AND 80 AND p_name = btrim(p_name) AND p_name !~ '[[:cntrl:]/\\]', false)
     OR NOT coalesce(p_description IS NULL OR (char_length(p_description) BETWEEN 1 AND 500
                                               AND p_description !~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]'), false) THEN
    RAISE EXCEPTION 'invalid_folder' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('datahub:folder:' || coalesce(p_parent::text, 'root'), 0));
  IF EXISTS (SELECT 1 FROM eureka.datahub_folder x WHERE x.parent_id IS NOT DISTINCT FROM p_parent
              AND lower(x.name) = lower(p_name) AND x.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'name_taken' USING ERRCODE = 'unique_violation';
  END IF;
  INSERT INTO eureka.datahub_folder AS x (parent_id, name, description, level, role_keys, members_can_upload, location_id, created_by, updated_by)
  VALUES (p_parent, p_name, p_description, p_level, CASE WHEN p_level = 'confidential' THEN p_roles ELSE '{}' END,
          coalesce(p_members_can_upload, false), loc, authz.current_user_id(), authz.current_user_id())
  RETURNING x.id INTO f_id;
  INSERT INTO eureka.audit_event (actor_id, action, entity_type, entity_id, changes)
  VALUES (authz.current_user_id(), 'datahub.folder_created', 'datahub_folder', f_id, pg_catalog.jsonb_build_object(
    'parentId', p_parent, 'locationId', loc, 'level', p_level,
    'roleCount', pg_catalog.cardinality(coalesce(p_roles, '{}')), 'memberCount', pg_catalog.cardinality(coalesce(p_members, '{}')),
    'membersCanUpload', coalesce(p_members_can_upload, false)));
  IF p_level = 'restricted' THEN
    nmembers := authz.datahub_add_members(f_id, p_members);
  END IF;
  RETURN f_id;
END $function$;

REVOKE ALL ON FUNCTION authz.datahub_create_folder(uuid, text, text, text, text[], uuid[], boolean, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.datahub_create_folder(uuid, text, text, text, text[], uuid[], boolean, uuid) TO eureka_app;
RESET ROLE;
