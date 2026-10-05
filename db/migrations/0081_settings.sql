-- Settings & Preferences (interviews-settings package,
-- docs/interviews-settings-api.md rules ST-1..ST-9).
--   1. eureka.staff_profile: a staff member's own phone and short bio. The
--      owner reads and writes their row; holders of staff.contact:read (HR,
--      Org Admin) read every row. Display name and designation stay on
--      app_user (Google / designation:change) and are not editable here.
--   2. eureka.notification_preference: per user and in-app notification type,
--      on/off. Mandatory types cannot be switched off (the guard refuses the
--      row). The notification worker reads them to skip muted inbox rows.
--   3. eureka.session gets what Login activity needs and nothing more: a
--      public id (the session's id hash never leaves the server), the device
--      class and browser family parsed from the user agent (the user agent
--      itself is not stored) and a masked IP (IPv4 first two octets, IPv6
--      first two groups). The app's UPDATE right on session narrows to the
--      two columns it changes (last_seen_at, revoked_at).
-- Every IF is NULL-safe (rule 1).
SET search_path = eureka, public;

SET ROLE eureka_owner;

-- ---------- 1. staff_profile ----------
CREATE TABLE eureka.staff_profile (
  user_id     uuid PRIMARY KEY REFERENCES eureka.app_user(id),
  phone_e164  text CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  bio         text CHECK (char_length(bio) <= 500 AND bio !~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]'),
  row_version integer NOT NULL DEFAULT 1,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- row_version and updated_at are server-managed; the owner never changes.
CREATE FUNCTION eureka.staff_profile_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.row_version := 1;
    NEW.updated_at := pg_catalog.now();
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
      RAISE EXCEPTION 'column is immutable' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.row_version := OLD.row_version + 1;
    NEW.updated_at := pg_catalog.now();
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'staff profiles are not deleted' USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER staff_profile_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.staff_profile
  FOR EACH ROW EXECUTE FUNCTION eureka.staff_profile_guard();
CREATE TRIGGER staff_profile_no_truncate BEFORE TRUNCATE ON eureka.staff_profile
  FOR EACH STATEMENT EXECUTE FUNCTION eureka.staff_profile_guard();

ALTER TABLE eureka.staff_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE eureka.staff_profile FORCE ROW LEVEL SECURITY;

-- ---------- 2. notification_preference ----------
CREATE TABLE eureka.notification_preference (
  user_id    uuid NOT NULL REFERENCES eureka.app_user(id),
  type       text NOT NULL CHECK (type ~ '^[a-z_]+\.[a-z_]+$' AND char_length(type) <= 80),
  in_app     boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, type)
);

-- Mandatory types (packages/shared/src/notifications.ts, compared by a test)
-- cannot be switched off. user_id and type never change.
CREATE FUNCTION eureka.notification_preference_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'preferences are never truncated' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.user_id, NEW.type) IS DISTINCT FROM (OLD.user_id, OLD.type) THEN
    RAISE EXCEPTION 'column is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT coalesce(NEW.in_app, false)
     AND NEW.type IN ('work_authorization.expiring', 'checklist.item_overdue') THEN
    RAISE EXCEPTION 'notification_type_mandatory' USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END $$;
CREATE TRIGGER notification_preference_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.notification_preference
  FOR EACH ROW EXECUTE FUNCTION eureka.notification_preference_guard();
CREATE TRIGGER notification_preference_no_truncate BEFORE TRUNCATE ON eureka.notification_preference
  FOR EACH STATEMENT EXECUTE FUNCTION eureka.notification_preference_guard();

ALTER TABLE eureka.notification_preference ENABLE ROW LEVEL SECURITY;
ALTER TABLE eureka.notification_preference FORCE ROW LEVEL SECURITY;

-- ---------- 3. session ----------
ALTER TABLE eureka.session
  ADD COLUMN public_id    uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN device_class text CHECK (device_class IN ('desktop', 'mobile', 'tablet', 'unknown')),
  ADD COLUMN browser      text CHECK (browser IN ('Chrome', 'Edge', 'Firefox', 'Safari', 'Opera', 'Other')),
  ADD COLUMN ip_masked    text CHECK (char_length(ip_masked) <= 45 AND ip_masked ~ '^[0-9a-f.:x]+$');
CREATE UNIQUE INDEX session_public_id ON eureka.session (public_id);
CREATE INDEX session_user_created ON eureka.session (user_id, created_at DESC);

RESET ROLE;

REVOKE ALL ON FUNCTION eureka.staff_profile_guard(), eureka.notification_preference_guard() FROM PUBLIC;
REVOKE ALL ON eureka.staff_profile, eureka.notification_preference FROM PUBLIC;

-- staff_profile: own row, or every row with staff.contact:read (InitPlan, rule 3).
GRANT SELECT, INSERT (user_id, phone_e164, bio), UPDATE (phone_e164, bio) ON eureka.staff_profile TO eureka_app;
CREATE POLICY staff_profile_read ON eureka.staff_profile FOR SELECT TO eureka_app
  USING (user_id = (SELECT authz.current_user_id()) OR (SELECT authz.has_org('staff.contact:read')));
CREATE POLICY staff_profile_insert ON eureka.staff_profile FOR INSERT TO eureka_app
  WITH CHECK (user_id = (SELECT authz.current_user_id()));
CREATE POLICY staff_profile_update ON eureka.staff_profile FOR UPDATE TO eureka_app
  USING (user_id = (SELECT authz.current_user_id()))
  WITH CHECK (user_id = (SELECT authz.current_user_id()));

-- notification_preference: own rows only; the worker reads all (no other columns exist).
GRANT SELECT, INSERT (user_id, type, in_app), UPDATE (in_app), DELETE ON eureka.notification_preference TO eureka_app;
CREATE POLICY notification_preference_own ON eureka.notification_preference FOR ALL TO eureka_app
  USING (user_id = (SELECT authz.current_user_id()))
  WITH CHECK (user_id = (SELECT authz.current_user_id()));
GRANT SELECT (user_id, type, in_app) ON eureka.notification_preference TO eureka_worker;
CREATE POLICY notification_preference_worker_read ON eureka.notification_preference FOR SELECT TO eureka_worker
  USING (true);

-- session (no RLS: it is read before a user is known, design A6.1). The app
-- only ever changes the idle clock and the revocation.
REVOKE UPDATE ON eureka.session FROM eureka_app;
GRANT UPDATE (last_seen_at, revoked_at) ON eureka.session TO eureka_app;
