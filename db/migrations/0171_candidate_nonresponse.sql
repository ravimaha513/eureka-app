-- "Candidate not responding" (gap list "Notifications"; SRS FR-NTF-02
-- candidate-unresponsive; contract docs/pipeline-vendors-api.md PV-5..PV-8 and
-- docs/notifications.md `candidate.not_responding`).
--
-- Nothing in the data recorded a candidate's response, so Sales flag it:
--   1. eureka.candidate_nonresponse: one open flag per candidate at a time
--      (reason code, who/when), resolved with a code (`responded`,
--      `flagged_in_error`). No free text (rule 5).
--   2. authz.nonresponse_flag / authz.nonresponse_resolve (eureka_app): the
--      database re-checks candidate:read over the candidate (404
--      `candidate_not_found`) and candidate:update ownership (403
--      `not_permitted`: the recruiter, lead, manager and AD who own the
--      candidate; never through Open to all teams). Flagging emits one
--      `candidate.not_responding` event (stage `warning`) to the candidate's
--      recruiter and team lead, and queues the warning email to the candidate.
--   3. authz.emit_candidate_nonresponse_hold(day, hold_days) (eureka_worker,
--      daily job `candidate-nonresponse`): a flag still open `hold_days` after
--      it was raised reaches the hold stage once: a second event (stage `hold`:
--      "decide whether to put marketing on hold or stop it") and the
--      candidate's final notice. Marketing status is never changed
--      automatically; Sales decide.
--   4. Candidate emails (worker job `candidate-nonresponse-mail`, sent with the
--      candidate-facing feedback mail transport): authz.nonresponse_mail_due /
--      _data / _sent. The address is read inside the send transaction under a
--      row lock on the flag, so a flag resolved meanwhile is never mailed; a
--      stage is mailed at most once per flag (sent_at), only within 14 days of
--      the stage (no backlog flood when mail is first enabled), and never for
--      placed, terminated or stopped candidates.
--   5. The notification registry (authz.notification_recipients and
--      authz.notification_entity, last replaced by 0089) gains the type.
--      Every branch of 0089 is carried over unchanged; a later migration
--      replacing them must carry the `candidate.not_responding` branch over.
-- RLS: flags are readable wherever the candidate is (EXISTS by primary key).
-- Every IF is NULL-safe (rule 1); functions pin search_path, are not
-- executable by PUBLIC and are granted to exactly the role that needs them.
SET search_path = eureka, public;

SET ROLE eureka_owner;

CREATE TABLE eureka.candidate_nonresponse (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id    uuid NOT NULL REFERENCES eureka.candidate(id),
  reason          text NOT NULL CHECK (reason IN
    ('no_reply_calls', 'no_reply_messages', 'missed_interview', 'missed_assessment', 'other')),
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolution      text CHECK (resolution IN ('responded', 'flagged_in_error')),
  flagged_by      uuid NOT NULL REFERENCES eureka.app_user(id),
  flagged_at      timestamptz NOT NULL DEFAULT now(),
  resolved_by     uuid REFERENCES eureka.app_user(id),
  resolved_at     timestamptz,
  -- Server-managed progress of the reminders.
  hold_reached_at timestamptz,
  warning_mail_sent_at timestamptz,
  hold_mail_sent_at    timestamptz,
  CONSTRAINT nonresponse_resolved CHECK (
    (status = 'open' AND resolution IS NULL AND resolved_by IS NULL AND resolved_at IS NULL)
    OR (status = 'resolved' AND resolution IS NOT NULL AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL))
);
CREATE UNIQUE INDEX candidate_nonresponse_open ON eureka.candidate_nonresponse (candidate_id) WHERE status = 'open';
CREATE INDEX candidate_nonresponse_candidate ON eureka.candidate_nonresponse (candidate_id, flagged_at DESC);
CREATE INDEX candidate_nonresponse_due ON eureka.candidate_nonresponse (flagged_at) WHERE status = 'open';

CREATE FUNCTION eureka.candidate_nonresponse_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'non-response flags are never truncated' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF current_user IS DISTINCT FROM 'authz_definer' THEN
    RAISE EXCEPTION 'non-response flags are written only by the non-response functions' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'non-response flags are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.status := 'open';
    NEW.resolution := NULL; NEW.resolved_by := NULL; NEW.resolved_at := NULL;
    NEW.flagged_at := pg_catalog.now();
    NEW.hold_reached_at := NULL; NEW.warning_mail_sent_at := NULL; NEW.hold_mail_sent_at := NULL;
  ELSIF (NEW.candidate_id, NEW.reason, NEW.flagged_by, NEW.flagged_at)
        IS DISTINCT FROM (OLD.candidate_id, OLD.reason, OLD.flagged_by, OLD.flagged_at)
        OR (OLD.status = 'resolved' AND (NEW.status, NEW.resolution, NEW.resolved_by, NEW.resolved_at)
            IS DISTINCT FROM (OLD.status, OLD.resolution, OLD.resolved_by, OLD.resolved_at)) THEN
    RAISE EXCEPTION 'immutable non-response field' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER candidate_nonresponse_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.candidate_nonresponse
  FOR EACH ROW EXECUTE FUNCTION eureka.candidate_nonresponse_guard();
CREATE TRIGGER candidate_nonresponse_no_truncate BEFORE TRUNCATE ON eureka.candidate_nonresponse
  FOR EACH STATEMENT EXECUTE FUNCTION eureka.candidate_nonresponse_guard();

ALTER TABLE eureka.candidate_nonresponse ENABLE ROW LEVEL SECURITY;
ALTER TABLE eureka.candidate_nonresponse FORCE ROW LEVEL SECURITY;
CREATE POLICY candidate_nonresponse_read ON eureka.candidate_nonresponse FOR SELECT TO eureka_app
  USING (EXISTS (SELECT 1 FROM eureka.candidate c WHERE c.id = candidate_nonresponse.candidate_id));
CREATE POLICY definer_read   ON eureka.candidate_nonresponse FOR SELECT TO authz_definer USING (true);
CREATE POLICY definer_insert ON eureka.candidate_nonresponse FOR INSERT TO authz_definer WITH CHECK (true);
CREATE POLICY definer_update ON eureka.candidate_nonresponse FOR UPDATE TO authz_definer USING (true) WITH CHECK (true);

RESET ROLE;

REVOKE ALL ON eureka.candidate_nonresponse FROM PUBLIC;
GRANT SELECT ON eureka.candidate_nonresponse TO eureka_app;
GRANT SELECT, INSERT, UPDATE ON eureka.candidate_nonresponse TO authz_definer;
REVOKE ALL ON FUNCTION eureka.candidate_nonresponse_guard() FROM PUBLIC;

-- ---------- definer functions ----------
SET ROLE authz_definer;

-- API: flag a candidate as not responding.
CREATE FUNCTION authz.nonresponse_flag(p_candidate uuid, p_reason text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_id uuid; v_status text;
BEGIN
  SELECT c.marketing_status INTO v_status FROM eureka.candidate c WHERE c.id = p_candidate FOR SHARE;
  IF v_status IS NULL OR authz.current_user_id() IS NULL OR NOT authz.candidate_visible(p_candidate, 'candidate:read') THEN
    RAISE EXCEPTION 'candidate_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT authz.candidate_owned(p_candidate, 'candidate:update') THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_reason IS NULL OR p_reason NOT IN ('no_reply_calls', 'no_reply_messages', 'missed_interview', 'missed_assessment', 'other') THEN
    RAISE EXCEPTION 'invalid_reason' USING ERRCODE = 'check_violation';
  END IF;
  IF v_status IN ('placed', 'terminated', 'stopped') THEN
    RAISE EXCEPTION 'candidate_not_marketed' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM eureka.candidate_nonresponse f WHERE f.candidate_id = p_candidate AND f.status = 'open') THEN
    RAISE EXCEPTION 'already_flagged' USING ERRCODE = 'unique_violation';
  END IF;
  INSERT INTO eureka.candidate_nonresponse (candidate_id, reason, flagged_by)
  VALUES (p_candidate, p_reason, authz.current_user_id())
  RETURNING id INTO v_id;
  -- Ids and the stage only (rule 5); recipients come from the registry.
  PERFORM authz.notification_emit_once('candidate-nonresponse', v_id::text || ':warning',
    'candidate.not_responding', 'candidate', p_candidate,
    pg_catalog.jsonb_build_object('candidateId', p_candidate, 'flagId', v_id, 'stage', 'warning'));
  RETURN v_id;
END $$;

-- API: the candidate responded, or the flag was raised in error.
CREATE FUNCTION authz.nonresponse_resolve(p_candidate uuid, p_resolution text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  IF p_candidate IS NULL OR authz.current_user_id() IS NULL OR NOT authz.candidate_visible(p_candidate, 'candidate:read') THEN
    RAISE EXCEPTION 'candidate_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT authz.candidate_owned(p_candidate, 'candidate:update') THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_resolution IS NULL OR p_resolution NOT IN ('responded', 'flagged_in_error') THEN
    RAISE EXCEPTION 'invalid_resolution' USING ERRCODE = 'check_violation';
  END IF;
  SELECT f.id INTO v_id FROM eureka.candidate_nonresponse f
   WHERE f.candidate_id = p_candidate AND f.status = 'open' FOR UPDATE;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'not_flagged' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE eureka.candidate_nonresponse
     SET status = 'resolved', resolution = p_resolution, resolved_by = authz.current_user_id(), resolved_at = pg_catalog.now()
   WHERE id = v_id;
  RETURN v_id;
END $$;

-- Worker (daily job candidate-nonresponse): flags still open p_hold_days
-- after they were raised (New York dates) reach the hold stage once.
CREATE FUNCTION authz.emit_candidate_nonresponse_hold(p_day date, p_hold_days integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE n integer := 0; r record;
BEGIN
  IF p_day IS NULL OR NOT coalesce(p_day <= (pg_catalog.now() AT TIME ZONE 'America/New_York')::date, false)
     OR p_hold_days IS NULL OR p_hold_days < 1 OR p_hold_days > 60 THEN
    RAISE EXCEPTION 'invalid candidate-nonresponse run' USING ERRCODE = 'check_violation';
  END IF;
  FOR r IN
    SELECT f.id, f.candidate_id
      FROM eureka.candidate_nonresponse f
      JOIN eureka.candidate c ON c.id = f.candidate_id
     WHERE f.status = 'open' AND f.hold_reached_at IS NULL
       AND (f.flagged_at AT TIME ZONE 'America/New_York')::date <= p_day - p_hold_days
       AND c.marketing_status NOT IN ('placed', 'terminated', 'stopped')
     ORDER BY f.flagged_at, f.id
     LIMIT 5000
     FOR UPDATE OF f
  LOOP
    UPDATE eureka.candidate_nonresponse SET hold_reached_at = pg_catalog.now() WHERE id = r.id;
    IF authz.notification_emit_once('candidate-nonresponse', r.id::text || ':hold',
         'candidate.not_responding', 'candidate', r.candidate_id,
         pg_catalog.jsonb_build_object('candidateId', r.candidate_id, 'flagId', r.id, 'stage', 'hold')) IS NOT NULL THEN
      n := n + 1;
    END IF;
  END LOOP;
  RETURN n;
END $$;

-- Worker (job candidate-nonresponse-mail): candidate emails due, as run keys "<flag id>:<stage>".
CREATE FUNCTION authz.nonresponse_mail_due() RETURNS TABLE (k text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT x.k FROM (
    SELECT f.id::text || ':warning' AS k, f.flagged_at AS at
      FROM eureka.candidate_nonresponse f
      JOIN eureka.candidate c ON c.id = f.candidate_id JOIN eureka.person p ON p.id = c.person_id
     WHERE f.status = 'open' AND f.warning_mail_sent_at IS NULL AND f.flagged_at > pg_catalog.now() - interval '14 days'
       AND c.marketing_status NOT IN ('placed', 'terminated', 'stopped') AND p.personal_email IS NOT NULL
    UNION ALL
    SELECT f.id::text || ':hold', f.hold_reached_at
      FROM eureka.candidate_nonresponse f
      JOIN eureka.candidate c ON c.id = f.candidate_id JOIN eureka.person p ON p.id = c.person_id
     WHERE f.status = 'open' AND f.hold_reached_at IS NOT NULL AND f.hold_mail_sent_at IS NULL
       AND f.hold_reached_at > pg_catalog.now() - interval '14 days'
       AND c.marketing_status NOT IN ('placed', 'terminated', 'stopped') AND p.personal_email IS NOT NULL
  ) x ORDER BY x.at LIMIT 100
$$;

-- Called inside the send transaction: locks the flag (a concurrent resolve
-- waits) and returns the address only while the stage is still due.
CREATE FUNCTION authz.nonresponse_mail_data(p_flag uuid, p_stage text) RETURNS TABLE (email text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_stage IS NULL OR p_stage NOT IN ('warning', 'hold') THEN
    RAISE EXCEPTION 'invalid stage' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM 1 FROM eureka.candidate_nonresponse f WHERE f.id = p_flag FOR UPDATE;
  RETURN QUERY
  SELECT p.personal_email::text
    FROM eureka.candidate_nonresponse f
    JOIN eureka.candidate c ON c.id = f.candidate_id JOIN eureka.person p ON p.id = c.person_id
   WHERE f.id = p_flag AND f.status = 'open'
     AND c.marketing_status NOT IN ('placed', 'terminated', 'stopped') AND p.personal_email IS NOT NULL
     AND ((p_stage = 'warning' AND f.warning_mail_sent_at IS NULL AND f.flagged_at > pg_catalog.now() - interval '14 days')
       OR (p_stage = 'hold' AND f.hold_reached_at IS NOT NULL AND f.hold_mail_sent_at IS NULL
           AND f.hold_reached_at > pg_catalog.now() - interval '14 days'));
END $$;

CREATE FUNCTION authz.nonresponse_mail_sent(p_flag uuid, p_stage text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_stage = 'warning' THEN
    UPDATE eureka.candidate_nonresponse SET warning_mail_sent_at = pg_catalog.now()
     WHERE id = p_flag AND warning_mail_sent_at IS NULL;
  ELSIF p_stage = 'hold' THEN
    UPDATE eureka.candidate_nonresponse SET hold_mail_sent_at = pg_catalog.now()
     WHERE id = p_flag AND hold_mail_sent_at IS NULL;
  ELSE
    RAISE EXCEPTION 'invalid stage' USING ERRCODE = 'check_violation';
  END IF;
END $$;

-- ---------- notification registry: candidate.not_responding ----------
-- The 0089 resolver with one more type: the candidate's current recruiter and
-- the lead of its current team (the spec's "recruiter / TL"), while the flag
-- the payload names belongs to that candidate.
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
  v_no_mgr  boolean := false;
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
  ELSIF v_type = 'candidate.not_responding' THEN
    -- 0171: recruiter and team lead (no manager), while the flag is the candidate's.
    v_no_mgr := true;
    SELECT c.recruiter_id, c.team_id INTO v_rec, v_team
      FROM eureka.candidate c
      JOIN eureka.candidate_nonresponse f ON f.candidate_id = c.id
     WHERE c.id = (v_payload ->> 'candidateId')::uuid AND f.id = (v_payload ->> 'flagId')::uuid;
  ELSE
    RETURN;
  END IF;

  IF v_team IS NOT NULL THEN
    SELECT t.lead_id INTO v_lead FROM eureka.team t WHERE t.id = v_team;
  END IF;
  IF v_lead IS NOT NULL AND NOT v_no_mgr THEN
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

-- The 0089 entity mapping with candidate.not_responding (opens the candidate).
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
  ELSIF v_type IN ('employee.exited', 'employee.bench_time', 'candidate.assigned', 'candidate.not_responding') THEN
    RETURN QUERY SELECT 'candidate'::text, (v_payload ->> 'candidateId')::uuid;
  ELSIF v_type = 'application.received' THEN
    RETURN QUERY SELECT 'application'::text, (v_payload ->> 'applicationId')::uuid;
  ELSIF v_type = 'chat.direct_message' THEN
    RETURN QUERY SELECT 'conversation'::text, (v_payload ->> 'conversationId')::uuid;
  ELSIF v_type = 'interview.requested' THEN
    RETURN QUERY SELECT 'interview'::text, (v_payload ->> 'interviewId')::uuid;
  ELSIF v_type = 'staff.birthdays_today' THEN
    RETURN QUERY SELECT 'digest'::text, p_event;
  END IF;
END $$;

RESET ROLE;

REVOKE ALL ON FUNCTION authz.nonresponse_flag(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.nonresponse_resolve(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.emit_candidate_nonresponse_hold(date, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.nonresponse_mail_due() FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.nonresponse_mail_data(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.nonresponse_mail_sent(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.notification_recipients(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.notification_entity(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.nonresponse_flag(uuid, text), authz.nonresponse_resolve(uuid, text) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.emit_candidate_nonresponse_hold(date, integer), authz.nonresponse_mail_due(),
  authz.nonresponse_mail_data(uuid, text), authz.nonresponse_mail_sent(uuid, text) TO eureka_worker;
