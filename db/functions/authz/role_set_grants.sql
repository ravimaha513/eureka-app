-- authz.role_set_grants: current definition (repeatable; db/functions/README.md).
-- An admin replaces a custom role's grants (docs/roles-api.md): p_grants is a JSON
-- object permission -> scope (null removes). Returns {added, removed, changed}
-- permission keys for the audit row. Raises not_permitted, unknown_role,
-- system_role, role_archived, unknown_permission, invalid_scope,
-- location_scope_needs_location, and role_in_use when the change would add a
-- restricted permission (or an org-sensitive one at org scope) while the role has
-- holders: a new role and a fresh grant go through the second approver (AD-3).

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.role_set_grants(p_key text, p_grants jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE r record; held boolean; added text[]; removed text[]; changed text[];
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
  IF pg_catalog.jsonb_typeof(p_grants) <> 'object' THEN
    RAISE EXCEPTION 'invalid_grants' USING ERRCODE = 'check_violation';
  END IF;

  -- Wanted grants: the object's non-null entries.
  IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_each_text(p_grants) w WHERE w.value IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM eureka.permission p WHERE p.key = w.key)) THEN
    RAISE EXCEPTION 'unknown_permission' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_each_text(p_grants) w WHERE w.value IS NOT NULL
             AND w.value NOT IN ('own','team','coached','coached_hierarchy','hierarchy','location','org')) THEN
    RAISE EXCEPTION 'invalid_scope' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT r.is_location_bound AND EXISTS (SELECT 1 FROM pg_catalog.jsonb_each_text(p_grants) w WHERE w.value = 'location') THEN
    RAISE EXCEPTION 'location_scope_needs_location' USING ERRCODE = 'check_violation';
  END IF;

  held := EXISTS (SELECT 1 FROM eureka.user_role ur WHERE ur.role_key = p_key AND ur.valid @> pg_catalog.now());
  IF held AND EXISTS (
       SELECT 1 FROM pg_catalog.jsonb_each_text(p_grants) w JOIN eureka.permission p ON p.key = w.key
       LEFT JOIN eureka.role_permission cur ON cur.role_key = p_key AND cur.permission = w.key
       WHERE w.value IS NOT NULL
         AND ((p.is_restricted AND cur.permission IS NULL)
          OR (p.is_org_sensitive AND w.value = 'org' AND cur.scope IS DISTINCT FROM 'org'))) THEN
    RAISE EXCEPTION 'role_in_use' USING ERRCODE = 'check_violation';
  END IF;

  added := ARRAY(SELECT w.key FROM pg_catalog.jsonb_each_text(p_grants) w WHERE w.value IS NOT NULL AND NOT EXISTS (
             SELECT 1 FROM eureka.role_permission cur WHERE cur.role_key = p_key AND cur.permission = w.key) ORDER BY 1);
  removed := ARRAY(SELECT cur.permission FROM eureka.role_permission cur WHERE cur.role_key = p_key
             AND NOT EXISTS (SELECT 1 FROM pg_catalog.jsonb_each_text(p_grants) w WHERE w.key = cur.permission AND w.value IS NOT NULL) ORDER BY 1);
  changed := ARRAY(SELECT w.key FROM pg_catalog.jsonb_each_text(p_grants) w JOIN eureka.role_permission cur
             ON cur.role_key = p_key AND cur.permission = w.key AND cur.scope <> w.value WHERE w.value IS NOT NULL ORDER BY 1);

  DELETE FROM eureka.role_permission cur WHERE cur.role_key = p_key AND cur.permission = ANY (removed);
  UPDATE eureka.role_permission cur SET scope = w.value FROM pg_catalog.jsonb_each_text(p_grants) w
   WHERE cur.role_key = p_key AND cur.permission = w.key AND cur.permission = ANY (changed);
  INSERT INTO eureka.role_permission (role_key, permission, scope)
  SELECT p_key, w.key, w.value FROM pg_catalog.jsonb_each_text(p_grants) w WHERE w.key = ANY (added);

  -- Holders' sessions pick the new grants up on their next request (access_version).
  UPDATE eureka.app_user u SET access_version = u.access_version + 1
   WHERE EXISTS (SELECT 1 FROM eureka.user_role ur WHERE ur.user_id = u.id AND ur.role_key = p_key AND ur.valid @> pg_catalog.now());

  RETURN pg_catalog.jsonb_build_object('added', pg_catalog.to_jsonb(added), 'removed', pg_catalog.to_jsonb(removed),
                                       'changed', pg_catalog.to_jsonb(changed));
END $function$;

REVOKE ALL ON FUNCTION authz.role_set_grants(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.role_set_grants(text, jsonb) TO eureka_app;
RESET ROLE;
