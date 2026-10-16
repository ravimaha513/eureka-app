-- The API reports single-admin mode (0084) to the admin screen so the Grant role dialog
-- says whether a restricted role needs a second approver. A read-only boolean: EXECUTE
-- to the API role only (0084 revoked it from PUBLIC).
SET search_path = eureka, public;
SET ROLE authz_definer;

GRANT EXECUTE ON FUNCTION authz.single_admin_mode() TO eureka_app;
