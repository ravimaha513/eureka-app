-- Outbox delivery hardening (independent review of 0024).
--   1. Provider rejections are counted per recipient (`rejections`, +1 per
--      definite rejection; throttling is not counted). After the configured
--      maximum the job moves the row to the final state `failed`, so the
--      event can be published and later pruned instead of retrying forever.
--   2. outbox_delivery rows cannot be deleted or truncated by anyone (owner
--      and superuser included), except by the ON DELETE CASCADE of their
--      parent event, which runs as the table owner from inside the
--      referential trigger (pg_trigger_depth() > 1). The outbox_event guard
--      (0024) only lets the worker delete events published > 7 days ago.
--   3. Retention for job_run rows of outbox-delivery (one per event): the
--      worker still has no DELETE on job_run (0016). It calls
--      eureka.prune_outbox_job_runs(days), a SECURITY DEFINER function that
--      deletes only succeeded outbox-delivery rows finished >= 7 days ago. A
--      trigger refuses every other job_run delete and TRUNCATE (owner and
--      superuser included). Safe: delivery is deduplicated by
--      outbox_event.published_at and outbox_delivery, not by job_run; a
--      re-claimed key finds the event published (or pruned) and does nothing.
-- Every IF is NULL-safe (rule 1); functions pin search_path and are not
-- executable by PUBLIC (rule 2).
SET search_path = eureka, public;

SET ROLE eureka_owner;

-- ---------- 1. rejection count and `failed` ----------
ALTER TABLE eureka.outbox_delivery
  ADD COLUMN rejections smallint NOT NULL DEFAULT 0 CHECK (rejections BETWEEN 0 AND 1000);
ALTER TABLE eureka.outbox_delivery DROP CONSTRAINT outbox_delivery_status_check;
ALTER TABLE eureka.outbox_delivery DROP CONSTRAINT outbox_delivery_check;
ALTER TABLE eureka.outbox_delivery
  ADD CONSTRAINT outbox_delivery_status_check
    CHECK (status IN ('pending', 'sending', 'sent', 'skipped', 'in_doubt', 'failed')),
  ADD CONSTRAINT outbox_delivery_done_check
    CHECK ((status IN ('sent', 'skipped', 'in_doubt', 'failed')) = (done_at IS NOT NULL));

CREATE OR REPLACE FUNCTION eureka.outbox_delivery_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'outbox deliveries are never truncated' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF TG_OP = 'DELETE' THEN
    -- Only the cascade from a pruned outbox_event: it runs as the table owner
    -- inside the parent's referential trigger. A direct delete has depth 1.
    IF NOT coalesce(pg_catalog.pg_trigger_depth() > 1 AND current_user = 'eureka_owner', false) THEN
      RAISE EXCEPTION 'outbox deliveries are removed only with their event'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'pending' THEN
      RAISE EXCEPTION 'server_managed_field' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.created_at := pg_catalog.now();
    NEW.attempt_at := NULL;
    NEW.done_at := NULL;
    NEW.rejections := 0;
    RETURN NEW;
  END IF;

  IF (NEW.event_id, NEW.user_id, NEW.created_at) IS DISTINCT FROM (OLD.event_id, OLD.user_id, OLD.created_at)
     OR NOT coalesce((OLD.status, NEW.status) IN (
       ('pending', 'sending'), ('pending', 'skipped'),
       ('sending', 'sent'), ('sending', 'pending'), ('sending', 'in_doubt'), ('sending', 'failed')), false) THEN
    RAISE EXCEPTION 'invalid outbox delivery change' USING ERRCODE = 'check_violation';
  END IF;
  -- A rejection (sending -> pending or failed) may add one; nothing else moves the count.
  IF NOT coalesce(NEW.rejections = OLD.rejections
                  OR (NEW.rejections = OLD.rejections + 1 AND OLD.status = 'sending'
                      AND NEW.status IN ('pending', 'failed')), false)
     OR (NEW.status = 'failed' AND NEW.rejections IS DISTINCT FROM OLD.rejections + 1) THEN
    RAISE EXCEPTION 'invalid outbox delivery change' USING ERRCODE = 'check_violation';
  END IF;
  NEW.attempt_at := CASE NEW.status WHEN 'sending' THEN pg_catalog.now()
                                    WHEN 'pending' THEN NULL
                                    ELSE OLD.attempt_at END;
  NEW.done_at := CASE WHEN NEW.status IN ('sent', 'skipped', 'in_doubt', 'failed') THEN pg_catalog.now() END;
  RETURN NEW;
END $$;

-- ---------- 2. delete and truncate guards ----------
CREATE TRIGGER outbox_delivery_delete_guard BEFORE DELETE ON eureka.outbox_delivery
  FOR EACH ROW EXECUTE FUNCTION eureka.outbox_delivery_guard();
CREATE TRIGGER outbox_delivery_no_truncate BEFORE TRUNCATE ON eureka.outbox_delivery
  FOR EACH STATEMENT EXECUTE FUNCTION eureka.outbox_delivery_guard();

-- ---------- 3. job_run retention for outbox-delivery ----------
CREATE FUNCTION eureka.job_run_delete_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' OR NOT coalesce(
       OLD.job_name = 'outbox-delivery' AND OLD.status = 'succeeded'
       AND OLD.finished_at < pg_catalog.now() - interval '7 days', false) THEN
    RAISE EXCEPTION 'job_run rows are kept, except succeeded outbox-delivery runs older than 7 days'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER job_run_delete_guard BEFORE DELETE ON eureka.job_run
  FOR EACH ROW EXECUTE FUNCTION eureka.job_run_delete_guard();
CREATE TRIGGER job_run_no_truncate BEFORE TRUNCATE ON eureka.job_run
  FOR EACH STATEMENT EXECUTE FUNCTION eureka.job_run_delete_guard();

-- The definer reads and deletes job_run (RLS forced) only within this predicate.
CREATE POLICY job_run_owner_prune_read ON eureka.job_run FOR SELECT TO eureka_owner
  USING (job_name = 'outbox-delivery' AND status = 'succeeded' AND finished_at < now() - interval '7 days');
CREATE POLICY job_run_owner_prune ON eureka.job_run FOR DELETE TO eureka_owner
  USING (job_name = 'outbox-delivery' AND status = 'succeeded' AND finished_at < now() - interval '7 days');

-- Deletes up to 5000 succeeded outbox-delivery runs finished more than p_days
-- (>= 7) days ago; returns the number deleted.
CREATE FUNCTION eureka.prune_outbox_job_runs(p_days integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE n integer;
BEGIN
  IF p_days IS NULL OR p_days < 7 OR p_days > 3650 THEN
    RAISE EXCEPTION 'retention must be between 7 and 3650 days' USING ERRCODE = 'check_violation';
  END IF;
  DELETE FROM eureka.job_run j
   WHERE (j.job_name, j.run_key) IN (
     SELECT r.job_name, r.run_key FROM eureka.job_run r
      WHERE r.job_name = 'outbox-delivery' AND r.status = 'succeeded'
        AND r.finished_at < pg_catalog.now() - pg_catalog.make_interval(days => p_days)
      LIMIT 5000);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

RESET ROLE;

REVOKE ALL ON FUNCTION eureka.job_run_delete_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION eureka.prune_outbox_job_runs(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eureka.prune_outbox_job_runs(integer) TO eureka_worker;

GRANT UPDATE (rejections) ON eureka.outbox_delivery TO eureka_worker;
