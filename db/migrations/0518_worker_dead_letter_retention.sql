-- Worker dead letter and retention (audit F-10 / R-27, G-08 / R-21; docs/notifications.md
-- "Dead letter" and "Retention").
--
-- 1. job_run gets the terminal status `dead`: a key whose job has a dead-letter
--    policy (worker/runner.ts JobDefinition.deadLetter) and failed that many
--    times. Never claimed again (the runner's claim and the worker's update
--    policy both exclude it); kept for inspection like every job_run row.
-- 2. outbox_event.dead_at: the worker may set it once, on an unpublished event,
--    and change nothing else. A dead event is never delivered, published or
--    pruned (prune needs published_at). The guard keeps every other writer out
--    as before; dead_at is server-stamped (rule 4).
-- 3. Retention functions, EXECUTE to eureka_worker only, bounded batches:
--    - eureka.prune_staff_sessions(days >= 30): staff sessions that ended
--      (expired or revoked) more than `days` ago; their step-up rows go with
--      them (FK ON DELETE CASCADE). 30 days keeps the Settings login-activity
--      view (LOGIN_ACTIVITY_DAYS) complete.
--    - eureka.prune_step_up(days >= 1): step-up challenges and grants expired
--      more than `days` ago (sessions that are still live). document_access
--      keeps the grant id (not a foreign key; the log outlives grants).
--    - authz.prune_applicant_sessions(days >= 30): ended applicant (portal)
--      sessions of every applicant, verified ones included (before, only an
--      applicant's own sign-in pruned them). authz_definer, because the portal
--      guard admits only that role.
--    - eureka.audit_prune_exported(days >= 365): audit_event rows older than
--      `days` whose UTC day is in the audit_export ledger and whose seq lies in
--      that day's exported range. The worker schedules it only when
--      AUDIT_RETENTION_DAYS is set (default: kept for ever). The same predicate
--      is the owner's RLS delete policy, so nothing else can be pruned through
--      it. No partitioning (G-08 alternative: delete exported rows after the
--      retention period).
--    The eureka.* functions are owned by eureka_owner (like
--    eureka.prune_outbox_job_runs, 0029), so authz_definer (every API definer
--    function) gets no DELETE on session, step-up or audit rows.
-- Every IF is NULL-safe (rule 1); functions pin search_path, are not
-- executable by PUBLIC and are executable by eureka_worker only (rule 2).
-- Applies as a non-superuser (rule 7): objects are created under SET ROLE.

SET ROLE eureka_owner;

-- ---------- 1. job_run: terminal `dead` ----------
ALTER TABLE eureka.job_run DROP CONSTRAINT job_run_status_check;
ALTER TABLE eureka.job_run ADD CONSTRAINT job_run_status_check
  CHECK (status IN ('running', 'succeeded', 'failed', 'dead'));

DROP POLICY job_run_worker_update ON eureka.job_run;
CREATE POLICY job_run_worker_update ON eureka.job_run FOR UPDATE TO eureka_worker
  USING (status NOT IN ('succeeded', 'dead'))
  WITH CHECK (
    (lease_until IS NULL OR lease_until <= now() + interval '1 hour')
    AND (next_attempt_at IS NULL OR next_attempt_at <= now() + interval '7 days')
    AND (status <> 'succeeded'
         OR job_name <> 'audit-export'
         OR EXISTS (SELECT 1 FROM eureka.audit_export e WHERE e.export_date::text = job_run.run_key)));

-- ---------- 2. outbox_event.dead_at ----------
ALTER TABLE eureka.outbox_event
  ADD COLUMN dead_at timestamptz,
  ADD CONSTRAINT outbox_event_dead_unpublished CHECK (dead_at IS NULL OR published_at IS NULL);

CREATE OR REPLACE FUNCTION eureka.outbox_event_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF current_user IS DISTINCT FROM 'authz_definer' THEN
      RAISE EXCEPTION 'placement data changes only through placement functions'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.created_at := pg_catalog.now();
    NEW.published_at := NULL;
    NEW.dead_at := NULL;
    RETURN NEW;
  END IF;

  IF TG_OP = 'TRUNCATE' OR current_user IS DISTINCT FROM 'eureka_worker' THEN
    RAISE EXCEPTION 'placement data changes only through placement functions'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- Publish: published_at NULL -> now(), once, on a live (not dead) event.
    IF OLD.published_at IS NULL AND OLD.dead_at IS NULL
       AND NEW.published_at IS NOT NULL AND NEW.dead_at IS NULL
       AND (to_jsonb(NEW) - 'published_at') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'published_at') THEN
      NEW.published_at := pg_catalog.now();
      RETURN NEW;
    END IF;
    -- Dead letter (0518): dead_at NULL -> now(), once, on an unpublished event.
    IF OLD.published_at IS NULL AND OLD.dead_at IS NULL
       AND NEW.dead_at IS NOT NULL AND NEW.published_at IS NULL
       AND (to_jsonb(NEW) - 'dead_at') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'dead_at') THEN
      NEW.dead_at := pg_catalog.now();
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'outbox events can only be marked published, once (or dead-lettered, once, while unpublished)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- DELETE (prune): published events past the retention floor only.
  IF OLD.published_at IS NULL OR NOT coalesce(OLD.published_at < pg_catalog.now() - interval '7 days', false) THEN
    RAISE EXCEPTION 'only events published more than 7 days ago may be pruned'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN OLD;
END $$;

CREATE POLICY outbox_worker_dead_letter ON eureka.outbox_event FOR UPDATE TO eureka_worker
  USING (published_at IS NULL AND dead_at IS NULL)
  WITH CHECK (published_at IS NULL AND dead_at IS NOT NULL);

-- ---------- 3. retention: owner policies (RLS is forced on these tables) ----------
CREATE POLICY step_up_owner_prune_read ON eureka.step_up_challenge FOR SELECT TO eureka_owner
  USING (expires_at < now() - interval '1 day');
CREATE POLICY step_up_owner_prune ON eureka.step_up_challenge FOR DELETE TO eureka_owner
  USING (expires_at < now() - interval '1 day');
CREATE POLICY step_up_owner_prune_read ON eureka.step_up_grant FOR SELECT TO eureka_owner
  USING (expires_at < now() - interval '1 day');
CREATE POLICY step_up_owner_prune ON eureka.step_up_grant FOR DELETE TO eureka_owner
  USING (expires_at < now() - interval '1 day');

-- audit_event: only rows older than the 365-day floor, inside an exported day's seq range.
CREATE POLICY audit_export_owner_read ON eureka.audit_export FOR SELECT TO eureka_owner USING (true);
CREATE POLICY audit_owner_prune_read ON eureka.audit_event FOR SELECT TO eureka_owner
  USING (at < now() - interval '365 days' AND EXISTS (
    SELECT 1 FROM eureka.audit_export e
     WHERE e.export_date = (audit_event.at AT TIME ZONE 'UTC')::date
       AND audit_event.seq BETWEEN e.first_seq AND e.last_seq));
CREATE POLICY audit_owner_prune ON eureka.audit_event FOR DELETE TO eureka_owner
  USING (at < now() - interval '365 days' AND EXISTS (
    SELECT 1 FROM eureka.audit_export e
     WHERE e.export_date = (audit_event.at AT TIME ZONE 'UTC')::date
       AND audit_event.seq BETWEEN e.first_seq AND e.last_seq));

-- ---------- 3. retention functions (eureka_owner) ----------
CREATE FUNCTION eureka.prune_staff_sessions(p_days integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE n integer;
BEGIN
  IF p_days IS NULL OR p_days < 30 OR p_days > 3650 THEN
    RAISE EXCEPTION 'session retention must be between 30 and 3650 days' USING ERRCODE = 'check_violation';
  END IF;
  DELETE FROM eureka.session s WHERE s.id_hash IN (
    SELECT x.id_hash FROM eureka.session x
     WHERE x.expires_at < pg_catalog.now() - pg_catalog.make_interval(days => p_days)
        OR x.revoked_at < pg_catalog.now() - pg_catalog.make_interval(days => p_days)
     LIMIT 1000);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

CREATE FUNCTION eureka.prune_step_up(p_days integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE n integer; m integer;
BEGIN
  IF p_days IS NULL OR p_days < 1 OR p_days > 365 THEN
    RAISE EXCEPTION 'step-up retention must be between 1 and 365 days' USING ERRCODE = 'check_violation';
  END IF;
  DELETE FROM eureka.step_up_challenge c WHERE c.state_hash IN (
    SELECT x.state_hash FROM eureka.step_up_challenge x
     WHERE x.expires_at < pg_catalog.now() - pg_catalog.make_interval(days => p_days) LIMIT 500);
  GET DIAGNOSTICS n = ROW_COUNT;
  DELETE FROM eureka.step_up_grant g WHERE g.id IN (
    SELECT x.id FROM eureka.step_up_grant x
     WHERE x.expires_at < pg_catalog.now() - pg_catalog.make_interval(days => p_days) LIMIT 500);
  GET DIAGNOSTICS m = ROW_COUNT;
  -- At most 500 of each per call; the worker loops while 500 or more come back.
  RETURN n + m;
END $$;

CREATE FUNCTION eureka.audit_prune_exported(p_days integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE n integer;
BEGIN
  IF p_days IS NULL OR p_days < 365 OR p_days > 36500 THEN
    RAISE EXCEPTION 'audit retention must be between 365 and 36500 days' USING ERRCODE = 'check_violation';
  END IF;
  DELETE FROM eureka.audit_event a WHERE a.seq IN (
    SELECT x.seq FROM eureka.audit_event x
     WHERE x.at < pg_catalog.now() - pg_catalog.make_interval(days => p_days)
       AND EXISTS (SELECT 1 FROM eureka.audit_export e
                    WHERE e.export_date = (x.at AT TIME ZONE 'UTC')::date
                      AND x.seq BETWEEN e.first_seq AND e.last_seq)
     ORDER BY x.seq LIMIT 5000);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

RESET ROLE;

REVOKE ALL ON FUNCTION eureka.prune_staff_sessions(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION eureka.prune_step_up(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION eureka.audit_prune_exported(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eureka.prune_staff_sessions(integer) TO eureka_worker;
GRANT EXECUTE ON FUNCTION eureka.prune_step_up(integer) TO eureka_worker;
GRANT EXECUTE ON FUNCTION eureka.audit_prune_exported(integer) TO eureka_worker;

GRANT UPDATE (dead_at) ON eureka.outbox_event TO eureka_worker;

-- ---------- 3. applicant sessions (authz_definer: the portal guard admits only it) ----------
SET ROLE authz_definer;
CREATE FUNCTION authz.prune_applicant_sessions(p_days integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE n integer;
BEGIN
  IF p_days IS NULL OR p_days < 30 OR p_days > 3650 THEN
    RAISE EXCEPTION 'session retention must be between 30 and 3650 days' USING ERRCODE = 'check_violation';
  END IF;
  DELETE FROM eureka.applicant_session s WHERE s.id_hash IN (
    SELECT x.id_hash FROM eureka.applicant_session x
     WHERE x.expires_at < pg_catalog.now() - pg_catalog.make_interval(days => p_days)
        OR x.revoked_at < pg_catalog.now() - pg_catalog.make_interval(days => p_days)
     LIMIT 1000);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION authz.prune_applicant_sessions(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.prune_applicant_sessions(integer) TO eureka_worker;
RESET ROLE;
