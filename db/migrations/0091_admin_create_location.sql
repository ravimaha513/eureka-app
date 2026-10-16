-- Location creation for org admins (docs/admin-api.md, "Locations").
-- Locations were reference data with no write path: eureka_app had SELECT only
-- and rows came from seed scripts. This definer function is the one write path;
-- admin_guard requires access:manage at org scope (org_admin), so it is the same
-- gate as the other admin functions. Names are unique (location_name_key).

CREATE FUNCTION authz.admin_create_location(p_name text, p_kind text, p_state text, p_timezone text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE new_id uuid;
BEGIN
  PERFORM authz.admin_guard(NULL);
  INSERT INTO eureka.location (name, kind, state, timezone)
  VALUES (p_name, p_kind, p_state, coalesce(p_timezone, 'America/New_York'))
  RETURNING id INTO new_id;
  RETURN new_id;
END $$;

REVOKE ALL ON FUNCTION authz.admin_create_location(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.admin_create_location(text, text, text, text) TO eureka_app;
