-- Organization and identity (design B2.1). These tables are on the RLS
-- allow-list: the app role reads limited columns and writes only through
-- admin endpoints (design B4.8, N1).
SET ROLE eureka_owner;
SET search_path = eureka, public;

CREATE TABLE location (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name      text NOT NULL UNIQUE,
  kind      text NOT NULL CHECK (kind IN ('training','gh','office','remote')),
  state     text,
  timezone  text NOT NULL DEFAULT 'America/New_York'
);

CREATE TABLE app_user (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email               citext NOT NULL UNIQUE,
  display_name        text NOT NULL,
  designation         text,             -- display label only; never maps to a role (N12)
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  primary_location_id uuid REFERENCES location(id),
  google_sub          text UNIQUE,
  access_version      int  NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE role (
  key       text PRIMARY KEY,
  label     text NOT NULL,
  is_sales  boolean NOT NULL DEFAULT false,
  is_location_bound boolean NOT NULL DEFAULT false
);

-- Seeded from packages/shared/src/authz/catalog.ts by the migration runner.
CREATE TABLE role_permission (
  role_key   text NOT NULL REFERENCES role(key),
  permission text NOT NULL,
  scope      text NOT NULL CHECK (scope IN ('own','team','coached','hierarchy','location','org')),
  PRIMARY KEY (role_key, permission)
);

CREATE TABLE user_role (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES app_user(id),
  role_key    text NOT NULL REFERENCES role(key),
  location_id uuid REFERENCES location(id),
  valid       tstzrange NOT NULL DEFAULT tstzrange(now(), NULL),
  created_by  uuid REFERENCES app_user(id),
  approved_by uuid REFERENCES app_user(id),
  CHECK (approved_by IS NULL OR (approved_by <> user_id AND approved_by IS DISTINCT FROM created_by))
);
CREATE INDEX user_role_user ON user_role (user_id);

CREATE TABLE team (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  lead_id     uuid NOT NULL REFERENCES app_user(id),
  location_id uuid REFERENCES location(id)
);

CREATE TABLE team_member (
  team_id uuid NOT NULL REFERENCES team(id),
  user_id uuid NOT NULL REFERENCES app_user(id),
  valid   tstzrange NOT NULL DEFAULT tstzrange(now(), NULL),
  EXCLUDE USING gist (user_id WITH =, valid WITH &&)
);

CREATE TABLE reporting_line (
  user_id    uuid NOT NULL REFERENCES app_user(id),
  manager_id uuid NOT NULL REFERENCES app_user(id),
  valid      tstzrange NOT NULL DEFAULT tstzrange(now(), NULL),
  CHECK (manager_id <> user_id),
  EXCLUDE USING gist (user_id WITH =, valid WITH &&)
);

-- Current reporting lines only; rebuilt in the same transaction by trigger.
CREATE TABLE reporting_closure (
  ancestor_id   uuid NOT NULL,
  descendant_id uuid NOT NULL,
  depth         int  NOT NULL,
  PRIMARY KEY (ancestor_id, descendant_id)
);
CREATE INDEX reporting_closure_desc ON reporting_closure (descendant_id);

CREATE TABLE coach_assignment (
  coach_id uuid NOT NULL REFERENCES app_user(id),
  team_id  uuid NOT NULL REFERENCES team(id),
  valid    tstzrange NOT NULL DEFAULT tstzrange(now(), NULL)
);

CREATE TABLE session (
  id_hash        bytea PRIMARY KEY,
  user_id        uuid NOT NULL REFERENCES app_user(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  auth_time      timestamptz NOT NULL,
  access_version int NOT NULL,
  revoked_at     timestamptz
);

-- Closure rebuild with cycle check, serialized by advisory lock (B2.1, N10).
CREATE FUNCTION rebuild_reporting_closure() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('eureka.reporting_closure'));
  IF EXISTS (
    WITH RECURSIVE up(u, path) AS (
      SELECT rl.user_id, ARRAY[rl.user_id] FROM eureka.reporting_line rl WHERE rl.valid @> now()
      UNION ALL
      SELECT rl.manager_id, up.path || rl.manager_id
      FROM up JOIN eureka.reporting_line rl ON rl.user_id = up.u AND rl.valid @> now()
      WHERE NOT rl.manager_id = ANY(up.path) AND array_length(up.path,1) < 64
    )
    SELECT 1 FROM up JOIN eureka.reporting_line rl ON rl.user_id = up.u AND rl.valid @> now()
    WHERE rl.manager_id = ANY(up.path)
  ) THEN
    RAISE EXCEPTION 'reporting line cycle detected' USING ERRCODE = 'check_violation';
  END IF;

  DELETE FROM eureka.reporting_closure;
  INSERT INTO eureka.reporting_closure (ancestor_id, descendant_id, depth)
  WITH RECURSIVE c(anc, des, d) AS (
    SELECT rl.manager_id, rl.user_id, 1 FROM eureka.reporting_line rl WHERE rl.valid @> now()
    UNION ALL
    SELECT rl.manager_id, c.des, c.d + 1
    FROM c JOIN eureka.reporting_line rl ON rl.user_id = c.anc AND rl.valid @> now()
    WHERE c.d < 64
  )
  SELECT anc, des, min(d) FROM c GROUP BY anc, des;

  -- Bump access_version for everyone: org changes are rare, correctness first.
  UPDATE eureka.app_user SET access_version = access_version + 1;
  RETURN NULL;
END $$;

CREATE TRIGGER reporting_line_closure
AFTER INSERT OR UPDATE OR DELETE ON reporting_line
FOR EACH STATEMENT EXECUTE FUNCTION rebuild_reporting_closure();

-- Bump access_version when roles, team membership or coaching change (B4.3).
CREATE FUNCTION bump_access_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  UPDATE eureka.app_user SET access_version = access_version + 1;
  RETURN NULL;
END $$;

CREATE TRIGGER user_role_access AFTER INSERT OR UPDATE OR DELETE ON user_role
  FOR EACH STATEMENT EXECUTE FUNCTION bump_access_version();
CREATE TRIGGER team_member_access AFTER INSERT OR UPDATE OR DELETE ON team_member
  FOR EACH STATEMENT EXECUTE FUNCTION bump_access_version();
CREATE TRIGGER coach_access AFTER INSERT OR UPDATE OR DELETE ON coach_assignment
  FOR EACH STATEMENT EXECUTE FUNCTION bump_access_version();
CREATE TRIGGER team_access AFTER INSERT OR UPDATE OR DELETE ON team
  FOR EACH STATEMENT EXECUTE FUNCTION bump_access_version();

-- Location roles must carry a location (CHECK needs the role table, so a trigger).
CREATE FUNCTION check_user_role() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE bound boolean;
BEGIN
  SELECT is_location_bound INTO bound FROM eureka.role WHERE key = NEW.role_key;
  IF bound AND NEW.location_id IS NULL THEN
    RAISE EXCEPTION 'role % requires a location', NEW.role_key USING ERRCODE = 'check_violation';
  END IF;
  IF NOT bound AND NEW.location_id IS NOT NULL THEN
    RAISE EXCEPTION 'role % must not carry a location', NEW.role_key USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER user_role_check BEFORE INSERT OR UPDATE ON user_role
  FOR EACH ROW EXECUTE FUNCTION check_user_role();

RESET ROLE;
-- The definer functions above must bypass RLS on org tables; they are owned by eureka_owner,
-- and org tables have no RLS, so ownership by eureka_owner is sufficient.

GRANT SELECT ON location, role, role_permission, team, team_member, reporting_line,
  reporting_closure, coach_assignment TO eureka_app, eureka_worker, authz_definer;
GRANT SELECT (id, email, display_name, designation, status, primary_location_id, access_version)
  ON app_user TO eureka_app, eureka_worker;
GRANT SELECT ON app_user, user_role TO authz_definer;
GRANT SELECT (id, user_id, role_key, location_id, valid) ON user_role TO eureka_app;
GRANT SELECT, INSERT, UPDATE ON session TO eureka_app;
