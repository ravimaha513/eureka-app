-- Notifications: independent review of 0046.
--
-- F3  The worker inbox INSERT policy also binds entity_type/entity_id to the
--     event: authz.notification_entity(event) derives them from the event type
--     and its payload (the same mapping as worker/notify-types.ts). Titles and
--     bodies stay worker-rendered from fixed TypeScript templates (residual,
--     docs/notifications.md): bounded by the 0046 CHECKs (length, no control
--     characters), only for the event's recipients, only during its fan-out.
-- F4  bench-time: one reminder per candidate and bench period, whatever the
--     threshold (the worker chooses it; a change no longer re-notifies). The
--     ledger key is candidate:bench_since (0046 keys with a threshold suffix
--     count as already notified). Only candidates that crossed the threshold
--     within p_window_days of the day are notified, so a first enable or a
--     lowered threshold does not flood the recipients with the whole bench.
-- F5  candidate.assigned: the lead and manager come from the candidate's
--     current team (candidate.team_id); a payload teamId that no longer
--     matches yields no recipients (the event stays unpublished and alerts).
--     checklist.item_overdue: assigneeId is trusted from the producer's
--     definer function (eureka.checklist_item has no assignee column on this
--     branch; verified at integration with 0049).
-- Every IF is NULL-safe (rule 1); functions pin search_path, are not
-- executable by PUBLIC and are granted to exactly the worker (rule 2).
SET search_path = eureka, public;

SET ROLE authz_definer;

-- ---------- F3: the entity an inbox row of an event opens ----------
-- One row (entity_type, entity_id) for an unpublished event of an in-app type,
-- none otherwise. Mirrors EVENT_SPECS[type].render(...).inbox.entity.
CREATE FUNCTION authz.notification_entity(p_event uuid)
RETURNS TABLE (entity_type text, entity_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_type text; v_payload jsonb;
BEGIN
  SELECT e.type, e.payload INTO v_type, v_payload
    FROM eureka.outbox_event e WHERE e.id = p_event AND e.published_at IS NULL;
  IF v_type IS NULL THEN
    RETURN;
  END IF;
  IF v_type = 'work_authorization.expiring' THEN
    RETURN QUERY SELECT 'candidate'::text, (v_payload ->> 'candidate_id')::uuid;
  ELSIF v_type IN ('employee.benched', 'assignment.ending_soon', 'checklist.item_overdue') THEN
    RETURN QUERY SELECT 'placement'::text, (v_payload ->> 'placementId')::uuid;
  ELSIF v_type IN ('employee.exited', 'employee.bench_time', 'candidate.assigned') THEN
    RETURN QUERY SELECT 'candidate'::text, (v_payload ->> 'candidateId')::uuid;
  END IF;
END $$;

-- ---------- F5: recipients (candidate.assigned from the candidate's current team) ----------
CREATE OR REPLACE FUNCTION authz.notification_recipients(p_event uuid, p_user uuid DEFAULT NULL)
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
    v_roles := ARRAY(
      SELECT DISTINCT g FROM pg_catalog.jsonb_array_elements_text(
        CASE WHEN pg_catalog.jsonb_typeof(v_payload -> 'notify') = 'array' THEN v_payload -> 'notify' ELSE '[]'::jsonb END) g
       WHERE g IN ('hr', 'accounts', 'immigration'));
  ELSIF v_type = 'work_authorization.expiring' THEN
    v_roles := ARRAY['hr', 'immigration'];
  ELSIF v_type IN ('employee.benched', 'employee.exited') THEN
    v_roles := ARRAY['hr', 'accounts', 'immigration', 'bu_head', 'ceo'];
  ELSIF v_type = 'assignment.ending_soon' THEN
    v_roles := ARRAY['hr', 'accounts'];
  ELSIF v_type = 'employee.bench_time' THEN
    v_roles := ARRAY['ceo'];
    SELECT c.recruiter_id, c.team_id INTO v_rec, v_team
      FROM eureka.candidate c WHERE c.id = (v_payload ->> 'candidateId')::uuid;
  ELSIF v_type = 'candidate.assigned' THEN
    -- The candidate's current team, and only while it is the team the event names.
    SELECT c.team_id INTO v_team FROM eureka.candidate c
     WHERE c.id = (v_payload ->> 'candidateId')::uuid
       AND c.team_id = (v_payload ->> 'teamId')::uuid;
  ELSIF v_type = 'checklist.item_overdue' THEN
    SELECT p.recruiter_id, p.team_id INTO v_rec, v_team
      FROM eureka.placement p WHERE p.id = (v_payload ->> 'placementId')::uuid;
    v_assign := (v_payload ->> 'assigneeId')::uuid;   -- trusted from the producer's definer function
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

-- ---------- F4: bench-time, once per bench period, recent crossings only ----------
-- One `employee.bench_time` event per candidate and bench period (key
-- candidate:bench_since) for candidates on bench whose threshold day
-- (bench_since + p_threshold_days) falls within the p_window_days days up to
-- p_day. p_day is the job's America/New_York date, never a future day.
CREATE FUNCTION authz.emit_bench_time(p_day date, p_threshold_days integer, p_window_days integer)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  n integer := 0;
  r record;
BEGIN
  IF p_day IS NULL OR p_threshold_days IS NULL OR p_window_days IS NULL
     OR p_threshold_days < 1 OR p_threshold_days > 365 OR p_window_days < 1 OR p_window_days > 365
     OR p_day > (pg_catalog.now() AT TIME ZONE 'America/New_York')::date THEN
    RAISE EXCEPTION 'invalid bench-time run' USING ERRCODE = 'check_violation';
  END IF;
  FOR r IN
    SELECT c.id, c.bench_since, c.id::text || ':' || c.bench_since::text AS k
      FROM eureka.candidate c
     WHERE c.marketing_status = 'bench' AND c.bench_since IS NOT NULL
       AND c.bench_since + p_threshold_days <= p_day
       AND c.bench_since + p_threshold_days > p_day - p_window_days
       AND NOT EXISTS (SELECT 1 FROM eureka.notification_ledger l
                        WHERE l.job = 'bench-time'
                          AND (l.key = c.id::text || ':' || c.bench_since::text
                               OR l.key LIKE c.id::text || ':' || c.bench_since::text || ':%'))
     ORDER BY c.bench_since, c.id
     LIMIT 5000
  LOOP
    IF authz.notification_emit_once('bench-time', r.k, 'employee.bench_time', 'candidate', r.id,
         pg_catalog.jsonb_build_object('candidateId', r.id, 'benchSince', r.bench_since,
           'benchDays', p_day - r.bench_since, 'thresholdDays', p_threshold_days)) IS NOT NULL THEN
      n := n + 1;
    END IF;
  END LOOP;
  RETURN n;
END $$;

RESET ROLE;

DROP FUNCTION authz.emit_bench_time(date, integer);

REVOKE ALL ON FUNCTION authz.notification_entity(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.emit_bench_time(date, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.notification_entity(uuid) TO eureka_worker;
GRANT EXECUTE ON FUNCTION authz.emit_bench_time(date, integer, integer) TO eureka_worker;

-- ---------- F3: worker inbox insert bound to the event's entity ----------
DROP POLICY notification_worker_insert ON eureka.notification;
CREATE POLICY notification_worker_insert ON eureka.notification FOR INSERT TO eureka_worker
  WITH CHECK (EXISTS (SELECT 1 FROM eureka.outbox_event e
                       WHERE e.id = notification.event_id AND e.type = notification.type AND e.published_at IS NULL)
              AND NOT EXISTS (SELECT 1 FROM eureka.inbox_fanout f WHERE f.event_id = notification.event_id)
              AND EXISTS (SELECT 1 FROM authz.notification_recipients(notification.event_id, notification.recipient_id))
              AND EXISTS (SELECT 1 FROM authz.notification_entity(notification.event_id) x
                           WHERE x.entity_type = notification.entity_type AND x.entity_id = notification.entity_id));
