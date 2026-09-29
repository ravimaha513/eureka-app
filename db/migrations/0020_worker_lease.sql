-- Worker job leases, retry backoff and job_run integrity (review fixes to 0016;
-- design B6 audit-export).
--
-- 1. Leases instead of a session advisory lock. The runner used to hold
--    pg_try_advisory_lock on an idle pooled connection for the whole job; if
--    that connection dropped, the lock vanished and a second runner could run
--    the same key. A run is now claimed by one conditional UPDATE (or INSERT)
--    that sets lease_until, and the runner renews the lease while it works. A
--    "running" row whose lease has expired can be taken over; `attempts` is the
--    fencing token (renewals and the final update match on it).
-- 2. Backoff. A failed run records next_attempt_at; it is not claimable before then.
-- 3. The worker cannot forge history: started_at/finished_at are set by the
--    trigger below (the worker's values are ignored), attempts only ever grows
--    by one per claim, date-shaped run keys in the future are rejected, and an
--    audit-export run can only be marked succeeded when its audit_export ledger
--    row exists (the ledger is the evidence; job_run is bookkeeping).
-- 4. Index on audit_event (at, seq): the export pages one UTC day by (at, seq).
SET ROLE eureka_owner;
SET search_path = eureka, public;

ALTER TABLE job_run
  ADD COLUMN lease_until     timestamptz,
  ADD COLUMN next_attempt_at timestamptz;

-- Rows left "running" by the advisory-lock runner get an expired lease, so the
-- first lease-based runner can take them over. RLS is forced on job_run and
-- the owner has no policy, so lift FORCE for this one statement.
ALTER TABLE job_run NO FORCE ROW LEVEL SECURITY;
UPDATE job_run SET lease_until = now() WHERE status = 'running';
ALTER TABLE job_run FORCE ROW LEVEL SECURITY;

ALTER TABLE job_run
  ADD CONSTRAINT job_run_running_has_lease CHECK (status <> 'running' OR lease_until IS NOT NULL);

CREATE FUNCTION job_run_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  today date := (now() AT TIME ZONE 'UTC')::date;
BEGIN
  -- Daily jobs use the UTC date as run key; nothing may run for a day that has
  -- not started, and the audit export only for days that have ended.
  IF NEW.run_key ~ '^\d{4}-\d{2}-\d{2}$' THEN
    IF NEW.run_key::date > today OR (NEW.job_name = 'audit-export' AND NEW.run_key::date >= today) THEN
      RAISE EXCEPTION 'job_run: run key % of % is in the future', NEW.run_key, NEW.job_name
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.attempts := 1;
    NEW.started_at := now();
    NEW.finished_at := CASE WHEN NEW.status = 'running' THEN NULL ELSE now() END;
    RETURN NEW;
  END IF;

  IF NEW.attempts = OLD.attempts + 1 THEN
    IF NEW.status <> 'running' THEN
      RAISE EXCEPTION 'job_run: a new attempt must start as running' USING ERRCODE = 'check_violation';
    END IF;
    NEW.started_at := now();
  ELSIF NEW.attempts = OLD.attempts THEN
    NEW.started_at := OLD.started_at;
  ELSE
    RAISE EXCEPTION 'job_run: attempts may only grow by one per claim' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status = 'running' THEN
    NEW.finished_at := NULL;
  ELSIF NEW.status = OLD.status THEN
    NEW.finished_at := OLD.finished_at;
  ELSE
    NEW.finished_at := now();
  END IF;
  RETURN NEW;
END $$;
REVOKE EXECUTE ON FUNCTION job_run_guard() FROM PUBLIC;
CREATE TRIGGER job_run_guard BEFORE INSERT OR UPDATE ON job_run
  FOR EACH ROW EXECUTE FUNCTION job_run_guard();

-- The export reads one UTC day at a time, paged by (at, seq).
CREATE INDEX audit_event_at_seq ON audit_event (at, seq);

RESET ROLE;

-- ---------- grants and policies ----------
GRANT UPDATE (lease_until, next_attempt_at) ON eureka.job_run TO eureka_worker;

-- Leases and backoff are bounded so a runaway worker cannot park a key forever.
DROP POLICY job_run_worker_insert ON eureka.job_run;
CREATE POLICY job_run_worker_insert ON eureka.job_run FOR INSERT TO eureka_worker
  WITH CHECK (status = 'running' AND lease_until <= now() + interval '1 hour' AND next_attempt_at IS NULL);

DROP POLICY job_run_worker_update ON eureka.job_run;
CREATE POLICY job_run_worker_update ON eureka.job_run FOR UPDATE TO eureka_worker
  USING (status <> 'succeeded')
  WITH CHECK (
    (lease_until IS NULL OR lease_until <= now() + interval '1 hour')
    AND (next_attempt_at IS NULL OR next_attempt_at <= now() + interval '7 days')
    AND (status <> 'succeeded'
         OR job_name <> 'audit-export'
         OR EXISTS (SELECT 1 FROM eureka.audit_export e WHERE e.export_date::text = job_run.run_key)));
