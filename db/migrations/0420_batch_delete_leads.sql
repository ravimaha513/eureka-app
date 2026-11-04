-- Lead and above may delete an empty batch (docs/training-api.md TR-1).
--
-- authz.delete_batch (now db/functions/authz/delete_batch.sql) checks
-- authz.batch_manage_location_ids(): training:manage locations plus, for Sales
-- leadership (authz.batch_manager), the locations of their teams' batches.
-- The API reads the same set to show Delete only where it will be allowed, so
-- the app role may now call it. It returns only the caller's own locations.

SET ROLE authz_definer;
GRANT EXECUTE ON FUNCTION authz.batch_manage_location_ids() TO eureka_app;
RESET ROLE;
