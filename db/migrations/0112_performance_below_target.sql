-- "Recruiter activity below target" notification (Eureka App 4 gap L2;
-- docs/performance-api.md PF-6, docs/notifications.md `performance.below_target`).
--   1. authz.emit_performance_below_target(day, window_days): for every target
--      (0110) of an active person whose period has ended on or before `day` (the
--      worker's America/New_York date; a future day is refused) and within the
--      last `window_days` days (so a first enable does not flood recipients with
--      old periods), counts the person's own activity in the period (actor
--      snapshot: submissions by submitted_at, interviews that happen by
--      starts_at, placements by created_at; New York calendar days) and, when any
--      metric with a target fell short, emits one `performance.below_target`
--      event, exactly once per target (ledger job 'performance-below-target', key
--      the target id). Payload: ids, the period kind and start, and counts only.
--   2. authz.notification_recipients / authz.notification_entity replaced on
--      top of 0089 (every earlier branch carried over) with the new type:
--      recipients the person ('recruiter'), the lead of their current team and
--      that lead's manager (without a team: the person's own manager); entity
--      `performance_target` (the target id).
--   3. The notification entity check gains 'performance_target'. Rebuilt from
--      the constraint as it stands (not a hard-coded list), so a branch merged
--      alongside that adds its own entity type keeps it.
-- Every IF is NULL-safe (rule 1); functions pin search_path, are not executable
-- by PUBLIC and are granted to exactly the worker (rule 2).
SET search_path = eureka, public;

SET ROLE authz_definer;

CREATE FUNCTION authz.emit_performance_below_target(p_day date, p_window_days integer)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  n integer := 0;
  r record;
BEGIN
  IF p_day IS NULL OR NOT coalesce(p_day <= (pg_catalog.now() AT TIME ZONE 'America/New_York')::date, false)
     OR NOT coalesce(p_window_days BETWEEN 1 AND 366, false) THEN
    RAISE EXCEPTION 'invalid performance-below-target run' USING ERRCODE = 'check_violation';
  END IF;
  FOR r IN
    WITH due AS (
      SELECT t.id, t.user_id, t.period_kind, t.period_start, t.submissions, t.interviews, t.placements,
             (t.period_start::timestamp AT TIME ZONE 'America/New_York') AS lo,
             (t.period_end::timestamp AT TIME ZONE 'America/New_York') AS hi
        FROM eureka.performance_target t
        JOIN eureka.app_user u ON u.id = t.user_id AND u.status = 'active'
       WHERE t.period_end <= p_day AND t.period_end > p_day - p_window_days
         AND NOT EXISTS (SELECT 1 FROM eureka.notification_ledger l
                          WHERE l.job = 'performance-below-target' AND l.key = t.id::text)
       ORDER BY t.period_end, t.id
       LIMIT 5000)
    SELECT d.*,
      CASE WHEN d.submissions IS NOT NULL THEN (SELECT count(*)::int FROM eureka.submission s
        WHERE s.recruiter_id = d.user_id AND s.submitted_at >= d.lo AND s.submitted_at < d.hi) END AS a_sub,
      CASE WHEN d.interviews IS NOT NULL THEN (SELECT count(*)::int FROM eureka.interview i
        WHERE i.recruiter_id = d.user_id AND i.starts_at >= d.lo AND i.starts_at < d.hi
          AND i.call_status NOT IN ('cancelled', 'rescheduled', 'no_invite')) END AS a_int,
      CASE WHEN d.placements IS NOT NULL THEN (SELECT count(*)::int FROM eureka.placement p
        WHERE p.recruiter_id = d.user_id AND p.created_at >= d.lo AND p.created_at < d.hi) END AS a_pl
      FROM due d
  LOOP
    IF coalesce(r.a_sub < r.submissions, false) OR coalesce(r.a_int < r.interviews, false)
       OR coalesce(r.a_pl < r.placements, false) THEN
      IF authz.notification_emit_once('performance-below-target', r.id::text, 'performance.below_target',
           'performance_target', r.id,
           pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
             'targetId', r.id, 'userId', r.user_id, 'periodKind', r.period_kind, 'periodStart', r.period_start,
             'submissionsTarget', r.submissions, 'submissionsActual', r.a_sub,
             'interviewsTarget', r.interviews, 'interviewsActual', r.a_int,
             'placementsTarget', r.placements, 'placementsActual', r.a_pl))) IS NOT NULL THEN
        n := n + 1;
      END IF;
    END IF;
  END LOOP;
  RETURN n;
END $$;

-- 0089's resolver (0051 + 0052 + 0062 + 0070 + 0089 branches) with performance.below_target.
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
  v_chat    uuid;
  v_hiring  uuid;
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
    SELECT c.team_id INTO v_team FROM eureka.candidate c
     WHERE c.id = (v_payload ->> 'candidateId')::uuid
       AND c.team_id = (v_payload ->> 'teamId')::uuid;
  ELSIF v_type = 'checklist.item_overdue' THEN
    SELECT p.recruiter_id, p.team_id INTO v_rec, v_team
      FROM eureka.placement p WHERE p.id = (v_payload ->> 'placementId')::uuid;
    -- 0052: the assignee only when the payload names the item's current assignee.
    SELECT ci.assignee_id INTO v_assign FROM eureka.checklist_item ci
     WHERE ci.id = (v_payload ->> 'checklistItemId')::uuid
       AND ci.placement_id = (v_payload ->> 'placementId')::uuid
       AND ci.assignee_id = (v_payload ->> 'assigneeId')::uuid;
  ELSIF v_type = 'application.received' THEN
    -- jobs-portal (0062): HR and the job's current hiring manager.
    v_roles := ARRAY['hr'];
    SELECT j.hiring_manager_id INTO v_hiring FROM eureka.job_application a JOIN eureka.job j ON j.id = a.job_id
     WHERE a.id = (v_payload ->> 'applicationId')::uuid AND a.job_id = (v_payload ->> 'jobId')::uuid;
  ELSIF v_type = 'chat.direct_message' THEN
    SELECT m.user_id INTO v_chat
      FROM eureka.chat_conversation c
      JOIN eureka.chat_member m ON m.conversation_id = c.id AND m.left_at IS NULL
     WHERE c.id = (v_payload ->> 'conversationId')::uuid AND c.kind = 'direct' AND c.deleted_at IS NULL
       AND m.user_id = (v_payload ->> 'recipientId')::uuid;
  ELSIF v_type = 'interview.requested' THEN
    -- interview-alerts (0089): the support team that coordinates interviews.
    v_roles := ARRAY['interview_coordinator'];
  ELSIF v_type = 'contract.created' THEN
    -- interview-alerts (0086): invoicing and the closure documents.
    v_roles := ARRAY['hr', 'associate_hr', 'accounts'];
  ELSIF v_type = 'staff.birthdays_today' THEN
    -- interview-alerts (0087): the CEO's morning digest.
    v_roles := ARRAY['ceo'];
  ELSIF v_type = 'performance.below_target' THEN
    -- performance (0112): the target's person (only while the payload names the
    -- target's current person), the lead of their current team (or of the team
    -- they lead) and that lead's manager; without a team, their own manager.
    SELECT pt.user_id INTO v_rec FROM eureka.performance_target pt
     WHERE pt.id = (v_payload ->> 'targetId')::uuid AND pt.user_id = (v_payload ->> 'userId')::uuid;
    IF v_rec IS NOT NULL THEN
      SELECT tm.team_id INTO v_team FROM eureka.team_member tm
       WHERE tm.user_id = v_rec AND tm.valid @> pg_catalog.now() ORDER BY tm.team_id LIMIT 1;
      IF v_team IS NULL THEN
        SELECT t.id INTO v_team FROM eureka.team t WHERE t.lead_id = v_rec ORDER BY t.id LIMIT 1;
      END IF;
      IF v_team IS NULL THEN
        SELECT rl.manager_id INTO v_mgr FROM eureka.reporting_line rl
         WHERE rl.user_id = v_rec AND rl.valid @> pg_catalog.now();
      END IF;
    END IF;
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
    UNION ALL SELECT v_hiring, 'hiring_manager' WHERE v_hiring IS NOT NULL
    UNION ALL SELECT v_chat, 'chat' WHERE v_chat IS NOT NULL
  )
  SELECT DISTINCT r.uid, r.why FROM r JOIN eureka.app_user u ON u.id = r.uid
   WHERE u.status = 'active' AND (p_user IS NULL OR r.uid = p_user);
END $$;

-- 0089's entity mapping with performance.below_target (a later migration replacing this function must carry every branch over).
CREATE OR REPLACE FUNCTION authz.notification_entity(p_event uuid)
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
  ELSIF v_type IN ('employee.benched', 'assignment.ending_soon', 'checklist.item_overdue', 'contract.created') THEN
    RETURN QUERY SELECT 'placement'::text, (v_payload ->> 'placementId')::uuid;
  ELSIF v_type IN ('employee.exited', 'employee.bench_time', 'candidate.assigned') THEN
    RETURN QUERY SELECT 'candidate'::text, (v_payload ->> 'candidateId')::uuid;
  ELSIF v_type = 'application.received' THEN
    RETURN QUERY SELECT 'application'::text, (v_payload ->> 'applicationId')::uuid;
  ELSIF v_type = 'chat.direct_message' THEN
    RETURN QUERY SELECT 'conversation'::text, (v_payload ->> 'conversationId')::uuid;
  ELSIF v_type = 'interview.requested' THEN
    RETURN QUERY SELECT 'interview'::text, (v_payload ->> 'interviewId')::uuid;
  ELSIF v_type = 'staff.birthdays_today' THEN
    RETURN QUERY SELECT 'digest'::text, p_event;
  ELSIF v_type = 'performance.below_target' THEN
    RETURN QUERY SELECT 'performance_target'::text, (v_payload ->> 'targetId')::uuid;
  END IF;
END $$;
RESET ROLE;

REVOKE ALL ON FUNCTION authz.emit_performance_below_target(date, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.notification_recipients(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.notification_entity(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.emit_performance_below_target(date, integer) TO eureka_worker;
GRANT EXECUTE ON FUNCTION authz.notification_recipients(uuid, uuid) TO eureka_worker;
GRANT EXECUTE ON FUNCTION authz.notification_entity(uuid) TO eureka_worker;

-- The definer reads targets for the resolver (0110 gave it SELECT and a read policy).
SET ROLE eureka_owner;
DO $$
DECLARE def text; vals text[];
BEGIN
  SELECT pg_catalog.pg_get_constraintdef(c.oid) INTO def FROM pg_catalog.pg_constraint c
   WHERE c.conrelid = 'eureka.notification'::regclass AND c.conname = 'notification_entity_type_check';
  IF def IS NULL THEN
    RAISE EXCEPTION 'notification_entity_type_check is missing';
  END IF;
  vals := ARRAY(SELECT m[1] FROM pg_catalog.regexp_matches(def, '''([a-z_]+)''', 'g') AS m);
  IF NOT ('performance_target' = ANY (vals)) THEN
    vals := vals || 'performance_target'::text;
  END IF;
  ALTER TABLE eureka.notification DROP CONSTRAINT notification_entity_type_check;
  -- Written as an IN list, as 0046-0089 did, so the definition keeps quoting each value.
  EXECUTE pg_catalog.format('ALTER TABLE eureka.notification ADD CONSTRAINT notification_entity_type_check CHECK (entity_type IN (%s))',
    (SELECT pg_catalog.string_agg(pg_catalog.quote_literal(v), ', ') FROM pg_catalog.unnest(vals) AS v));
END $$;
RESET ROLE;
