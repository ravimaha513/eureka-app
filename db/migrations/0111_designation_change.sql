-- Designation changes (Eureka App 4 gap L2; docs/performance-api.md PF-7,
-- docs/admin-api.md). The catalog has granted `designation:change` (manager and
-- associate director, hierarchy) since 0004, but nothing checked it and there was
-- no way to change a designation after the user was created.
--   authz.set_designation(user, designation): sets app_user.designation (a
--   display label; it never maps to a role, N12). Allowed for
--     * access:manage (org): Users & Access, any user;
--     * designation:change: users the grant covers (authz.scope_user_ids, 0110;
--       org scope: anyone).
--   Never the caller themself (self_change). The value is trimmed; empty clears
--   it; at most 120 characters and no control characters (the CreateUser rule).
--   The API audits the change in the same transaction.
-- Every IF is NULL-safe (rule 1); the function pins search_path, is not
-- executable by PUBLIC and is granted to the API role only (rule 2).
SET search_path = eureka, public;

GRANT UPDATE (designation) ON eureka.app_user TO authz_definer;

SET ROLE authz_definer;

CREATE FUNCTION authz.set_designation(p_user uuid, p_designation text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  actor uuid := authz.current_user_id();
  admin boolean := coalesce(authz.has_org('access:manage'), false);
  v text := nullif(pg_catalog.btrim(p_designation), '');
BEGIN
  IF actor IS NULL OR NOT (admin OR coalesce(authz.has_perm('designation:change'), false)) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM 1 FROM eureka.app_user u WHERE u.id = p_user FOR UPDATE;
  IF p_user IS NULL OR NOT FOUND THEN
    RAISE EXCEPTION 'user_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF p_user = actor THEN
    RAISE EXCEPTION 'self_change' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT (admin OR coalesce(authz.has_org('designation:change'), false)
          OR p_user = ANY (authz.scope_user_ids('designation:change'))) THEN
    RAISE EXCEPTION 'not_in_scope' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v IS NOT NULL AND (pg_catalog.char_length(v) > 120 OR v ~ '[[:cntrl:]]') THEN
    RAISE EXCEPTION 'invalid_designation' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE eureka.app_user u SET designation = v WHERE u.id = p_user;
END $$;

RESET ROLE;

REVOKE ALL ON FUNCTION authz.set_designation(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.set_designation(uuid, text) TO eureka_app;
