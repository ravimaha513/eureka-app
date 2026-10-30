-- Custom roles, traits and ladders (docs/roles-api.md). Follows 0310 (perf indexes).
--
--   1. eureka.role grows what a role used to mean by its key alone: traits
--      (is_admin, is_recruiter, is_coach next to is_sales, is_location_bound),
--      a ladder position (track, level), an optional business unit
--      (department_id), and the lifecycle of a custom role (is_system,
--      cloned_from, archived_at, created_*). The 17 rows the catalog seeds
--      become system roles: templates an admin clones, never edits.
--   2. eureka.permission mirrors PERMISSIONS of packages/shared (the migration
--      runner seeds it) so grants of custom roles are validated in the database
--      and role.is_restricted is computed here, by a trigger, instead of being
--      copied from the catalog: a custom role holding a restricted permission
--      (or an org-sensitive one at org scope, or the admin trait) needs the
--      second approver like a built-in one (AD-3).
--   3. authz.user_has_trait(user, trait) replaces every "role_key = '...'"
--      branch in the definer functions (db/functions), so custom roles behave
--      like the system role they were cloned from.
--   4. eureka_app reads role, role_permission and permission for the Roles
--      screen; writes go through authz.role_* (db/functions/authz/role_*.sql).
--      No RLS: reference data on the allow-list, like location and department.
SET search_path = eureka, public;

-- ---------- 1. role columns ----------
SET ROLE eureka_owner;

ALTER TABLE eureka.role
  ADD COLUMN is_system     boolean NOT NULL DEFAULT false,
  ADD COLUMN is_admin      boolean NOT NULL DEFAULT false,
  ADD COLUMN is_recruiter  boolean NOT NULL DEFAULT false,
  ADD COLUMN is_coach      boolean NOT NULL DEFAULT false,
  ADD COLUMN track         text NOT NULL DEFAULT 'other',
  ADD COLUMN level         int NOT NULL DEFAULT 1,
  ADD COLUMN description   text,
  ADD COLUMN department_id uuid REFERENCES eureka.department(id),
  ADD COLUMN cloned_from   text REFERENCES eureka.role(key),
  ADD COLUMN archived_at   timestamptz,
  ADD COLUMN created_at    timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN created_by    uuid REFERENCES eureka.app_user(id),
  ADD CONSTRAINT role_key_format CHECK (key ~ '^[a-z][a-z0-9_]{0,63}$'),
  ADD CONSTRAINT role_label_length CHECK (char_length(label) BETWEEN 1 AND 80),
  ADD CONSTRAINT role_track_format CHECK (track ~ '^[a-z][a-z0-9_]{0,39}$'),
  ADD CONSTRAINT role_level_range CHECK (level BETWEEN 1 AND 20),
  ADD CONSTRAINT role_description_length CHECK (description IS NULL OR char_length(description) <= 500),
  ADD CONSTRAINT role_system_stays CHECK (NOT is_system OR archived_at IS NULL);

-- Every row so far came from the catalog. The runner re-seeds their traits and
-- ladder on its next run; these values keep the functions below correct until then.
UPDATE eureka.role SET is_system = true,
  is_admin = (key = 'org_admin'),
  is_recruiter = (key = 'recruiter'),
  is_coach = (key IN ('interview_coach', 'interview_lead'));

-- Labels are what admins pick from; unique while the role is live.
CREATE UNIQUE INDEX role_label_live ON eureka.role (lower(label)) WHERE archived_at IS NULL;
CREATE INDEX role_department ON eureka.role (department_id) WHERE department_id IS NOT NULL;

-- ---------- 2. permission catalog ----------
CREATE TABLE eureka.permission (
  key              text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_.]*:[a-z_]+$'),
  is_restricted    boolean NOT NULL DEFAULT false,
  is_org_sensitive boolean NOT NULL DEFAULT false
);
INSERT INTO eureka.permission (key) SELECT DISTINCT permission FROM eureka.role_permission;
ALTER TABLE eureka.role_permission
  ADD CONSTRAINT role_permission_permission_fkey FOREIGN KEY (permission) REFERENCES eureka.permission(key);

-- is_restricted is derived (docs/roles-api.md): the admin trait, a restricted
-- permission, or an org-sensitive permission at org scope.
CREATE FUNCTION eureka.role_refresh_restricted(p_role text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  UPDATE eureka.role r
     SET is_restricted = r.is_admin OR EXISTS (
           SELECT 1 FROM eureka.role_permission rp JOIN eureka.permission p ON p.key = rp.permission
            WHERE rp.role_key = r.key AND (p.is_restricted OR (p.is_org_sensitive AND rp.scope = 'org')))
   WHERE p_role IS NULL OR r.key = p_role
$$;

CREATE FUNCTION eureka.role_permission_refresh() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM eureka.role_refresh_restricted(NULL);
  RETURN NULL;
END $$;
CREATE TRIGGER role_permission_refresh AFTER INSERT OR UPDATE OR DELETE ON eureka.role_permission
  FOR EACH STATEMENT EXECUTE FUNCTION eureka.role_permission_refresh();
CREATE TRIGGER permission_refresh AFTER UPDATE OF is_restricted, is_org_sensitive ON eureka.permission
  FOR EACH STATEMENT EXECUTE FUNCTION eureka.role_permission_refresh();

CREATE FUNCTION eureka.role_admin_refresh() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  NEW.is_restricted := NEW.is_admin OR EXISTS (
    SELECT 1 FROM eureka.role_permission rp JOIN eureka.permission p ON p.key = rp.permission
     WHERE rp.role_key = NEW.key AND (p.is_restricted OR (p.is_org_sensitive AND rp.scope = 'org')));
  RETURN NEW;
END $$;
CREATE TRIGGER role_admin_refresh BEFORE INSERT OR UPDATE OF is_admin ON eureka.role
  FOR EACH ROW EXECUTE FUNCTION eureka.role_admin_refresh();

REVOKE ALL ON FUNCTION eureka.role_refresh_restricted(text), eureka.role_permission_refresh(), eureka.role_admin_refresh() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eureka.role_refresh_restricted(text), eureka.role_permission_refresh(), eureka.role_admin_refresh()
  TO eureka_owner, authz_definer;

-- ---------- 3. traits ----------
RESET ROLE;
SET ROLE authz_definer;

-- True when p_user holds, now, a role with the trait. Answers a yes/no about a user
-- id the caller already holds, like authz.is_interview_coach (0130) did.
CREATE FUNCTION authz.user_has_trait(p_user uuid, p_trait text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT p_user IS NOT NULL AND EXISTS (
    SELECT 1 FROM eureka.user_role ur
    JOIN eureka.role r ON r.key = ur.role_key
    JOIN eureka.app_user u ON u.id = ur.user_id
    WHERE ur.user_id = p_user AND ur.valid @> pg_catalog.now() AND u.status = 'active'
      AND CASE p_trait
            WHEN 'admin' THEN r.is_admin
            WHEN 'recruiter' THEN r.is_recruiter
            WHEN 'coach' THEN r.is_coach
            WHEN 'sales' THEN r.is_sales
            WHEN 'location_bound' THEN r.is_location_bound
            ELSE false END)
$$;
RESET ROLE;
REVOKE ALL ON FUNCTION authz.user_has_trait(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.user_has_trait(uuid, text) TO eureka_app, eureka_worker, eureka_import, eureka_owner, authz_definer;

-- ---------- 4. privileges ----------
GRANT SELECT ON eureka.role, eureka.role_permission, eureka.permission TO eureka_app, eureka_worker, authz_definer;
GRANT INSERT (key, label, description, is_sales, is_location_bound, is_admin, is_recruiter, is_coach, track, level,
              department_id, cloned_from, created_by),
      UPDATE (label, description, is_sales, is_location_bound, is_admin, is_recruiter, is_coach, track, level,
              department_id, archived_at)
  ON eureka.role TO authz_definer;
GRANT INSERT, UPDATE, DELETE ON eureka.role_permission TO authz_definer;
GRANT SELECT (id, department_id) ON eureka.app_user TO authz_definer;
