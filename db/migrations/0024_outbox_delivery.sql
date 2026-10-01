-- Outbox delivery, pruning and idempotency-key cleanup (worker; design A7, B6;
-- docs/placements-api.md PL-7).
--
-- 1. outbox_event gets its own write guard instead of placement_write_guard:
--      INSERT  only authz_definer (the placement functions), as before; the
--              server stamps created_at and published_at starts NULL;
--      UPDATE  only eureka_worker, only published_at, only NULL -> now()
--              (the database sets the time; nothing else may change);
--      DELETE  only eureka_worker, only rows published more than 7 days ago
--              (the prune job's configurable retention cannot go below this floor).
--    Every other writer (the app, the owner, a superuser) is refused.
-- 2. eureka_worker: SELECT, UPDATE (published_at) and DELETE on outbox_event
--    under policies that mirror the guard.
-- 3. outbox_delivery: one row per (event, recipient user) - the dedupe marker
--    that keeps a crash or retry from emailing anyone twice. Ids and a state
--    only; addresses are read from app_user at send time and never stored
--    (rule 5). States: pending -> sending -> sent; sending -> pending (the
--    provider definitely rejected the message: retry); sending -> in_doubt (the
--    outcome is unknown: never resent, alerted); pending -> skipped (recipient
--    no longer active or no longer holds the role). Timestamps are the
--    database's. Rows go with their event (ON DELETE CASCADE) when it is pruned.
-- 4. Recipients are resolved from user_role like the rest of the code
--    (active user, role valid now): the worker reads user_id, role_key, valid.
-- 5. idempotency_key: index on created_at; the worker may delete rows older
--    than 24 hours and read only the key columns (never the stored response).
-- Every IF is NULL-safe (rule 1); trigger functions are not SECURITY DEFINER,
-- pin search_path and are not executable by PUBLIC (rule 2).
SET search_path = eureka, public;

SET ROLE eureka_owner;

-- ---------- 1. outbox_event write guard ----------
CREATE FUNCTION eureka.outbox_event_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF current_user IS DISTINCT FROM 'authz_definer' THEN
      RAISE EXCEPTION 'placement data changes only through placement functions'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.created_at := pg_catalog.now();
    NEW.published_at := NULL;
    RETURN NEW;
  END IF;

  IF TG_OP = 'TRUNCATE' OR current_user IS DISTINCT FROM 'eureka_worker' THEN
    RAISE EXCEPTION 'placement data changes only through placement functions'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.published_at IS NOT NULL OR NEW.published_at IS NULL
       OR (to_jsonb(NEW) - 'published_at') IS DISTINCT FROM (to_jsonb(OLD) - 'published_at') THEN
      RAISE EXCEPTION 'outbox events can only be marked published, once'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.published_at := pg_catalog.now();
    RETURN NEW;
  END IF;

  -- DELETE (prune): published events past the retention floor only.
  IF OLD.published_at IS NULL OR NOT coalesce(OLD.published_at < pg_catalog.now() - interval '7 days', false) THEN
    RAISE EXCEPTION 'only events published more than 7 days ago may be pruned'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN OLD;
END $$;

DROP TRIGGER outbox_event_write_guard ON eureka.outbox_event;
CREATE TRIGGER outbox_event_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.outbox_event
  FOR EACH ROW EXECUTE FUNCTION eureka.outbox_event_guard();
CREATE TRIGGER outbox_event_no_truncate BEFORE TRUNCATE ON eureka.outbox_event
  FOR EACH STATEMENT EXECUTE FUNCTION eureka.outbox_event_guard();

-- Prune scans published rows by age.
CREATE INDEX outbox_event_published ON eureka.outbox_event (published_at) WHERE published_at IS NOT NULL;

-- ---------- 3. outbox_delivery ----------
CREATE TABLE eureka.outbox_delivery (
  event_id   uuid NOT NULL REFERENCES eureka.outbox_event(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES eureka.app_user(id),
  status     text NOT NULL DEFAULT 'pending'
             CHECK (status IN ('pending', 'sending', 'sent', 'skipped', 'in_doubt')),
  created_at timestamptz NOT NULL DEFAULT now(),
  attempt_at timestamptz,
  done_at    timestamptz,
  PRIMARY KEY (event_id, user_id),
  CHECK ((status IN ('sent', 'skipped', 'in_doubt')) = (done_at IS NOT NULL))
);
CREATE INDEX outbox_delivery_user ON eureka.outbox_delivery (user_id);

CREATE FUNCTION eureka.outbox_delivery_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'pending' THEN
      RAISE EXCEPTION 'server_managed_field' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.created_at := pg_catalog.now();
    NEW.attempt_at := NULL;
    NEW.done_at := NULL;
    RETURN NEW;
  END IF;

  IF (NEW.event_id, NEW.user_id, NEW.created_at) IS DISTINCT FROM (OLD.event_id, OLD.user_id, OLD.created_at)
     OR NOT coalesce((OLD.status, NEW.status) IN (
       ('pending', 'sending'), ('pending', 'skipped'),
       ('sending', 'sent'), ('sending', 'pending'), ('sending', 'in_doubt')), false) THEN
    RAISE EXCEPTION 'invalid outbox delivery change' USING ERRCODE = 'check_violation';
  END IF;
  NEW.attempt_at := CASE NEW.status WHEN 'sending' THEN pg_catalog.now()
                                    WHEN 'pending' THEN NULL
                                    ELSE OLD.attempt_at END;
  NEW.done_at := CASE WHEN NEW.status IN ('sent', 'skipped', 'in_doubt') THEN pg_catalog.now() END;
  RETURN NEW;
END $$;
CREATE TRIGGER outbox_delivery_guard BEFORE INSERT OR UPDATE ON eureka.outbox_delivery
  FOR EACH ROW EXECUTE FUNCTION eureka.outbox_delivery_guard();

ALTER TABLE eureka.outbox_delivery ENABLE ROW LEVEL SECURITY;
ALTER TABLE eureka.outbox_delivery FORCE ROW LEVEL SECURITY;

-- ---------- 5. idempotency_key cleanup ----------
CREATE INDEX idempotency_key_created ON eureka.idempotency_key (created_at);

RESET ROLE;

REVOKE ALL ON FUNCTION eureka.outbox_event_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION eureka.outbox_delivery_guard() FROM PUBLIC;
REVOKE ALL ON eureka.outbox_delivery FROM PUBLIC;

-- ---------- 2. worker on outbox_event ----------
GRANT SELECT, DELETE ON eureka.outbox_event TO eureka_worker;
GRANT UPDATE (published_at) ON eureka.outbox_event TO eureka_worker;
CREATE POLICY outbox_worker_read ON eureka.outbox_event FOR SELECT TO eureka_worker USING (true);
CREATE POLICY outbox_worker_publish ON eureka.outbox_event FOR UPDATE TO eureka_worker
  USING (published_at IS NULL) WITH CHECK (published_at IS NOT NULL);
CREATE POLICY outbox_worker_prune ON eureka.outbox_event FOR DELETE TO eureka_worker
  USING (published_at < now() - interval '7 days');

-- ---------- 3. worker on outbox_delivery (the app gets nothing) ----------
GRANT SELECT, INSERT (event_id, user_id) ON eureka.outbox_delivery TO eureka_worker;
GRANT UPDATE (status) ON eureka.outbox_delivery TO eureka_worker;
CREATE POLICY outbox_delivery_worker_read ON eureka.outbox_delivery FOR SELECT TO eureka_worker USING (true);
-- Recipients are added only while the event is undelivered.
CREATE POLICY outbox_delivery_worker_insert ON eureka.outbox_delivery FOR INSERT TO eureka_worker
  WITH CHECK (EXISTS (SELECT 1 FROM eureka.outbox_event e
                      WHERE e.id = outbox_delivery.event_id AND e.published_at IS NULL));
CREATE POLICY outbox_delivery_worker_update ON eureka.outbox_delivery FOR UPDATE TO eureka_worker
  USING (status IN ('pending', 'sending')) WITH CHECK (true);

-- ---------- 4. recipient resolution ----------
GRANT SELECT (user_id, role_key, valid) ON eureka.user_role TO eureka_worker;

-- ---------- 5. worker on idempotency_key ----------
GRANT SELECT (key, user_id, endpoint, created_at), DELETE ON eureka.idempotency_key TO eureka_worker;
CREATE POLICY idempotency_worker_read ON eureka.idempotency_key FOR SELECT TO eureka_worker
  USING (created_at < now() - interval '24 hours');
CREATE POLICY idempotency_worker_cleanup ON eureka.idempotency_key FOR DELETE TO eureka_worker
  USING (created_at < now() - interval '24 hours');
