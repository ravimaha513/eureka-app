-- DataHub folder creators (docs/datahub-api.md DH-2a): datahub:create lets a
-- role (Lead, Manager, CEO) create organisation-wide folders and manage only
-- the folders they created themselves, without datahub:manage over everyone
-- else's folders (which is a restricted permission: a second approver).
--   * datahub_managed_folders: also the live folders the caller created, while
--     they hold datahub:create (losing the grant loses the folders).
--   * datahub_readable_folders: a creator reads their own confidential folder,
--     as a manager does; restricted folders still need membership (the creator
--     adds themself, audited, as any manager).
--   * datahub_create_folder: datahub:create allows a top-level folder with no
--     location (organisation-wide); a location still needs datahub:manage
--     there. A subfolder still needs its parent managed, so a creator adds
--     subfolders under their own folders only.
-- The bodies are 0075's with only these changes; CREATE OR REPLACE keeps the
-- owner (authz_definer) and the EXECUTE grants.
SET search_path = eureka, public;

SET ROLE authz_definer;

CREATE OR REPLACE FUNCTION authz.datahub_readable_folders() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
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
$$;

CREATE OR REPLACE FUNCTION authz.datahub_managed_folders() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH me AS (SELECT authz.current_user_id() AS id, authz.has_perm('datahub:read') AS staff,
                     authz.has_org('datahub:manage') AS org_mgr, authz.location_ids('datahub:manage') AS mgr_locs,
                     authz.has_perm('datahub:create') AS creator)
  SELECT coalesce(pg_catalog.array_agg(x.id), '{}') FROM eureka.datahub_folder x, me
  WHERE x.deleted_at IS NULL AND me.staff AND (me.org_mgr OR x.location_id = ANY (me.mgr_locs)
                                   OR (me.creator AND x.created_by = me.id))
$$;

CREATE OR REPLACE FUNCTION authz.datahub_create_folder(
  p_parent uuid, p_name text, p_description text, p_level text, p_roles text[], p_members uuid[],
  p_members_can_upload boolean, p_location uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
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
END $$;

RESET ROLE;
