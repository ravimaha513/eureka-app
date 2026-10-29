-- authz.create_technology: current definition (repeatable; db/functions/README.md).
-- Sales leads and above, BU heads, interview leads and org admins
-- (technology:create) add a technology for the pickers (docs/lookups-api.md).
-- Names match case-insensitively: an existing active one is returned instead of a
-- duplicate (created = false); an inactive one is refused, since only an admin
-- retired it. Table privileges in 0250. Change this file, not a new migration.

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.create_technology(p_name text)
 RETURNS TABLE(technology_id uuid, technology_name text, created boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_name text := pg_catalog.regexp_replace(pg_catalog.btrim(p_name), '\s+', ' ', 'g');
  v_active boolean;
BEGIN
  IF authz.current_user_id() IS NULL OR NOT coalesce(authz.has_perm('technology:create'), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF coalesce(pg_catalog.length(v_name), 0) NOT BETWEEN 1 AND 60 OR v_name ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'invalid_name' USING ERRCODE = 'check_violation';
  END IF;
  -- Serialise adds so two people typing "ai/ml" and "AI/ML" at once get one row.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('eureka.technology'));
  SELECT t.id, t.name, t.active INTO technology_id, technology_name, v_active
  FROM eureka.technology t WHERE pg_catalog.lower(t.name) = pg_catalog.lower(v_name)
  ORDER BY t.active DESC, t.id LIMIT 1;
  IF FOUND THEN
    IF NOT coalesce(v_active, false) THEN
      RAISE EXCEPTION 'technology_inactive' USING ERRCODE = 'unique_violation';
    END IF;
    created := false;
    RETURN NEXT;
    RETURN;
  END IF;
  INSERT INTO eureka.technology (name) VALUES (v_name) RETURNING id, name INTO technology_id, technology_name;
  created := true;
  RETURN NEXT;
END $function$;
REVOKE ALL ON FUNCTION authz.create_technology(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.create_technology(text) TO eureka_app;
RESET ROLE;
