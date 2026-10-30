-- authz.create_vendor: current definition (repeatable; db/functions/README.md).
-- Every Sales role (vendor:create) adds a vendor for the pickers (docs/lookups-api.md).
-- Names match case-insensitively: an existing one is returned instead of a
-- duplicate (created = false). Table privileges in 0320. Change this file, not a new migration.

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.create_vendor(p_name text)
 RETURNS TABLE(vendor_id uuid, vendor_name text, created boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_name text := pg_catalog.regexp_replace(pg_catalog.btrim(p_name), '\s+', ' ', 'g');
BEGIN
  IF authz.current_user_id() IS NULL OR NOT coalesce(authz.has_perm('vendor:create'), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF coalesce(pg_catalog.length(v_name), 0) NOT BETWEEN 1 AND 60 OR v_name ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'invalid_name' USING ERRCODE = 'check_violation';
  END IF;
  -- Serialise adds so two people typing "amex" and "AMEX" at once get one row.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('eureka.vendor'));
  SELECT x.id, x.name INTO vendor_id, vendor_name
  FROM eureka.vendor x WHERE pg_catalog.lower(x.name) = pg_catalog.lower(v_name)
  ORDER BY x.id LIMIT 1;
  IF FOUND THEN
    created := false;
    RETURN NEXT;
    RETURN;
  END IF;
  INSERT INTO eureka.vendor (name) VALUES (v_name) RETURNING id, name INTO vendor_id, vendor_name;
  created := true;
  RETURN NEXT;
END $function$;
REVOKE ALL ON FUNCTION authz.create_vendor(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.create_vendor(text) TO eureka_app;
RESET ROLE;
