-- authz.role_create: current definition (repeatable; db/functions/README.md).
-- An admin creates a custom role by cloning another role's grants and traits
-- (docs/roles-api.md). Returns the new key (c_<slug of the label>). Raises
-- not_permitted, unknown_role, role_archived (source), invalid_label, role_exists,
-- unknown_department. The API writes the audit row in the same transaction.

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.role_create(p_label text, p_clone_from text, p_description text, p_department uuid, p_track text, p_level integer)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE actor uuid; src record; lbl text; k text; base text; n integer := 1;
BEGIN
  actor := authz.admin_guard(NULL);
  lbl := pg_catalog.btrim(coalesce(p_label, ''));
  IF lbl = '' OR pg_catalog.char_length(lbl) > 80 OR lbl ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'invalid_label' USING ERRCODE = 'check_violation';
  END IF;
  SELECT ro.* INTO src FROM eureka.role ro WHERE ro.key = p_clone_from;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown_role' USING ERRCODE = 'check_violation';
  END IF;
  IF src.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'role_archived' USING ERRCODE = 'check_violation';
  END IF;
  IF p_department IS NOT NULL AND NOT EXISTS (SELECT 1 FROM eureka.department d WHERE d.id = p_department) THEN
    RAISE EXCEPTION 'unknown_department' USING ERRCODE = 'check_violation';
  END IF;
  -- Creates of one label serialise on the label; the live-label index is the backstop.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('role_label:' || pg_catalog.lower(lbl), 0));
  IF EXISTS (SELECT 1 FROM eureka.role ro WHERE pg_catalog.lower(ro.label) = pg_catalog.lower(lbl) AND ro.archived_at IS NULL) THEN
    RAISE EXCEPTION 'role_exists' USING ERRCODE = 'unique_violation';
  END IF;
  base := 'c_' || pg_catalog.left(pg_catalog.btrim(pg_catalog.regexp_replace(pg_catalog.lower(lbl), '[^a-z0-9]+', '_', 'g'), '_'), 56);
  IF base = 'c_' THEN base := 'c_role'; END IF;
  k := base;
  WHILE EXISTS (SELECT 1 FROM eureka.role ro WHERE ro.key = k) LOOP
    n := n + 1;
    k := base || '_' || n::text;
  END LOOP;
  INSERT INTO eureka.role (key, label, description, is_sales, is_location_bound, is_admin, is_recruiter, is_coach,
                           track, level, department_id, cloned_from, created_by)
  VALUES (k, lbl, nullif(pg_catalog.btrim(coalesce(p_description, '')), ''), src.is_sales, src.is_location_bound,
          src.is_admin, src.is_recruiter, src.is_coach,
          coalesce(p_track, src.track), coalesce(p_level, src.level), p_department, src.key, actor);
  INSERT INTO eureka.role_permission (role_key, permission, scope)
  SELECT k, rp.permission, rp.scope FROM eureka.role_permission rp WHERE rp.role_key = src.key;
  RETURN k;
END $function$;

REVOKE ALL ON FUNCTION authz.role_create(text, text, text, uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.role_create(text, text, text, uuid, text, integer) TO eureka_app;
RESET ROLE;
