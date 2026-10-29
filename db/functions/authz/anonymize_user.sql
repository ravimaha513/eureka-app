-- authz.anonymize_user: current definition (repeatable; db/functions/README.md).
-- Deletes an inactive user by anonymizing the row (migration 0280): the id stays so
-- every reference remains valid. Internal: called only by admin_delete_user and
-- purge_inactive_users (same owner), never granted. The caller locks the row and
-- checks it is inactive and not yet deleted. Change this file, not a new migration.

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.anonymize_user(p_user uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  UPDATE eureka.app_user
     SET email = 'deleted-' || p_user::text || '@deleted.invalid',
         display_name = 'Deleted user', designation = NULL, google_sub = NULL,
         primary_location_id = NULL, deleted_at = pg_catalog.now(),
         access_version = access_version + 1
   WHERE id = p_user AND status = 'inactive' AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'user_not_inactive' USING ERRCODE = 'check_violation';
  END IF;
  DELETE FROM authz.user_credential WHERE user_id = p_user;
  UPDATE eureka.staff_profile SET phone_e164 = NULL, bio = NULL, birth_month = NULL, birth_day = NULL
   WHERE user_id = p_user;
  UPDATE eureka.session SET revoked_at = pg_catalog.now() WHERE user_id = p_user AND revoked_at IS NULL;
END $function$;
REVOKE ALL ON FUNCTION authz.anonymize_user(uuid) FROM PUBLIC;
RESET ROLE;
