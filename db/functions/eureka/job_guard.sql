-- eureka.job_guard: current definition (repeatable; db/functions/README.md).
-- Earlier body: migration 0060. Change this file, not a new migration.
-- BEFORE INSERT/UPDATE/DELETE on eureka.job: server-managed columns (rule 4), value checks the
-- CHECKs cannot express, and the job status lifecycle (docs/jobs-portal-api.md JP-3a), mirrored by
-- jobTransitionAllowed in packages/shared/src/authz/state-machines.ts (parity:
-- apps/api/test/state-machine-parity.db.int.test.ts). Not SECURITY DEFINER.

SET ROLE eureka_owner;
CREATE OR REPLACE FUNCTION eureka.job_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
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
  IF TG_OP = 'UPDATE' THEN
    -- The client of a job cannot change once any submission (of any team) answers it.
    IF NEW.client_id IS DISTINCT FROM OLD.client_id AND coalesce(authz.job_has_submissions(OLD.id), true) THEN
      RAISE EXCEPTION 'client_locked' USING ERRCODE = 'check_violation';
    END IF;
    -- JP-3a lifecycle: no rule is defined yet, so every change between the four statuses is allowed.
    -- Listed pair by pair so a tightening is a one-line edit here and in state-machines.ts.
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT coalesce((OLD.status, NEW.status) IN (
        ('draft', 'open'), ('draft', 'on_hold'), ('draft', 'closed'),
        ('open', 'draft'), ('open', 'on_hold'), ('open', 'closed'),
        ('on_hold', 'draft'), ('on_hold', 'open'), ('on_hold', 'closed'),
        ('closed', 'draft'), ('closed', 'open'), ('closed', 'on_hold')), false) THEN
      RAISE EXCEPTION 'invalid_transition' USING ERRCODE = 'check_violation';
    END IF;
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
END $function$;

REVOKE ALL ON FUNCTION eureka.job_guard() FROM PUBLIC;
RESET ROLE;
