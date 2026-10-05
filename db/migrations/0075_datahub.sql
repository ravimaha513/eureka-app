-- DataHub: organisation folders and files on the document storage and malware
-- scan of migration 0043 (docs/datahub-api.md; reference screen "DataHub").
--
--   * eureka.datahub_folder: a folder (name unique among its live siblings,
--     case-insensitive), optional description, a security level, at most one
--     level of subfolders, an optional managing location (NULL: organisation-
--     wide) and the "members can upload" switch. Soft-deleted (empty only).
--       internal      every active staff user (holder of datahub:read) reads it
--       confidential  staff holding one of the folder's role keys read it
--       restricted    only the named members (eureka.datahub_folder_member)
--                     read it; every download needs a live step-up grant
--     A subfolder is readable only by those who can read its parent too.
--   * Managers: datahub:manage covering the folder (org scope: every folder;
--     location scope: folders of that location). They see every folder they
--     manage (settings, members, access log), read the files of the
--     internal/confidential ones and upload there; the files of a restricted
--     folder are readable by its members only (a manager adds themself, which
--     is audited). Readers upload only when "members can upload" is on.
--   * eureka.datahub_file / eureka.datahub_file_version: a named file in a
--     folder; uploading the same name again (case-insensitive) adds version
--     n+1. Each version is one eureka.file_object (0043), so the document-scan
--     worker job scans and promotes it unchanged (restricted folders: the
--     restricted prefix and KMS key). Files are soft-deleted by a manager or by
--     the user who uploaded every version.
--   * eureka.datahub_access: append-only log of every download link issued
--     (level copied; restricted rows carry the step-up grant), readable by the
--     folder's managers and org-wide audit:read.
--
-- Applicant accounts (no staff role, so no datahub:read) never see anything.
-- Rows hold names and descriptions; audit rows hold ids, levels and counts
-- only (rule 5). Writes only through the definer functions below, which
-- re-check permission and scope (rule 6). Every IF is NULL-safe (rule 1).
SET search_path = eureka, public;

SET ROLE eureka_owner;

CREATE TABLE eureka.datahub_folder (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id          uuid REFERENCES eureka.datahub_folder(id),
  name               text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80 AND name = btrim(name)
                       AND name !~ '[[:cntrl:]/\\]'),
  description        text CHECK (char_length(description) BETWEEN 1 AND 500
                       AND description !~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]'),
  level              text NOT NULL CHECK (level IN ('internal', 'confidential', 'restricted')),
  role_keys          text[] NOT NULL DEFAULT '{}',
  members_can_upload boolean NOT NULL DEFAULT false,
  location_id        uuid REFERENCES eureka.location(id),
  created_by         uuid NOT NULL REFERENCES eureka.app_user(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid NOT NULL REFERENCES eureka.app_user(id),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  row_version        integer NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  deleted_at         timestamptz,
  deleted_by         uuid REFERENCES eureka.app_user(id),
  CONSTRAINT datahub_folder_roles CHECK (
    (level = 'confidential') = (cardinality(role_keys) >= 1) AND cardinality(role_keys) <= 16
    AND array_position(role_keys, NULL) IS NULL),
  CONSTRAINT datahub_folder_deleted CHECK ((deleted_at IS NULL) = (deleted_by IS NULL)),
  CONSTRAINT datahub_folder_not_own_parent CHECK (parent_id IS DISTINCT FROM id)
);
CREATE UNIQUE INDEX datahub_folder_name ON eureka.datahub_folder
  (coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name)) WHERE deleted_at IS NULL;
-- Search by folder name (prefix with the index, else a contains match over the readable set).
CREATE INDEX datahub_folder_name_search ON eureka.datahub_folder (lower(name) text_pattern_ops) WHERE deleted_at IS NULL;

CREATE TABLE eureka.datahub_folder_member (
  folder_id uuid NOT NULL REFERENCES eureka.datahub_folder(id),
  user_id   uuid NOT NULL REFERENCES eureka.app_user(id),
  added_by  uuid NOT NULL REFERENCES eureka.app_user(id),
  added_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (folder_id, user_id)
);
CREATE INDEX datahub_folder_member_user ON eureka.datahub_folder_member (user_id);

CREATE TABLE eureka.datahub_file (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  folder_id      uuid NOT NULL REFERENCES eureka.datahub_folder(id),
  name           text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200 AND name = btrim(name)
                   AND name !~ '[[:cntrl:]/\\]' AND name NOT IN ('.', '..')),
  latest_version integer NOT NULL DEFAULT 1 CHECK (latest_version BETWEEN 1 AND 10000),
  created_by     uuid NOT NULL REFERENCES eureka.app_user(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  deleted_by     uuid REFERENCES eureka.app_user(id),
  CONSTRAINT datahub_file_deleted CHECK ((deleted_at IS NULL) = (deleted_by IS NULL))
);
CREATE UNIQUE INDEX datahub_file_name ON eureka.datahub_file (folder_id, lower(name)) WHERE deleted_at IS NULL;
-- Folder listing in name order (keyset) doubles as the prefix-search index within a folder.
CREATE INDEX datahub_file_name_search ON eureka.datahub_file (lower(name) text_pattern_ops) WHERE deleted_at IS NULL;

CREATE TABLE eureka.datahub_file_version (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id        uuid NOT NULL REFERENCES eureka.datahub_file(id),
  version        integer NOT NULL CHECK (version BETWEEN 1 AND 10000),
  file_object_id uuid NOT NULL UNIQUE REFERENCES eureka.file_object(id),
  uploaded_by    uuid NOT NULL REFERENCES eureka.app_user(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (file_id, version)
);
CREATE INDEX datahub_file_version_uploader ON eureka.datahub_file_version (uploaded_by, created_at);

CREATE TABLE eureka.datahub_access (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  folder_id        uuid NOT NULL REFERENCES eureka.datahub_folder(id),
  file_id          uuid NOT NULL REFERENCES eureka.datahub_file(id),
  version_id       uuid NOT NULL REFERENCES eureka.datahub_file_version(id),
  -- Copied, so a manager who cannot read the file still sees which version was opened.
  version          integer NOT NULL CHECK (version >= 1),
  user_id          uuid NOT NULL REFERENCES eureka.app_user(id),
  action           text NOT NULL CHECK (action IN ('download')),
  level            text NOT NULL CHECK (level IN ('internal', 'confidential', 'restricted')),
  -- Not a foreign key: the log outlives sessions and their grants (as document_access).
  step_up_grant_id uuid,
  at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT datahub_access_step_up CHECK (level <> 'restricted' OR step_up_grant_id IS NOT NULL)
);
CREATE INDEX datahub_access_folder ON eureka.datahub_access (folder_id, at DESC, id DESC);

-- ---------- write guards (rules 4 and 6) ----------

CREATE FUNCTION eureka.datahub_write_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF current_user IS DISTINCT FROM 'authz_definer' THEN
    RAISE EXCEPTION '% rows are written only by definer functions', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN
    -- Only membership rows are removed; everything else is soft-deleted or append-only.
    IF TG_TABLE_NAME = 'datahub_folder_member' THEN RETURN OLD; END IF;
    RAISE EXCEPTION '% rows are not deleted', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF TG_TABLE_NAME = 'datahub_folder' THEN
    IF TG_OP = 'INSERT' THEN
      NEW.created_by := authz.current_user_id();
      NEW.created_at := pg_catalog.now();
      NEW.updated_by := NEW.created_by;
      NEW.updated_at := NEW.created_at;
      NEW.row_version := 1;
      NEW.deleted_at := NULL;
      NEW.deleted_by := NULL;
      RETURN NEW;
    END IF;
    IF (NEW.id, NEW.parent_id, NEW.location_id, NEW.created_by, NEW.created_at)
       IS DISTINCT FROM (OLD.id, OLD.parent_id, OLD.location_id, OLD.created_by, OLD.created_at) THEN
      RAISE EXCEPTION 'column is immutable' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF OLD.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'a deleted folder is final' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.updated_by := authz.current_user_id();
    NEW.updated_at := pg_catalog.now();
    NEW.row_version := OLD.row_version + 1;
    IF NEW.deleted_at IS NOT NULL THEN
      NEW.deleted_at := pg_catalog.now();
      NEW.deleted_by := authz.current_user_id();
    END IF;
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'datahub_folder_member' THEN
    IF TG_OP = 'INSERT' THEN
      NEW.added_by := authz.current_user_id();
      NEW.added_at := pg_catalog.now();
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'membership rows are not changed' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF TG_TABLE_NAME = 'datahub_file' THEN
    IF TG_OP = 'INSERT' THEN
      NEW.created_by := authz.current_user_id();
      NEW.created_at := pg_catalog.now();
      NEW.updated_at := NEW.created_at;
      NEW.latest_version := 1;
      NEW.deleted_at := NULL;
      NEW.deleted_by := NULL;
      RETURN NEW;
    END IF;
    IF (NEW.id, NEW.folder_id, NEW.name, NEW.created_by, NEW.created_at)
       IS DISTINCT FROM (OLD.id, OLD.folder_id, OLD.name, OLD.created_by, OLD.created_at) THEN
      RAISE EXCEPTION 'column is immutable' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF OLD.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'a deleted file is final' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.latest_version IS DISTINCT FROM OLD.latest_version AND NEW.latest_version IS DISTINCT FROM OLD.latest_version + 1 THEN
      RAISE EXCEPTION 'versions only move forward by one' USING ERRCODE = 'check_violation';
    END IF;
    NEW.updated_at := pg_catalog.now();
    IF NEW.deleted_at IS NOT NULL THEN
      NEW.deleted_at := pg_catalog.now();
      NEW.deleted_by := authz.current_user_id();
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' AND TG_TABLE_NAME = 'datahub_file_version' THEN
    -- The version number is the file's latest (set by the same definer call) and its file is new.
    IF NOT EXISTS (SELECT 1 FROM eureka.datahub_file f WHERE f.id = NEW.file_id AND f.latest_version = NEW.version AND f.deleted_at IS NULL)
       OR NOT EXISTS (SELECT 1 FROM eureka.file_object o WHERE o.id = NEW.file_object_id AND o.status = 'pending') THEN
      RAISE EXCEPTION 'version does not match its file' USING ERRCODE = 'check_violation';
    END IF;
    NEW.uploaded_by := authz.current_user_id();
    NEW.created_at := pg_catalog.now();
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' AND TG_TABLE_NAME = 'datahub_access' THEN
    NEW.user_id := authz.current_user_id();
    NEW.at := pg_catalog.now();
    RETURN NEW;
  END IF;

  RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER datahub_folder_write_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.datahub_folder
  FOR EACH ROW EXECUTE FUNCTION eureka.datahub_write_guard();
CREATE TRIGGER datahub_folder_member_write_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.datahub_folder_member
  FOR EACH ROW EXECUTE FUNCTION eureka.datahub_write_guard();
CREATE TRIGGER datahub_file_write_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.datahub_file
  FOR EACH ROW EXECUTE FUNCTION eureka.datahub_write_guard();
CREATE TRIGGER datahub_file_version_write_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.datahub_file_version
  FOR EACH ROW EXECUTE FUNCTION eureka.datahub_write_guard();
CREATE TRIGGER datahub_access_write_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.datahub_access
  FOR EACH ROW EXECUTE FUNCTION eureka.datahub_write_guard();
-- No TRUNCATE from anyone (0043's helper refuses).
CREATE TRIGGER datahub_folder_no_truncate BEFORE TRUNCATE ON eureka.datahub_folder
  FOR EACH STATEMENT EXECUTE FUNCTION eureka.document_no_delete();
CREATE TRIGGER datahub_folder_member_no_truncate BEFORE TRUNCATE ON eureka.datahub_folder_member
  FOR EACH STATEMENT EXECUTE FUNCTION eureka.document_no_delete();
CREATE TRIGGER datahub_file_no_truncate BEFORE TRUNCATE ON eureka.datahub_file
  FOR EACH STATEMENT EXECUTE FUNCTION eureka.document_no_delete();
CREATE TRIGGER datahub_file_version_no_truncate BEFORE TRUNCATE ON eureka.datahub_file_version
  FOR EACH STATEMENT EXECUTE FUNCTION eureka.document_no_delete();
CREATE TRIGGER datahub_access_no_truncate BEFORE TRUNCATE ON eureka.datahub_access
  FOR EACH STATEMENT EXECUTE FUNCTION eureka.document_no_delete();

ALTER TABLE eureka.datahub_folder ENABLE ROW LEVEL SECURITY;        ALTER TABLE eureka.datahub_folder FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.datahub_folder_member ENABLE ROW LEVEL SECURITY; ALTER TABLE eureka.datahub_folder_member FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.datahub_file ENABLE ROW LEVEL SECURITY;          ALTER TABLE eureka.datahub_file FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.datahub_file_version ENABLE ROW LEVEL SECURITY;  ALTER TABLE eureka.datahub_file_version FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.datahub_access ENABLE ROW LEVEL SECURITY;        ALTER TABLE eureka.datahub_access FORCE ROW LEVEL SECURITY;

RESET ROLE;

REVOKE ALL ON eureka.datahub_folder, eureka.datahub_folder_member, eureka.datahub_file, eureka.datahub_file_version,
  eureka.datahub_access FROM PUBLIC;
REVOKE ALL ON FUNCTION eureka.datahub_write_guard() FROM PUBLIC;
GRANT SELECT ON eureka.datahub_folder, eureka.datahub_folder_member, eureka.datahub_file, eureka.datahub_file_version,
  eureka.datahub_access TO eureka_app;
GRANT SELECT, INSERT ON eureka.datahub_folder, eureka.datahub_folder_member, eureka.datahub_file, eureka.datahub_file_version,
  eureka.datahub_access TO authz_definer;
GRANT UPDATE (name, description, level, role_keys, members_can_upload, updated_by, updated_at, row_version, deleted_at, deleted_by)
  ON eureka.datahub_folder TO authz_definer;
GRANT UPDATE (latest_version, updated_at, deleted_at, deleted_by) ON eureka.datahub_file TO authz_definer;
GRANT DELETE ON eureka.datahub_folder_member TO authz_definer;
-- 0043 granted these; repeated so this migration stands alone.
GRANT SELECT, INSERT ON eureka.file_object TO authz_definer;
GRANT INSERT (actor_id, action, entity_type, entity_id, changes) ON eureka.audit_event TO authz_definer;
GRANT USAGE ON SEQUENCE eureka.audit_event_seq_seq TO authz_definer;

-- ---------- functions ----------
SET ROLE authz_definer;

-- Internal: the caller's current roles (active user, live grants).
CREATE FUNCTION authz.datahub_my_roles() RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce(pg_catalog.array_agg(DISTINCT ur.role_key), '{}')
  FROM eureka.user_role ur JOIN eureka.app_user u ON u.id = ur.user_id AND u.status = 'active'
  WHERE ur.user_id = authz.current_user_id() AND ur.valid @> pg_catalog.now()
$$;

-- Internal: whether a user is active staff (holds datahub:read through a live role).
CREATE FUNCTION authz.datahub_user_is_staff(p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT p_user IS NOT NULL AND EXISTS (
    SELECT 1 FROM eureka.user_role ur
    JOIN eureka.app_user u ON u.id = ur.user_id AND u.status = 'active'
    JOIN eureka.role_permission rp ON rp.role_key = ur.role_key AND rp.permission = 'datahub:read'
    WHERE ur.user_id = p_user AND ur.valid @> pg_catalog.now())
$$;

-- The folders whose files the caller may read (RLS, InitPlan: rule 3). A
-- subfolder needs its parent readable too.
CREATE FUNCTION authz.datahub_readable_folders() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH me AS (
    SELECT authz.current_user_id() AS id, authz.has_perm('datahub:read') AS staff, authz.datahub_my_roles() AS roles,
           authz.has_org('datahub:manage') AS org_mgr, authz.location_ids('datahub:manage') AS mgr_locs),
  f AS (
    SELECT x.id, x.parent_id,
      coalesce(me.staff AND (
        x.level = 'internal'
        OR (x.level = 'confidential' AND (x.role_keys && me.roles OR me.org_mgr OR x.location_id = ANY (me.mgr_locs)))
        OR (x.level = 'restricted' AND EXISTS (
              SELECT 1 FROM eureka.datahub_folder_member m WHERE m.folder_id = x.id AND m.user_id = me.id))), false) AS ok
    FROM eureka.datahub_folder x, me WHERE x.deleted_at IS NULL)
  SELECT coalesce(pg_catalog.array_agg(c.id), '{}') FROM f c LEFT JOIN f p ON p.id = c.parent_id
  WHERE c.ok AND (c.parent_id IS NULL OR coalesce(p.ok, false))
$$;

-- The folders the caller manages (datahub:manage at org scope, or at the
-- folder's location). Staff only.
CREATE FUNCTION authz.datahub_managed_folders() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH me AS (SELECT authz.has_perm('datahub:read') AS staff, authz.has_org('datahub:manage') AS org_mgr,
                     authz.location_ids('datahub:manage') AS mgr_locs)
  SELECT coalesce(pg_catalog.array_agg(x.id), '{}') FROM eureka.datahub_folder x, me
  WHERE x.deleted_at IS NULL AND me.staff AND (me.org_mgr OR x.location_id = ANY (me.mgr_locs))
$$;

-- The folders the caller sees in the folder panel: readable or managed.
CREATE FUNCTION authz.datahub_visible_folders() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT ARRAY(SELECT DISTINCT pg_catalog.unnest(authz.datahub_readable_folders() || authz.datahub_managed_folders()))
$$;

-- Internal: validation of a role key list for a confidential folder.
CREATE FUNCTION authz.datahub_valid_roles(p_roles text[]) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT p_roles IS NOT NULL AND pg_catalog.cardinality(p_roles) BETWEEN 1 AND 16
     AND pg_catalog.array_position(p_roles, NULL) IS NULL
     AND (SELECT pg_catalog.count(DISTINCT k) FROM pg_catalog.unnest(p_roles) k) = pg_catalog.cardinality(p_roles)
     AND NOT EXISTS (SELECT 1 FROM pg_catalog.unnest(p_roles) k WHERE NOT EXISTS (SELECT 1 FROM eureka.role r WHERE r.key = k))
$$;

-- Internal: adds members to a restricted folder (active staff only; audited).
CREATE FUNCTION authz.datahub_add_members(p_folder uuid, p_users uuid[]) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE u uuid; n integer := 0;
BEGIN
  FOREACH u IN ARRAY coalesce(p_users, '{}'::uuid[]) LOOP
    IF NOT coalesce(authz.datahub_user_is_staff(u), false) THEN
      RAISE EXCEPTION 'invalid_member' USING ERRCODE = 'check_violation';
    END IF;
    INSERT INTO eureka.datahub_folder_member (folder_id, user_id, added_by) VALUES (p_folder, u, authz.current_user_id())
    ON CONFLICT DO NOTHING;
    IF FOUND THEN
      n := n + 1;
      INSERT INTO eureka.audit_event (actor_id, action, entity_type, entity_id, changes)
      VALUES (authz.current_user_id(), 'datahub.member_added', 'datahub_folder', p_folder,
              pg_catalog.jsonb_build_object('userId', u));
    END IF;
  END LOOP;
  RETURN n;
END $$;

-- API: creates a folder. Needs datahub:manage covering the new folder: org
-- scope for an organisation-wide folder, or the folder's location; a
-- subfolder takes its parent's location and needs the parent managed. One
-- level of subfolders only. Audited: ids, level and counts.
CREATE FUNCTION authz.datahub_create_folder(
  p_parent uuid, p_name text, p_description text, p_level text, p_roles text[], p_members uuid[],
  p_members_can_upload boolean, p_location uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE par record; loc uuid; f_id uuid; nmembers integer := 0;
BEGIN
  IF authz.current_user_id() IS NULL OR NOT coalesce(authz.has_perm('datahub:read'), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT coalesce(authz.has_perm('datahub:manage'), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_parent IS NOT NULL THEN
    SELECT x.id, x.parent_id, x.location_id INTO par FROM eureka.datahub_folder x WHERE x.id = p_parent AND x.deleted_at IS NULL;
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
  ELSE
    loc := p_location;
    IF loc IS NULL AND NOT coalesce(authz.has_org('datahub:manage'), false) THEN
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

-- API: changes a folder's settings (any of name, description, level,
-- roleKeys, membersCanUpload) with optimistic concurrency on row_version
-- ('stale'). Needs the folder managed. Lowering a folder from restricted drops
-- its member list (it no longer applies); raising to restricted starts empty
-- unless members are named. Returns the new row_version. Audited.
CREATE FUNCTION authz.datahub_update_folder(p_folder uuid, p_row_version integer, p_changes jsonb, p_members uuid[])
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  f eureka.datahub_folder%ROWTYPE;
  n_name text; n_desc text; n_level text; n_roles text[]; n_upload boolean; v integer; dropped integer := 0; added integer := 0;
  changed text[] := '{}';
BEGIN
  IF authz.current_user_id() IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO f FROM eureka.datahub_folder x WHERE x.id = p_folder AND x.deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND OR NOT (p_folder = ANY (authz.datahub_visible_folders())) THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT (p_folder = ANY (authz.datahub_managed_folders())) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_row_version IS NULL OR p_row_version IS DISTINCT FROM f.row_version THEN
    RAISE EXCEPTION 'stale' USING ERRCODE = 'serialization_failure';
  END IF;
  IF p_changes IS NULL OR pg_catalog.jsonb_typeof(p_changes) IS DISTINCT FROM 'object'
     OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_object_keys(p_changes) k
                WHERE k NOT IN ('name', 'description', 'level', 'roleKeys', 'membersCanUpload')) THEN
    RAISE EXCEPTION 'invalid_folder' USING ERRCODE = 'check_violation';
  END IF;
  n_name := CASE WHEN p_changes ? 'name' THEN p_changes->>'name' ELSE f.name END;
  n_desc := CASE WHEN p_changes ? 'description' THEN p_changes->>'description' ELSE f.description END;
  n_level := CASE WHEN p_changes ? 'level' THEN p_changes->>'level' ELSE f.level END;
  n_upload := CASE WHEN p_changes ? 'membersCanUpload' THEN (p_changes->>'membersCanUpload')::boolean ELSE f.members_can_upload END;
  IF p_changes ? 'roleKeys' THEN
    IF pg_catalog.jsonb_typeof(p_changes->'roleKeys') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'invalid_roles' USING ERRCODE = 'check_violation';
    END IF;
    n_roles := ARRAY(SELECT pg_catalog.jsonb_array_elements_text(p_changes->'roleKeys'));
  ELSE
    n_roles := CASE WHEN n_level = 'confidential' THEN f.role_keys ELSE '{}' END;
  END IF;
  IF n_level IS NULL OR n_level NOT IN ('internal', 'confidential', 'restricted') THEN
    RAISE EXCEPTION 'invalid_level' USING ERRCODE = 'check_violation';
  END IF;
  IF n_level = 'confidential' AND NOT coalesce(authz.datahub_valid_roles(n_roles), false) THEN
    RAISE EXCEPTION 'invalid_roles' USING ERRCODE = 'check_violation';
  END IF;
  IF n_level <> 'confidential' AND pg_catalog.cardinality(n_roles) > 0 THEN
    RAISE EXCEPTION 'invalid_roles' USING ERRCODE = 'check_violation';
  END IF;
  IF n_level <> 'restricted' AND pg_catalog.cardinality(coalesce(p_members, '{}')) > 0 THEN
    RAISE EXCEPTION 'invalid_member' USING ERRCODE = 'check_violation';
  END IF;
  IF n_upload IS NULL OR n_name IS NULL
     OR NOT coalesce(char_length(n_name) BETWEEN 1 AND 80 AND n_name = btrim(n_name) AND n_name !~ '[[:cntrl:]/\\]', false)
     OR NOT coalesce(n_desc IS NULL OR (char_length(n_desc) BETWEEN 1 AND 500 AND n_desc !~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]'), false) THEN
    RAISE EXCEPTION 'invalid_folder' USING ERRCODE = 'check_violation';
  END IF;
  IF lower(n_name) IS DISTINCT FROM lower(f.name) THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('datahub:folder:' || coalesce(f.parent_id::text, 'root'), 0));
    IF EXISTS (SELECT 1 FROM eureka.datahub_folder x WHERE x.parent_id IS NOT DISTINCT FROM f.parent_id
                AND lower(x.name) = lower(n_name) AND x.deleted_at IS NULL AND x.id <> f.id) THEN
      RAISE EXCEPTION 'name_taken' USING ERRCODE = 'unique_violation';
    END IF;
  END IF;
  IF n_name IS DISTINCT FROM f.name THEN changed := pg_catalog.array_append(changed, 'name'); END IF;
  IF n_desc IS DISTINCT FROM f.description THEN changed := pg_catalog.array_append(changed, 'description'); END IF;
  IF n_level IS DISTINCT FROM f.level THEN changed := pg_catalog.array_append(changed, 'level'); END IF;
  IF n_roles IS DISTINCT FROM f.role_keys THEN changed := pg_catalog.array_append(changed, 'roleKeys'); END IF;
  IF n_upload IS DISTINCT FROM f.members_can_upload THEN changed := pg_catalog.array_append(changed, 'membersCanUpload'); END IF;

  UPDATE eureka.datahub_folder SET name = n_name, description = n_desc, level = n_level, role_keys = n_roles,
    members_can_upload = n_upload
  WHERE id = p_folder RETURNING row_version INTO v;
  IF f.level = 'restricted' AND n_level <> 'restricted' THEN
    DELETE FROM eureka.datahub_folder_member m WHERE m.folder_id = p_folder;
    GET DIAGNOSTICS dropped = ROW_COUNT;
  END IF;
  INSERT INTO eureka.audit_event (actor_id, action, entity_type, entity_id, changes)
  VALUES (authz.current_user_id(), 'datahub.folder_updated', 'datahub_folder', p_folder, pg_catalog.jsonb_build_object(
    'changed', pg_catalog.to_jsonb(changed), 'fromLevel', f.level, 'level', n_level,
    'roleCount', pg_catalog.cardinality(n_roles), 'membersCanUpload', n_upload, 'membersDropped', dropped, 'rowVersion', v));
  IF n_level = 'restricted' THEN
    added := authz.datahub_add_members(p_folder, p_members);
  END IF;
  RETURN v;
END $$;

-- API: adds or removes one member of a restricted folder (datahub:manage
-- covering the folder). Adding needs an active staff user. Idempotent;
-- returns whether anything changed. Audited (ids only).
CREATE FUNCTION authz.datahub_set_member(p_folder uuid, p_user uuid, p_member boolean)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE f record; n integer;
BEGIN
  IF authz.current_user_id() IS NULL OR p_member IS NULL OR p_user IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT x.id, x.level INTO f FROM eureka.datahub_folder x WHERE x.id = p_folder AND x.deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND OR NOT (p_folder = ANY (authz.datahub_visible_folders())) THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT (p_folder = ANY (authz.datahub_managed_folders())) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF f.level IS DISTINCT FROM 'restricted' THEN
    RAISE EXCEPTION 'not_restricted' USING ERRCODE = 'check_violation';
  END IF;
  IF p_member THEN
    RETURN authz.datahub_add_members(p_folder, ARRAY[p_user]) > 0;
  END IF;
  DELETE FROM eureka.datahub_folder_member m WHERE m.folder_id = p_folder AND m.user_id = p_user;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    INSERT INTO eureka.audit_event (actor_id, action, entity_type, entity_id, changes)
    VALUES (authz.current_user_id(), 'datahub.member_removed', 'datahub_folder', p_folder, pg_catalog.jsonb_build_object('userId', p_user));
  END IF;
  RETURN n > 0;
END $$;

-- API: soft-deletes an empty folder (no live files, no live subfolders) the
-- caller manages, with optimistic concurrency. Audited.
CREATE FUNCTION authz.datahub_delete_folder(p_folder uuid, p_row_version integer)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE f eureka.datahub_folder%ROWTYPE;
BEGIN
  IF authz.current_user_id() IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO f FROM eureka.datahub_folder x WHERE x.id = p_folder AND x.deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND OR NOT (p_folder = ANY (authz.datahub_visible_folders())) THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT (p_folder = ANY (authz.datahub_managed_folders())) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_row_version IS NULL OR p_row_version IS DISTINCT FROM f.row_version THEN
    RAISE EXCEPTION 'stale' USING ERRCODE = 'serialization_failure';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('datahub:folder:' || p_folder::text, 0));
  IF EXISTS (SELECT 1 FROM eureka.datahub_file x WHERE x.folder_id = p_folder AND x.deleted_at IS NULL)
     OR EXISTS (SELECT 1 FROM eureka.datahub_folder x WHERE x.parent_id = p_folder AND x.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'folder_not_empty' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE eureka.datahub_folder SET deleted_at = pg_catalog.now(), deleted_by = authz.current_user_id() WHERE id = p_folder;
  INSERT INTO eureka.audit_event (actor_id, action, entity_type, entity_id, changes)
  VALUES (authz.current_user_id(), 'datahub.folder_deleted', 'datahub_folder', p_folder,
          pg_catalog.jsonb_build_object('level', f.level, 'parentId', f.parent_id));
END $$;

-- API: a pending upload into a folder. The folder must be readable (404) and
-- the caller a manager of it or, with "members can upload" on, a reader (403).
-- A live file of the same name (case-insensitive) gets version n+1; otherwise
-- a new file. The file's classification follows the folder level now
-- (restricted -> restricted storage). The name's extension must match the
-- content type. At most ten pending DataHub uploads per user (409). Audited:
-- ids, level, version, type and size; never the name.
CREATE FUNCTION authz.datahub_create_upload(p_folder uuid, p_name text, p_content_type text, p_size integer)
RETURNS TABLE (file_id uuid, version_id uuid, version integer, file_object_id uuid, classification text, upload_expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  f record; cls text; ext text; fl record; fid uuid; ver integer; o_id uuid; o_exp timestamptz; v_id uuid;
BEGIN
  IF authz.current_user_id() IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT x.id, x.level, x.members_can_upload INTO f FROM eureka.datahub_folder x WHERE x.id = p_folder AND x.deleted_at IS NULL;
  IF NOT FOUND OR NOT (p_folder = ANY (authz.datahub_readable_folders())) THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT coalesce(f.members_can_upload OR p_folder = ANY (authz.datahub_managed_folders()), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  ext := lower(substring(coalesce(p_name, '') FROM '\.([A-Za-z0-9]{1,8})$'));
  IF p_content_type IS NULL OR p_size IS NULL OR p_name IS NULL
     OR NOT coalesce(p_size BETWEEN 1 AND 15728640, false)
     OR NOT coalesce(char_length(p_name) BETWEEN 1 AND 200 AND p_name = btrim(p_name) AND p_name !~ '[[:cntrl:]/\\]', false)
     OR NOT coalesce(
          (p_content_type = 'application/pdf' AND ext = 'pdf')
       OR (p_content_type = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' AND ext = 'docx')
       OR (p_content_type = 'image/png' AND ext = 'png')
       OR (p_content_type = 'image/jpeg' AND ext IN ('jpg', 'jpeg')), false) THEN
    RAISE EXCEPTION 'invalid_upload' USING ERRCODE = 'check_violation';
  END IF;
  cls := CASE WHEN f.level = 'restricted' THEN 'restricted' ELSE 'internal' END;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('datahub:upload:' || authz.current_user_id()::text, 0));
  IF (SELECT pg_catalog.count(*) FROM eureka.datahub_file_version v JOIN eureka.file_object o ON o.id = v.file_object_id
       WHERE v.uploaded_by = authz.current_user_id() AND o.status = 'pending') >= 10 THEN
    RAISE EXCEPTION 'too_many_pending' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('datahub:folder:' || p_folder::text, 0));
  SELECT x.id, x.latest_version INTO fl FROM eureka.datahub_file x
   WHERE x.folder_id = p_folder AND lower(x.name) = lower(p_name) AND x.deleted_at IS NULL FOR UPDATE;
  IF FOUND THEN
    IF fl.latest_version >= 10000 THEN
      RAISE EXCEPTION 'invalid_upload' USING ERRCODE = 'check_violation';
    END IF;
    fid := fl.id; ver := fl.latest_version + 1;
    UPDATE eureka.datahub_file SET latest_version = ver WHERE id = fid;
  ELSE
    INSERT INTO eureka.datahub_file AS x (folder_id, name, created_by) VALUES (p_folder, p_name, authz.current_user_id())
    RETURNING x.id, x.latest_version INTO fid, ver;
  END IF;
  INSERT INTO eureka.file_object AS o (classification, content_type, size_bytes, uploaded_by, upload_expires_at)
  VALUES (cls, p_content_type, p_size, authz.current_user_id(), pg_catalog.now())
  RETURNING o.id, o.upload_expires_at INTO o_id, o_exp;
  INSERT INTO eureka.datahub_file_version AS v (file_id, version, file_object_id, uploaded_by)
  VALUES (fid, ver, o_id, authz.current_user_id())
  RETURNING v.id INTO v_id;
  INSERT INTO eureka.audit_event (actor_id, action, entity_type, entity_id, changes)
  VALUES (authz.current_user_id(), 'datahub.upload_requested', 'datahub_file', fid, pg_catalog.jsonb_build_object(
    'folderId', p_folder, 'versionId', v_id, 'version', ver, 'fileObjectId', o_id, 'level', f.level,
    'classification', cls, 'contentType', p_content_type, 'sizeBytes', p_size));
  RETURN QUERY SELECT fid, v_id, ver, o_id, cls, o_exp;
END $$;

-- API: soft-deletes a file (all its versions) in a readable folder: a
-- manager of the folder, or the user who uploaded every version. Audited.
CREATE FUNCTION authz.datahub_delete_file(p_file uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE fl record; nver integer;
BEGIN
  IF authz.current_user_id() IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT x.id, x.folder_id, x.latest_version INTO fl FROM eureka.datahub_file x WHERE x.id = p_file AND x.deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND OR NOT (fl.folder_id = ANY (authz.datahub_readable_folders())) THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT (fl.folder_id = ANY (authz.datahub_managed_folders()))
     AND EXISTS (SELECT 1 FROM eureka.datahub_file_version v WHERE v.file_id = p_file AND v.uploaded_by IS DISTINCT FROM authz.current_user_id()) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE eureka.datahub_file SET deleted_at = pg_catalog.now(), deleted_by = authz.current_user_id() WHERE id = p_file;
  SELECT pg_catalog.count(*) INTO nver FROM eureka.datahub_file_version v WHERE v.file_id = p_file;
  INSERT INTO eureka.audit_event (actor_id, action, entity_type, entity_id, changes)
  VALUES (authz.current_user_id(), 'datahub.file_deleted', 'datahub_file', p_file,
          pg_catalog.jsonb_build_object('folderId', fl.folder_id, 'versionCount', nver));
END $$;

-- API: authorizes one download of a file version and logs it (access log +
-- audit, same transaction). Not readable -> not_found. A restricted folder
-- (or a file stored as restricted) needs a live step-up grant of the caller's
-- session -> 'step_up_required' (refusal audited). File not clean ->
-- 'not_available'. 'ok' returns what the API needs to sign the link.
CREATE FUNCTION authz.datahub_download(p_version uuid, p_session bytea)
RETURNS TABLE (outcome text, file_object_id uuid, classification text, content_type text, version integer, access_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE d record; g_id uuid; a_id uuid; strict_level boolean;
BEGIN
  IF authz.current_user_id() IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT v.id, v.file_id, v.version, v.file_object_id, x.folder_id, fo.level, o.classification, o.status, o.content_type INTO d
    FROM eureka.datahub_file_version v
    JOIN eureka.datahub_file x ON x.id = v.file_id AND x.deleted_at IS NULL
    JOIN eureka.datahub_folder fo ON fo.id = x.folder_id AND fo.deleted_at IS NULL
    JOIN eureka.file_object o ON o.id = v.file_object_id
   WHERE v.id = p_version;
  IF NOT FOUND OR NOT (d.folder_id = ANY (authz.datahub_readable_folders())) THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'no_data_found';
  END IF;
  strict_level := d.level = 'restricted' OR d.classification = 'restricted';
  IF strict_level THEN
    SELECT s.grant_id INTO g_id FROM authz.step_up_current(p_session) s;
    IF g_id IS NULL THEN
      INSERT INTO eureka.audit_event (actor_id, action, entity_type, entity_id, changes)
      VALUES (authz.current_user_id(), 'datahub.view_refused', 'datahub_file', d.file_id, pg_catalog.jsonb_build_object(
        'folderId', d.folder_id, 'versionId', d.id, 'level', d.level, 'reason', 'step_up_required'));
      RETURN QUERY SELECT 'step_up_required'::text, NULL::uuid, d.classification, NULL::text, d.version, NULL::uuid;
      RETURN;
    END IF;
  END IF;
  IF d.status IS DISTINCT FROM 'clean' THEN
    RETURN QUERY SELECT 'not_available'::text, NULL::uuid, d.classification, NULL::text, d.version, NULL::uuid;
    RETURN;
  END IF;
  INSERT INTO eureka.datahub_access AS a (folder_id, file_id, version_id, version, user_id, action, level, step_up_grant_id)
  VALUES (d.folder_id, d.file_id, d.id, d.version, authz.current_user_id(), 'download',
          CASE WHEN strict_level THEN 'restricted' ELSE d.level END, g_id)
  RETURNING a.id INTO a_id;
  INSERT INTO eureka.audit_event (actor_id, action, entity_type, entity_id, changes)
  VALUES (authz.current_user_id(), CASE WHEN strict_level THEN 'datahub.viewed' ELSE 'datahub.downloaded' END,
          'datahub_file', d.file_id, pg_catalog.jsonb_build_object(
            'folderId', d.folder_id, 'versionId', d.id, 'version', d.version, 'fileObjectId', d.file_object_id,
            'level', d.level, 'accessId', a_id, 'stepUpGrantId', g_id));
  RETURN QUERY SELECT 'ok'::text, d.file_object_id, d.classification, d.content_type, d.version, a_id;
END $$;

RESET ROLE;

-- ---------- RLS (rule 3: folder sets as InitPlans; versions and files by key) ----------
SET ROLE eureka_owner;

CREATE POLICY datahub_folder_read ON eureka.datahub_folder FOR SELECT TO eureka_app USING (
  deleted_at IS NULL AND id = ANY ((SELECT authz.datahub_visible_folders())::uuid[])
);
CREATE POLICY datahub_folder_member_read ON eureka.datahub_folder_member FOR SELECT TO eureka_app USING (
  user_id = (SELECT authz.current_user_id())
  OR folder_id = ANY ((SELECT authz.datahub_managed_folders())::uuid[])
);
CREATE POLICY datahub_file_read ON eureka.datahub_file FOR SELECT TO eureka_app USING (
  deleted_at IS NULL AND folder_id = ANY ((SELECT authz.datahub_readable_folders())::uuid[])
);
CREATE POLICY datahub_file_version_read ON eureka.datahub_file_version FOR SELECT TO eureka_app USING (
  EXISTS (SELECT 1 FROM eureka.datahub_file f WHERE f.id = datahub_file_version.file_id)
);
CREATE POLICY datahub_access_read ON eureka.datahub_access FOR SELECT TO eureka_app USING (
  (SELECT authz.has_org('audit:read'))
  OR folder_id = ANY ((SELECT authz.datahub_managed_folders())::uuid[])
);
-- A DataHub file object is readable with its version (unique file_object_id: a key probe).
CREATE POLICY file_object_read_datahub ON eureka.file_object FOR SELECT TO eureka_app USING (
  EXISTS (SELECT 1 FROM eureka.datahub_file_version v WHERE v.file_object_id = file_object.id)
);

CREATE POLICY definer_read   ON eureka.datahub_folder FOR SELECT TO authz_definer USING (true);
CREATE POLICY definer_insert ON eureka.datahub_folder FOR INSERT TO authz_definer WITH CHECK (true);
CREATE POLICY definer_update ON eureka.datahub_folder FOR UPDATE TO authz_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_read   ON eureka.datahub_folder_member FOR SELECT TO authz_definer USING (true);
CREATE POLICY definer_insert ON eureka.datahub_folder_member FOR INSERT TO authz_definer WITH CHECK (true);
CREATE POLICY definer_delete ON eureka.datahub_folder_member FOR DELETE TO authz_definer USING (true);
CREATE POLICY definer_read   ON eureka.datahub_file FOR SELECT TO authz_definer USING (true);
CREATE POLICY definer_insert ON eureka.datahub_file FOR INSERT TO authz_definer WITH CHECK (true);
CREATE POLICY definer_update ON eureka.datahub_file FOR UPDATE TO authz_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_read   ON eureka.datahub_file_version FOR SELECT TO authz_definer USING (true);
CREATE POLICY definer_insert ON eureka.datahub_file_version FOR INSERT TO authz_definer WITH CHECK (true);
CREATE POLICY definer_read   ON eureka.datahub_access FOR SELECT TO authz_definer USING (true);
CREATE POLICY definer_insert ON eureka.datahub_access FOR INSERT TO authz_definer WITH CHECK (true);

-- The definer functions above write their own audit rows (actor = caller; ids, levels, counts).
CREATE POLICY datahub_definer_audit ON eureka.audit_event FOR INSERT TO authz_definer WITH CHECK (
  actor_id IS NOT NULL AND actor_id = authz.current_user_id()
  AND action IN ('datahub.folder_created', 'datahub.folder_updated', 'datahub.folder_deleted', 'datahub.member_added',
                 'datahub.member_removed', 'datahub.upload_requested', 'datahub.file_deleted', 'datahub.downloaded',
                 'datahub.viewed', 'datahub.view_refused'));

RESET ROLE;

-- Rule 2: no PUBLIC execute; each function to exactly the role that calls it.
-- The three folder-set functions run inside eureka_app's RLS policies and API queries.
REVOKE ALL ON FUNCTION authz.datahub_my_roles() FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.datahub_user_is_staff(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.datahub_readable_folders() FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.datahub_managed_folders() FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.datahub_visible_folders() FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.datahub_valid_roles(text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.datahub_add_members(uuid, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.datahub_create_folder(uuid, text, text, text, text[], uuid[], boolean, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.datahub_update_folder(uuid, integer, jsonb, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.datahub_set_member(uuid, uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.datahub_delete_folder(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.datahub_create_upload(uuid, text, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.datahub_delete_file(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.datahub_download(uuid, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.datahub_readable_folders() TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.datahub_managed_folders() TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.datahub_visible_folders() TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.datahub_create_folder(uuid, text, text, text, text[], uuid[], boolean, uuid) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.datahub_update_folder(uuid, integer, jsonb, uuid[]) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.datahub_set_member(uuid, uuid, boolean) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.datahub_delete_folder(uuid, integer) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.datahub_create_upload(uuid, text, text, integer) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.datahub_delete_file(uuid) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.datahub_download(uuid, bytea) TO eureka_app;
