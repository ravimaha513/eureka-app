-- authz.role_update: current definition (repeatable; db/functions/README.md).
-- An admin edits a custom role (docs/roles-api.md). p_patch is a JSON object whose
-- present keys change: label, description, track, level, departmentId, traits
-- {sales, locationBound, admin, recruiter, coach}. Returns the changed field names.
-- Label, description, track and level change freely; traits and the department only
-- while nobody holds the role (role_in_use), since the holders' access facts
-- (location ids, separation of duties, coach assignments) depend on them.
-- Raises not_permitted, unknown_role, system_role, role_archived, invalid_label,
-- role_exists, invalid_track, invalid_level, unknown_department, role_in_use.

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.role_update(p_key text, p_patch jsonb)
 RETURNS text[]
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE r record; changed text[] := '{}'; lbl text; tr jsonb; dep uuid; held boolean;
BEGIN
  PERFORM authz.admin_guard(NULL);
  SELECT ro.* INTO r FROM eureka.role ro WHERE ro.key = p_key FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown_role' USING ERRCODE = 'no_data_found';
  END IF;
  IF r.is_system THEN
    RAISE EXCEPTION 'system_role' USING ERRCODE = 'check_violation';
  END IF;
  IF r.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'role_archived' USING ERRCODE = 'check_violation';
  END IF;
  held := EXISTS (SELECT 1 FROM eureka.user_role ur WHERE ur.role_key = p_key AND ur.valid @> pg_catalog.now());

  IF p_patch ? 'label' THEN
    lbl := pg_catalog.btrim(coalesce(p_patch ->> 'label', ''));
    IF lbl = '' OR pg_catalog.char_length(lbl) > 80 OR lbl ~ '[[:cntrl:]]' THEN
      RAISE EXCEPTION 'invalid_label' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM eureka.role ro WHERE pg_catalog.lower(ro.label) = pg_catalog.lower(lbl)
               AND ro.archived_at IS NULL AND ro.key <> p_key) THEN
      RAISE EXCEPTION 'role_exists' USING ERRCODE = 'unique_violation';
    END IF;
    UPDATE eureka.role SET label = lbl WHERE key = p_key;
    changed := changed || 'label'::text;
  END IF;
  IF p_patch ? 'description' THEN
    IF pg_catalog.char_length(coalesce(p_patch ->> 'description', '')) > 500 THEN
      RAISE EXCEPTION 'invalid_description' USING ERRCODE = 'check_violation';
    END IF;
    UPDATE eureka.role SET description = nullif(pg_catalog.btrim(coalesce(p_patch ->> 'description', '')), '') WHERE key = p_key;
    changed := changed || 'description'::text;
  END IF;
  IF p_patch ? 'track' THEN
    IF coalesce(p_patch ->> 'track', '') !~ '^[a-z][a-z0-9_]{0,39}$' THEN
      RAISE EXCEPTION 'invalid_track' USING ERRCODE = 'check_violation';
    END IF;
    UPDATE eureka.role SET track = p_patch ->> 'track' WHERE key = p_key;
    changed := changed || 'track'::text;
  END IF;
  IF p_patch ? 'level' THEN
    IF pg_catalog.jsonb_typeof(p_patch -> 'level') <> 'number' OR (p_patch ->> 'level')::numeric NOT BETWEEN 1 AND 20
       OR (p_patch ->> 'level')::numeric <> pg_catalog.floor((p_patch ->> 'level')::numeric) THEN
      RAISE EXCEPTION 'invalid_level' USING ERRCODE = 'check_violation';
    END IF;
    UPDATE eureka.role SET level = (p_patch ->> 'level')::integer WHERE key = p_key;
    changed := changed || 'level'::text;
  END IF;
  IF p_patch ? 'departmentId' THEN
    dep := nullif(p_patch ->> 'departmentId', '')::uuid;
    IF dep IS NOT NULL AND NOT EXISTS (SELECT 1 FROM eureka.department d WHERE d.id = dep) THEN
      RAISE EXCEPTION 'unknown_department' USING ERRCODE = 'check_violation';
    END IF;
    IF dep IS DISTINCT FROM r.department_id THEN
      IF held THEN
        RAISE EXCEPTION 'role_in_use' USING ERRCODE = 'check_violation';
      END IF;
      UPDATE eureka.role SET department_id = dep WHERE key = p_key;
      changed := changed || 'departmentId'::text;
    END IF;
  END IF;
  IF p_patch ? 'traits' THEN
    tr := p_patch -> 'traits';
    IF pg_catalog.jsonb_typeof(tr) <> 'object' THEN
      RAISE EXCEPTION 'invalid_traits' USING ERRCODE = 'check_violation';
    END IF;
    IF coalesce((tr ->> 'sales')::boolean, r.is_sales) IS DISTINCT FROM r.is_sales
       OR coalesce((tr ->> 'locationBound')::boolean, r.is_location_bound) IS DISTINCT FROM r.is_location_bound
       OR coalesce((tr ->> 'admin')::boolean, r.is_admin) IS DISTINCT FROM r.is_admin
       OR coalesce((tr ->> 'recruiter')::boolean, r.is_recruiter) IS DISTINCT FROM r.is_recruiter
       OR coalesce((tr ->> 'coach')::boolean, r.is_coach) IS DISTINCT FROM r.is_coach THEN
      IF held THEN
        RAISE EXCEPTION 'role_in_use' USING ERRCODE = 'check_violation';
      END IF;
      -- A location-bound role's grants carry a location; the location scope needs it (docs/roles-api.md).
      IF NOT coalesce((tr ->> 'locationBound')::boolean, r.is_location_bound)
         AND EXISTS (SELECT 1 FROM eureka.role_permission rp WHERE rp.role_key = p_key AND rp.scope = 'location') THEN
        RAISE EXCEPTION 'location_scope_needs_location' USING ERRCODE = 'check_violation';
      END IF;
      UPDATE eureka.role SET
        is_sales = coalesce((tr ->> 'sales')::boolean, is_sales),
        is_location_bound = coalesce((tr ->> 'locationBound')::boolean, is_location_bound),
        is_admin = coalesce((tr ->> 'admin')::boolean, is_admin),
        is_recruiter = coalesce((tr ->> 'recruiter')::boolean, is_recruiter),
        is_coach = coalesce((tr ->> 'coach')::boolean, is_coach)
      WHERE key = p_key;
      changed := changed || 'traits'::text;
    END IF;
  END IF;
  RETURN changed;
END $function$;

REVOKE ALL ON FUNCTION authz.role_update(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.role_update(text, jsonb) TO eureka_app;
RESET ROLE;
