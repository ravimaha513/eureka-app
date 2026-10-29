-- Deleting inactive users (docs/admin-api.md, "Deleting users").
--   app_user.deactivated_at: when the user was last deactivated; set and cleared by
--     authz.admin_set_user_status. Users already inactive start their wait now.
--   app_user.deleted_at: when the user was deleted. Deleting anonymizes the row instead
--     of removing it: about 110 foreign keys (candidates, submissions, chat, audit
--     actors, ...) reference app_user and stay valid, shown as "Deleted user".
-- Deletion (authz.anonymize_user, db/functions/authz/) scrubs the email (freed for
-- reuse), name, designation, Google link, location and department, removes the
-- password credential and clears the Settings profile (phone, bio, birthday).
-- Two callers, both in db/functions/authz/:
--   admin_delete_user: an admin, any time after deactivation (skips the wait).
--   purge_inactive_users: the worker, daily, for users inactive for 7+ days.
-- Server-managed: eureka_app gets SELECT only; writes go through the definers (rules 4, 6).
SET ROLE eureka_owner;
SET search_path = eureka, public;

ALTER TABLE app_user
  ADD COLUMN deactivated_at timestamptz,
  ADD COLUMN deleted_at     timestamptz,
  ADD CONSTRAINT app_user_deleted_inactive CHECK (deleted_at IS NULL OR status = 'inactive');

UPDATE app_user SET deactivated_at = now() WHERE status = 'inactive';

CREATE INDEX app_user_purge_idx ON app_user (deactivated_at)
  WHERE status = 'inactive' AND deleted_at IS NULL;

RESET ROLE;

GRANT SELECT (deactivated_at, deleted_at) ON eureka.app_user TO eureka_app, eureka_worker;
GRANT UPDATE (deactivated_at, deleted_at, email, display_name, designation, google_sub, primary_location_id)
  ON eureka.app_user TO authz_definer;
GRANT UPDATE (phone_e164, bio) ON eureka.staff_profile TO authz_definer;
