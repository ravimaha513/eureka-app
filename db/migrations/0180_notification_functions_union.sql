-- Notification registry union after the gap slices were merged together.
-- 0100 (payments), 0112 (performance), 0150 (employees) and 0171 (pipeline-vendors)
-- were each written on top of 0089 and each CREATE OR REPLACE
-- authz.notification_recipients (and, except 0150, authz.notification_entity), so
-- in migration order the last one (0171) drops the branches of the others.
-- This migration re-creates both as 0089's body plus every slice's additions:
--   recipients:
--     employee.bench_time       + the POC (reason 'poc', 0150)
--     payment.first_received    recruiter, lead, manager (0100)
--     payment.delayed           recruiter, lead; no manager (0100)
--     performance.below_target  the person, their lead, the lead's manager;
--                               without a team their own manager (0112)
--     candidate.not_responding  recruiter, lead; no manager (0171)
--   entity:
--     payment.first_received, payment.delayed -> placement (0100)
--     performance.below_target                -> performance_target (0112)
--     candidate.not_responding                -> candidate (0171)
-- The inbox entity check must allow every entity type above: 0089 and 0112 added
-- them; re-checked here from the constraint as it stands (not a hard-coded list).
-- A later replacement of either function must start from these bodies.
-- Every IF is NULL-safe (rule 1); functions pin search_path, are not executable
-- by PUBLIC and are granted to exactly the worker, as in 0089 (rule 2).
SET search_path = eureka, public;

SET ROLE authz_definer;
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
  v_poc     uuid;
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
    -- 0150: the POC, the recruiter who placed the candidate on their latest assignment.
    SELECT p.recruiter_id INTO v_poc
      FROM eureka.placement p JOIN eureka.assignment a ON a.placement_id = p.id
     WHERE p.candidate_id = (v_payload ->> 'candidateId')::uuid
     ORDER BY a.start_date DESC, a.assignment_no DESC LIMIT 1;
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
  ELSIF v_type IN ('payment.first_received', 'payment.delayed') THEN
    -- 0100: FR-NTF-07 (recruiter, TL, manager) and FR-NTF-08 (recruiter, TL).
    SELECT p.recruiter_id, p.team_id INTO v_rec, v_team
      FROM eureka.placement p JOIN eureka.invoice i ON i.placement_id = p.id
     WHERE p.id = (v_payload ->> 'placementId')::uuid AND i.id = (v_payload ->> 'invoiceId')::uuid;
    v_no_mgr := v_type = 'payment.delayed';
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
    UNION ALL SELECT v_poc, 'poc' WHERE v_poc IS NOT NULL
  )
  SELECT DISTINCT r.uid, r.why FROM r JOIN eureka.app_user u ON u.id = r.uid
   WHERE u.status = 'active' AND (p_user IS NULL OR r.uid = p_user);
END $$;

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
  ELSIF v_type IN ('employee.benched', 'assignment.ending_soon', 'checklist.item_overdue', 'contract.created',
                   'payment.first_received', 'payment.delayed') THEN
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
  ELSIF v_type = 'performance.below_target' THEN
    RETURN QUERY SELECT 'performance_target'::text, (v_payload ->> 'targetId')::uuid;
  END IF;
END $$;
RESET ROLE;

REVOKE ALL ON FUNCTION authz.notification_recipients(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.notification_entity(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.notification_recipients(uuid, uuid) TO eureka_worker;
GRANT EXECUTE ON FUNCTION authz.notification_entity(uuid) TO eureka_worker;

-- The inbox entity check: every entity type the resolver above can return.
SET ROLE eureka_owner;
DO $$
DECLARE
  def text;
  vals text[];
  need text[] := ARRAY['placement', 'candidate', 'application', 'conversation', 'interview', 'digest', 'performance_target'];
  v text;
  changed boolean := false;
BEGIN
  SELECT pg_catalog.pg_get_constraintdef(c.oid) INTO def FROM pg_catalog.pg_constraint c
   WHERE c.conrelid = 'eureka.notification'::regclass AND c.conname = 'notification_entity_type_check';
  IF def IS NULL THEN
    RAISE EXCEPTION 'notification_entity_type_check is missing';
  END IF;
  vals := ARRAY(SELECT m[1] FROM pg_catalog.regexp_matches(def, '''([a-z_]+)''', 'g') AS m);
  FOREACH v IN ARRAY need LOOP
    IF NOT (v = ANY (vals)) THEN
      vals := vals || v;
      changed := true;
    END IF;
  END LOOP;
  IF changed THEN
    ALTER TABLE eureka.notification DROP CONSTRAINT notification_entity_type_check;
    -- Written as an IN list, as 0046-0112 did.
    EXECUTE pg_catalog.format('ALTER TABLE eureka.notification ADD CONSTRAINT notification_entity_type_check CHECK (entity_type IN (%s))',
      (SELECT pg_catalog.string_agg(pg_catalog.quote_literal(x), ', ') FROM pg_catalog.unnest(vals) AS x));
  END IF;
END $$;
RESET ROLE;
