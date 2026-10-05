-- Jobs (jobs-portal package; docs/jobs-portal-api.md JP-1..JP-9).
--
--   1. eureka.job: a client requirement (an opening at a client that recruiters
--      submit candidates to; client_id REFERENCES eureka.client) or an internal
--      opening (a position at one of the group's own companies; company_id
--      without a foreign key until the companies package lands, see the TODO).
--      Rich text (requirements, description) is a small JSON document tree
--      validated by the API against an allow-list (shared RichDocSchema); the
--      database only bounds its type and size. No HTML is ever stored.
--   2. Server-managed columns (owner and team snapshot, row_version,
--      timestamps, posted_at) are set by a BEFORE trigger (rule 4); kind,
--      owner and team never change.
--   3. RLS (rule 3, InitPlan only):
--        client requirements: job:read held by a Sales role at its scope over
--          the owner (creator) and team snapshot; job:manage likewise to write;
--        internal openings: job:read / job:manage at org scope from a non-Sales
--          role (HR);
--        the hiring manager can read their job.
--      Non-org job grants are Sales-only (catalog invariant, packages/shared
--      jobs.test.ts), so authz.recruiter_ids/team_ids need no Sales filter.
--   4. eureka.submission.job_id: a submission may name the client requirement
--      it answers. A definer trigger checks the job is a readable, open client
--      requirement of the submission's client.
-- Every IF is NULL-safe (rule 1). Functions pin search_path, are not
-- executable by PUBLIC and are granted to exactly the role that needs them (rule 2).
SET search_path = eureka, public;

SET ROLE eureka_owner;

CREATE TABLE eureka.job (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                text NOT NULL CHECK (kind IN ('client_requirement', 'internal_opening')),
  title               text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160 AND title !~ '[[:cntrl:]]' AND title = btrim(title)),
  category            text NOT NULL CHECK (category IN
                        ('engineering', 'sales', 'marketing', 'hr', 'finance', 'operations', 'customer_support', 'administration', 'other')),
  experience_level    text NOT NULL CHECK (experience_level IN ('entry', 'junior', 'mid', 'senior', 'lead')),
  employment_type     text NOT NULL CHECK (employment_type IN ('full_time', 'part_time', 'contract')),
  work_mode           text NOT NULL CHECK (work_mode IN ('on_site', 'remote', 'hybrid')),
  status              text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'on_hold', 'closed')),
  deadline            date CHECK (deadline BETWEEN date '2000-01-01' AND date '2100-12-31'),
  work_hours          smallint CHECK (work_hours BETWEEN 1 AND 80),           -- hours per week
  pay_amount          numeric(12,2) CHECK (pay_amount >= 0 AND pay_amount < 100000000),
  pay_frequency       text CHECK (pay_frequency IN ('hourly', 'monthly', 'yearly')),
  pay_currency        text CHECK (pay_currency IN ('USD', 'INR', 'EUR', 'GBP', 'CAD', 'AUD')),
  client_id           uuid REFERENCES eureka.client(id),
  -- TODO(jobs-portal): FK to eureka.company added at integration
  company_id          uuid,
  location            text CHECK (char_length(location) BETWEEN 1 AND 120 AND location !~ '[[:cntrl:]]'),
  skills              text[] NOT NULL DEFAULT '{}' CHECK (cardinality(skills) <= 30),
  requirements        jsonb CHECK (jsonb_typeof(requirements) = 'object' AND pg_column_size(requirements) <= 131072),
  description         jsonb CHECK (jsonb_typeof(description) = 'object' AND pg_column_size(description) <= 131072),
  hiring_manager_id   uuid REFERENCES eureka.app_user(id),
  published_to_portal boolean NOT NULL DEFAULT false,
  -- Server-managed (trigger): creator and the creator's team, the scope anchors.
  owner_id            uuid NOT NULL REFERENCES eureka.app_user(id),
  team_id             uuid REFERENCES eureka.team(id),
  row_version         integer NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- First time the job was open ("posted 4 days ago").
  posted_at           timestamptz,
  CONSTRAINT job_pay CHECK ((pay_amount IS NULL) = (pay_frequency IS NULL) AND (pay_amount IS NULL) = (pay_currency IS NULL)),
  CONSTRAINT job_kind_ref CHECK (
    (kind = 'client_requirement' AND client_id IS NOT NULL AND company_id IS NULL)
    OR (kind = 'internal_opening' AND client_id IS NULL)),
  CONSTRAINT job_portal CHECK (NOT published_to_portal OR kind = 'internal_opening')
);
CREATE INDEX job_list ON eureka.job (created_at DESC, id DESC);
CREATE INDEX job_team ON eureka.job (team_id);
CREATE INDEX job_owner ON eureka.job (owner_id);
CREATE INDEX job_hiring_manager ON eureka.job (hiring_manager_id) WHERE hiring_manager_id IS NOT NULL;
CREATE INDEX job_portal_open ON eureka.job (posted_at DESC, id DESC) WHERE published_to_portal AND status = 'open';

-- Server-managed columns (rule 4) and value checks the CHECKs cannot express.
CREATE FUNCTION eureka.job_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE s text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'jobs are never deleted (close them)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  FOREACH s IN ARRAY NEW.skills LOOP
    IF s IS NULL OR NOT coalesce(char_length(s) BETWEEN 1 AND 40 AND s !~ '[[:cntrl:]]' AND s = btrim(s), false) THEN
      RAISE EXCEPTION 'invalid_skill' USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  IF NEW.hiring_manager_id IS NOT NULL AND NEW.hiring_manager_id IS DISTINCT FROM OLD.hiring_manager_id
     AND NOT EXISTS (SELECT 1 FROM eureka.app_user u WHERE u.id = NEW.hiring_manager_id AND u.status = 'active') THEN
    RAISE EXCEPTION 'invalid_hiring_manager' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF authz.current_user_id() IS NULL
       OR (NEW.owner_id IS NOT NULL AND NEW.owner_id IS DISTINCT FROM authz.current_user_id())
       OR NEW.team_id IS NOT NULL OR NEW.row_version IS DISTINCT FROM 1 OR NEW.posted_at IS NOT NULL THEN
      RAISE EXCEPTION 'server_managed_field' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.owner_id := authz.current_user_id();
    -- Internal openings belong to the org (HR), not to a Sales team.
    NEW.team_id := CASE WHEN NEW.kind = 'client_requirement' THEN authz.actor_team() END;
    NEW.created_at := pg_catalog.now();
    NEW.updated_at := NEW.created_at;
    NEW.posted_at := CASE WHEN NEW.status = 'open' THEN NEW.created_at END;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.kind, NEW.owner_id, NEW.team_id, NEW.created_at, NEW.posted_at, NEW.row_version)
     IS DISTINCT FROM (OLD.id, OLD.kind, OLD.owner_id, OLD.team_id, OLD.created_at, OLD.posted_at, OLD.row_version) THEN
    RAISE EXCEPTION 'server_managed_field' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.row_version := OLD.row_version + 1;
  NEW.updated_at := pg_catalog.now();
  NEW.posted_at := coalesce(OLD.posted_at, CASE WHEN NEW.status = 'open' THEN NEW.updated_at END);
  RETURN NEW;
END $$;
CREATE TRIGGER job_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.job
  FOR EACH ROW EXECUTE FUNCTION eureka.job_guard();

CREATE FUNCTION eureka.job_truncate_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'jobs are never truncated' USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER job_truncate_guard BEFORE TRUNCATE ON eureka.job
  FOR EACH STATEMENT EXECUTE FUNCTION eureka.job_truncate_guard();

ALTER TABLE eureka.job ENABLE ROW LEVEL SECURITY;
ALTER TABLE eureka.job FORCE ROW LEVEL SECURITY;

RESET ROLE;

-- ---------- scope helpers ----------
SET ROLE authz_definer;

-- An org-scope grant of `perm` from a Sales role (p_sales) or from a non-Sales role.
CREATE FUNCTION authz.has_org_kind(perm text, p_sales boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM authz.grants(perm) g WHERE g.scope = 'org' AND g.is_sales IS NOT DISTINCT FROM p_sales)
$$;

-- JP-2: may the current user write a job of this kind, owner and team? (write
-- checks only; read policies use the InitPlan form below.)
CREATE FUNCTION authz.job_can_manage(p_kind text, p_owner uuid, p_team uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE p_kind
    WHEN 'client_requirement' THEN
      authz.has_org_kind('job:manage', true)
      OR coalesce(p_owner = ANY (authz.recruiter_ids('job:manage')), false)
      OR coalesce(p_team = ANY (authz.team_ids('job:manage')), false)
    WHEN 'internal_opening' THEN authz.has_org_kind('job:manage', false)
    ELSE false END
$$;

-- JP-1: the job is readable by the current user (mirrors job_read; definer use only).
CREATE FUNCTION authz.job_visible(p_job uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM eureka.job j WHERE j.id = p_job AND authz.current_user_id() IS NOT NULL AND (
      j.hiring_manager_id = authz.current_user_id()
      OR (j.kind = 'client_requirement' AND (
            authz.has_org_kind('job:read', true)
            OR j.owner_id = ANY (authz.recruiter_ids('job:read'))
            OR coalesce(j.team_id = ANY (authz.team_ids('job:read')), false)))
      OR (j.kind = 'internal_opening' AND authz.has_org_kind('job:read', false))))
$$;

-- Submission -> job link (BEFORE INSERT on submission): a readable, open
-- client requirement of the submission's client, or nothing.
CREATE FUNCTION authz.submission_job_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE j record;
BEGIN
  IF NEW.job_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT coalesce(authz.job_visible(NEW.job_id), false) THEN
    RAISE EXCEPTION 'job_not_found' USING ERRCODE = 'check_violation';
  END IF;
  SELECT x.kind, x.client_id, x.status INTO j FROM eureka.job x WHERE x.id = NEW.job_id;
  IF j.kind IS DISTINCT FROM 'client_requirement' OR j.client_id IS DISTINCT FROM NEW.client_id THEN
    RAISE EXCEPTION 'job_client_mismatch' USING ERRCODE = 'check_violation';
  END IF;
  IF j.status IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'job_not_open' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

RESET ROLE;

-- ---------- policies ----------
SET ROLE eureka_owner;

CREATE POLICY job_read ON eureka.job FOR SELECT TO eureka_app USING (
  hiring_manager_id = (SELECT authz.current_user_id())
  OR (kind = 'client_requirement' AND (
        (SELECT authz.has_org_kind('job:read', true))
        OR owner_id = ANY ((SELECT authz.recruiter_ids('job:read'))::uuid[])
        OR team_id  = ANY ((SELECT authz.team_ids('job:read'))::uuid[])))
  OR (kind = 'internal_opening' AND (SELECT authz.has_org_kind('job:read', false)))
);
CREATE POLICY job_insert ON eureka.job FOR INSERT TO eureka_app
  WITH CHECK (authz.job_can_manage(kind, owner_id, team_id));
CREATE POLICY job_update ON eureka.job FOR UPDATE TO eureka_app
  USING (authz.job_can_manage(kind, owner_id, team_id))
  WITH CHECK (authz.job_can_manage(kind, owner_id, team_id));
CREATE POLICY definer_read ON eureka.job FOR SELECT TO authz_definer USING (true);

-- ---------- submission -> job ----------
ALTER TABLE eureka.submission ADD COLUMN job_id uuid REFERENCES eureka.job(id);
CREATE INDEX submission_job ON eureka.submission (job_id) WHERE job_id IS NOT NULL;

RESET ROLE;

CREATE TRIGGER submission_job_check BEFORE INSERT ON eureka.submission
  FOR EACH ROW EXECUTE FUNCTION authz.submission_job_check();

REVOKE ALL ON eureka.job FROM PUBLIC;
GRANT SELECT, INSERT ON eureka.job TO eureka_app;
GRANT UPDATE (title, category, experience_level, employment_type, work_mode, status, deadline, work_hours,
  pay_amount, pay_frequency, pay_currency, client_id, company_id, location, skills, requirements, description,
  hiring_manager_id, published_to_portal) ON eureka.job TO eureka_app;
GRANT SELECT ON eureka.job TO authz_definer;

REVOKE ALL ON FUNCTION eureka.job_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION eureka.job_truncate_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.has_org_kind(text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.job_can_manage(text, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.job_visible(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.submission_job_check() FROM PUBLIC;
-- Policies evaluate as the querying role: the app needs the helpers it calls.
GRANT EXECUTE ON FUNCTION authz.has_org_kind(text, boolean) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.job_can_manage(text, uuid, uuid) TO eureka_app;
