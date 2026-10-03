-- Notifications: in-app inbox, generalised outbox recipients, scheduled
-- reminder emission (design A4 "notifications", B2.5, B6; FR-NTF-02..05,
-- 09..11; docs/notifications.md is the event-type contract).
--
-- 1. eureka.notification: one in-app inbox row per (outbox event, recipient).
--    Ids, the event type, the entity to open (placement or candidate) and a
--    fixed title/body rendered by the worker from the event type: no names,
--    rates, contacts or free text (rule 5 applied to the inbox as well).
--      INSERT  only eureka_worker, only for an unpublished outbox event of the
--              same type whose inbox fan-out is not recorded yet; the server
--              sets created_at and read_at starts NULL;
--      SELECT  eureka_app: the recipient's own rows only (RLS, InitPlan);
--      UPDATE  eureka_app: the recipient's own rows, read_at only; the server
--              sets the time (first read kept), NULL marks unread;
--      DELETE  only eureka_worker, only rows older than 30 days (the prune
--              job's configurable retention cannot go below this floor).
--    Every other writer (the owner, a superuser) is refused by the trigger.
-- 2. eureka.inbox_fanout: the per-event marker that the in-app recipients were
--    recorded (once, in the same transaction as the rows), so retries never
--    add or duplicate inbox rows. Removed only with its pruned event.
-- 3. authz.notification_recipients(event, user): the recipients of an
--    unpublished outbox event by type (role holders and/or the people around
--    the candidate or placement), active users only. Used for the fan-out and
--    for the re-check before each email. SECURITY DEFINER so the worker needs
--    no read access to candidate or placement rows.
-- 4. eureka.notification_ledger + authz.notification_emit_once: durable
--    "emitted once" keys for scheduled reminders (outbox rows are pruned after
--    30 days; the ledger is not), callable from authz_definer functions only.
--    authz.emit_bench_time(day, threshold): the bench-time job (FR-NTF-05).
-- 5. job_run is untouched: inbox-only runs use run key 'inbox:<event id>'
--    under the existing outbox-delivery job, so 0029's retention applies.
-- Every IF is NULL-safe (rule 1); functions pin search_path, are not
-- executable by PUBLIC and are granted to exactly the role that needs them
-- (rule 2).
SET search_path = eureka, public;

SET ROLE eureka_owner;

-- ---------- 1. notification ----------
CREATE TABLE eureka.notification (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id uuid NOT NULL REFERENCES eureka.app_user(id),
  event_id     uuid NOT NULL,          -- outbox_event id; no FK: the inbox outlives the pruned event
  type         text NOT NULL CHECK (type ~ '^[a-z][a-z_]*\.[a-z][a-z_]*$' AND char_length(type) <= 80),
  entity_type  text NOT NULL CHECK (entity_type IN ('placement', 'candidate')),
  entity_id    uuid NOT NULL,
  title        text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160 AND title !~ '[[:cntrl:]]'),
  body         text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 600 AND body !~ '[[:cntrl:]]'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  read_at      timestamptz,
  UNIQUE (event_id, recipient_id)
);
-- Inbox page (newest first, keyset cursor) and unread count per user.
CREATE INDEX notification_inbox ON eureka.notification (recipient_id, created_at DESC, id DESC);
CREATE INDEX notification_unread ON eureka.notification (recipient_id) WHERE read_at IS NULL;
-- Prune by age.
CREATE INDEX notification_created ON eureka.notification (created_at);

CREATE FUNCTION eureka.notification_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'notifications are never truncated' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF current_user IS DISTINCT FROM 'eureka_worker' THEN
      RAISE EXCEPTION 'notifications are written only by the notification worker'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.created_at := pg_catalog.now();
    NEW.read_at := NULL;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF current_user IS DISTINCT FROM 'eureka_app'
       OR (pg_catalog.to_jsonb(NEW) - 'read_at') IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - 'read_at') THEN
      RAISE EXCEPTION 'only the read mark of a notification can change'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- The server sets the time; marking an already read row read keeps the first time.
    NEW.read_at := CASE WHEN NEW.read_at IS NULL THEN NULL ELSE coalesce(OLD.read_at, pg_catalog.now()) END;
    RETURN NEW;
  END IF;

  -- DELETE (prune): the worker, rows past the retention floor only.
  IF current_user IS DISTINCT FROM 'eureka_worker'
     OR NOT coalesce(OLD.created_at < pg_catalog.now() - interval '30 days', false) THEN
    RAISE EXCEPTION 'only notifications older than 30 days may be pruned'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER notification_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.notification
  FOR EACH ROW EXECUTE FUNCTION eureka.notification_guard();
CREATE TRIGGER notification_no_truncate BEFORE TRUNCATE ON eureka.notification
  FOR EACH STATEMENT EXECUTE FUNCTION eureka.notification_guard();

ALTER TABLE eureka.notification ENABLE ROW LEVEL SECURITY;
ALTER TABLE eureka.notification FORCE ROW LEVEL SECURITY;

-- ---------- 2. inbox_fanout ----------
CREATE TABLE eureka.inbox_fanout (
  event_id   uuid PRIMARY KEY REFERENCES eureka.outbox_event(id) ON DELETE CASCADE,
  recipients integer NOT NULL CHECK (recipients BETWEEN 1 AND 100000),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION eureka.inbox_fanout_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF current_user IS DISTINCT FROM 'eureka_worker' THEN
      RAISE EXCEPTION 'inbox fan-out is recorded only by the notification worker'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.created_at := pg_catalog.now();
    RETURN NEW;
  END IF;
  -- Only the cascade from a pruned outbox_event (runs as the table owner
  -- inside the referential trigger); no update, direct delete or truncate.
  IF TG_OP = 'DELETE' AND coalesce(pg_catalog.pg_trigger_depth() > 1 AND current_user = 'eureka_owner', false) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'inbox fan-out markers are removed only with their event'
    USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER inbox_fanout_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.inbox_fanout
  FOR EACH ROW EXECUTE FUNCTION eureka.inbox_fanout_guard();
CREATE TRIGGER inbox_fanout_no_truncate BEFORE TRUNCATE ON eureka.inbox_fanout
  FOR EACH STATEMENT EXECUTE FUNCTION eureka.inbox_fanout_guard();

ALTER TABLE eureka.inbox_fanout ENABLE ROW LEVEL SECURITY;
ALTER TABLE eureka.inbox_fanout FORCE ROW LEVEL SECURITY;

-- ---------- 4. notification_ledger ----------
CREATE TABLE eureka.notification_ledger (
  job        text NOT NULL CHECK (job ~ '^[a-z][a-z0-9-]{0,39}$'),
  key        text NOT NULL CHECK (char_length(key) BETWEEN 1 AND 200 AND key !~ '[[:cntrl:]]'),
  event_id   uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job, key)
);

CREATE FUNCTION eureka.notification_ledger_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' AND current_user = 'authz_definer' THEN
    NEW.created_at := pg_catalog.now();
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'notification_ledger is append-only, written by notification functions'
    USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER notification_ledger_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.notification_ledger
  FOR EACH ROW EXECUTE FUNCTION eureka.notification_ledger_guard();
CREATE TRIGGER notification_ledger_no_truncate BEFORE TRUNCATE ON eureka.notification_ledger
  FOR EACH STATEMENT EXECUTE FUNCTION eureka.notification_ledger_guard();

ALTER TABLE eureka.notification_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE eureka.notification_ledger FORCE ROW LEVEL SECURITY;

RESET ROLE;

REVOKE ALL ON FUNCTION eureka.notification_guard(), eureka.inbox_fanout_guard(),
  eureka.notification_ledger_guard() FROM PUBLIC;
REVOKE ALL ON eureka.notification, eureka.inbox_fanout, eureka.notification_ledger FROM PUBLIC;

-- ---------- grants and policies: notification ----------
-- The recipient reads and marks their own rows (InitPlan, rule 3).
GRANT SELECT ON eureka.notification TO eureka_app;
GRANT UPDATE (read_at) ON eureka.notification TO eureka_app;
CREATE POLICY notification_own_read ON eureka.notification FOR SELECT TO eureka_app
  USING (recipient_id = (SELECT authz.current_user_id()));
CREATE POLICY notification_own_mark ON eureka.notification FOR UPDATE TO eureka_app
  USING (recipient_id = (SELECT authz.current_user_id()))
  WITH CHECK (recipient_id = (SELECT authz.current_user_id()));

-- The worker writes rows during an event's fan-out and prunes old ones; it
-- reads only the key columns (never titles or bodies).
GRANT SELECT (id, event_id, recipient_id, created_at) ON eureka.notification TO eureka_worker;
GRANT INSERT (recipient_id, event_id, type, entity_type, entity_id, title, body) ON eureka.notification TO eureka_worker;
GRANT DELETE ON eureka.notification TO eureka_worker;
CREATE POLICY notification_worker_read ON eureka.notification FOR SELECT TO eureka_worker USING (true);
-- notification_worker_insert is created at the end (it calls authz.notification_recipients).
CREATE POLICY notification_worker_prune ON eureka.notification FOR DELETE TO eureka_worker
  USING (created_at < now() - interval '30 days');

-- ---------- grants and policies: inbox_fanout (the app gets nothing) ----------
GRANT SELECT, INSERT (event_id, recipients) ON eureka.inbox_fanout TO eureka_worker;
CREATE POLICY inbox_fanout_worker_read ON eureka.inbox_fanout FOR SELECT TO eureka_worker USING (true);
CREATE POLICY inbox_fanout_worker_insert ON eureka.inbox_fanout FOR INSERT TO eureka_worker
  WITH CHECK (EXISTS (SELECT 1 FROM eureka.outbox_event e
                       WHERE e.id = inbox_fanout.event_id AND e.published_at IS NULL));

-- ---------- grants and policies: ledger (definer only) ----------
GRANT SELECT, INSERT ON eureka.notification_ledger TO authz_definer;
CREATE POLICY definer_read ON eureka.notification_ledger FOR SELECT TO authz_definer USING (true);
CREATE POLICY definer_insert ON eureka.notification_ledger FOR INSERT TO authz_definer WITH CHECK (true);

-- The recipient resolver reads unpublished outbox events (ids, type, payload).
GRANT SELECT (id, type, payload, published_at) ON eureka.outbox_event TO authz_definer;
CREATE POLICY definer_read ON eureka.outbox_event FOR SELECT TO authz_definer USING (true);

-- ---------- 3. recipients ----------
SET ROLE authz_definer;

-- Recipients of an unpublished outbox event (docs/notifications.md). One row
-- per (user, reason); a user may appear with several reasons. Only active
-- users; role holders only while the role is valid now. p_user limits the
-- result to one user (the re-check before a send). Unknown types, published or
-- missing events: no rows.
CREATE FUNCTION authz.notification_recipients(p_event uuid, p_user uuid DEFAULT NULL)
RETURNS TABLE (recipient_id uuid, reason text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_type    text;
  v_payload jsonb;
  v_roles   text[] := '{}';
  v_rec     uuid;
  v_team    uuid;
  v_lead    uuid;
  v_mgr     uuid;
  v_assign  uuid;
BEGIN
  SELECT e.type, e.payload INTO v_type, v_payload
    FROM eureka.outbox_event e WHERE e.id = p_event AND e.published_at IS NULL;
  IF v_type IS NULL THEN
    RETURN;
  END IF;

  IF v_type IN ('placement.created', 'placement.state_changed') THEN
    -- The groups the placement function named (0022/0023), limited to the known three.
    v_roles := ARRAY(
      SELECT DISTINCT g FROM pg_catalog.jsonb_array_elements_text(
        CASE WHEN pg_catalog.jsonb_typeof(v_payload -> 'notify') = 'array' THEN v_payload -> 'notify' ELSE '[]'::jsonb END) g
       WHERE g IN ('hr', 'accounts', 'immigration'));
  ELSIF v_type = 'work_authorization.expiring' THEN      -- FR-NTF-11
    v_roles := ARRAY['hr', 'immigration'];
  ELSIF v_type = 'employee.exited' THEN                  -- FR-NTF-09: admin teams, BU, CEO
    v_roles := ARRAY['hr', 'accounts', 'immigration', 'bu_head', 'ceo'];
  ELSIF v_type = 'assignment.ending_soon' THEN           -- not in design: conservative default
    v_roles := ARRAY['hr', 'accounts'];
  ELSIF v_type = 'employee.benched' THEN                 -- FR-NTF-05: TL, recruiter, manager, CEO
    v_roles := ARRAY['ceo'];
    SELECT c.recruiter_id, c.team_id INTO v_rec, v_team
      FROM eureka.candidate c WHERE c.id = (v_payload ->> 'candidateId')::uuid;
  ELSIF v_type = 'candidate.assigned' THEN               -- FR-NTF-10: the new Lead and Manager
    v_team := (v_payload ->> 'teamId')::uuid;
  ELSIF v_type = 'checklist.item_overdue' THEN           -- FR-NTF-04 (TL, recruiter, manager); FR-NTF-03 (assignee)
    SELECT p.recruiter_id, p.team_id INTO v_rec, v_team
      FROM eureka.placement p WHERE p.id = (v_payload ->> 'placementId')::uuid;
    v_assign := (v_payload ->> 'assigneeId')::uuid;
  ELSE
    RETURN;
  END IF;

  IF v_team IS NOT NULL THEN
    SELECT t.lead_id INTO v_lead FROM eureka.team t WHERE t.id = v_team;
  END IF;
  IF v_lead IS NOT NULL THEN
    SELECT rl.manager_id INTO v_mgr FROM eureka.reporting_line rl
     WHERE rl.user_id = v_lead AND rl.valid @> pg_catalog.now();
  END IF;

  RETURN QUERY
  WITH r(uid, why) AS (
    SELECT ur.user_id, ur.role_key FROM eureka.user_role ur
     WHERE ur.role_key = ANY (v_roles) AND ur.valid @> pg_catalog.now()
    UNION ALL SELECT v_rec, 'recruiter' WHERE v_rec IS NOT NULL
    UNION ALL SELECT v_lead, 'lead' WHERE v_lead IS NOT NULL
    UNION ALL SELECT v_mgr, 'manager' WHERE v_mgr IS NOT NULL
    UNION ALL SELECT ur.user_id, 'documents_team' FROM eureka.user_role ur
     WHERE v_assign IS NOT NULL AND ur.user_id = v_assign AND ur.role_key = 'documents_team'
       AND ur.valid @> pg_catalog.now()
  )
  SELECT DISTINCT r.uid, r.why FROM r JOIN eureka.app_user u ON u.id = r.uid
   WHERE u.status = 'active' AND (p_user IS NULL OR r.uid = p_user);
END $$;

-- ---------- 4. emit once ----------
-- Records (job, key) in the ledger and, the first time only, writes the
-- outbox event. Returns the new event id, or NULL when already emitted. For
-- other authz_definer functions (scheduled detection); nobody else may call it.
CREATE FUNCTION authz.notification_emit_once(
  p_job text, p_key text, p_type text, p_aggregate_type text, p_aggregate_id uuid, p_payload jsonb)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE ev uuid := pg_catalog.gen_random_uuid();
BEGIN
  INSERT INTO eureka.notification_ledger (job, key, event_id) VALUES (p_job, p_key, ev)
  ON CONFLICT (job, key) DO NOTHING;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  INSERT INTO eureka.outbox_event (id, type, aggregate_type, aggregate_id, payload)
  VALUES (ev, p_type, p_aggregate_type, p_aggregate_id, p_payload);
  RETURN ev;
END $$;

-- FR-NTF-05 bench-time: one `employee.benched` event per candidate and bench
-- period once the candidate has been on bench for p_threshold_days as of
-- p_day (the job's America/New_York date; never a future day). Returns the
-- number of events written. Ids, dates and counts only in the payload.
CREATE FUNCTION authz.emit_bench_time(p_day date, p_threshold_days integer)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  n integer := 0;
  r record;
BEGIN
  IF p_day IS NULL OR p_threshold_days IS NULL OR p_threshold_days < 1 OR p_threshold_days > 365
     OR p_day > (pg_catalog.now() AT TIME ZONE 'America/New_York')::date THEN
    RAISE EXCEPTION 'invalid bench-time run' USING ERRCODE = 'check_violation';
  END IF;
  FOR r IN
    SELECT c.id, c.bench_since,
           c.id::text || ':' || c.bench_since::text || ':' || p_threshold_days::text AS k
      FROM eureka.candidate c
     WHERE c.marketing_status = 'bench' AND c.bench_since IS NOT NULL
       AND c.bench_since <= p_day - p_threshold_days
       AND NOT EXISTS (SELECT 1 FROM eureka.notification_ledger l
                        WHERE l.job = 'bench-time'
                          AND l.key = c.id::text || ':' || c.bench_since::text || ':' || p_threshold_days::text)
     ORDER BY c.bench_since, c.id
     LIMIT 5000
  LOOP
    IF authz.notification_emit_once('bench-time', r.k, 'employee.benched', 'candidate', r.id,
         pg_catalog.jsonb_build_object('candidateId', r.id, 'benchSince', r.bench_since,
           'benchDays', p_day - r.bench_since, 'thresholdDays', p_threshold_days)) IS NOT NULL THEN
      n := n + 1;
    END IF;
  END LOOP;
  RETURN n;
END $$;

RESET ROLE;

REVOKE ALL ON FUNCTION authz.notification_recipients(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.notification_emit_once(text, text, text, text, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.emit_bench_time(date, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.notification_recipients(uuid, uuid) TO eureka_worker;
GRANT EXECUTE ON FUNCTION authz.emit_bench_time(date, integer) TO eureka_worker;

-- ---------- worker inbox insert policy (needs the resolver above) ----------
-- Only for a real, unpublished event of the same type, before its fan-out is
-- recorded, and only for a user the database itself names as a recipient
-- (a few rows per event; the resolver runs per inserted row, never on reads).
CREATE POLICY notification_worker_insert ON eureka.notification FOR INSERT TO eureka_worker
  WITH CHECK (EXISTS (SELECT 1 FROM eureka.outbox_event e
                       WHERE e.id = notification.event_id AND e.type = notification.type AND e.published_at IS NULL)
              AND NOT EXISTS (SELECT 1 FROM eureka.inbox_fanout f WHERE f.event_id = notification.event_id)
              AND EXISTS (SELECT 1 FROM authz.notification_recipients(notification.event_id, notification.recipient_id)));
