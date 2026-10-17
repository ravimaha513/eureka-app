-- authz.notification_recipients: current definition (repeatable; db/functions/README.md).
-- Earlier bodies: migrations 0046, 0051, 0052, 0062, 0070, 0089, 0100, 0112, 0150, 0171, 0180. Change this file, not a new migration.
-- Every event type's recipients are one branch below. Slices that each replaced the whole body in
-- their own migration silently dropped each other's branches (repaired in 0180); a new event type
-- adds its branch here, and notification_entity.sql gets its entity mapping.

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.notification_recipients(p_event uuid, p_user uuid DEFAULT NULL::uuid)
 RETURNS TABLE(recipient_id uuid, reason text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
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
END $function$;

REVOKE ALL ON FUNCTION authz.notification_recipients(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.notification_recipients(uuid, uuid) TO eureka_worker;
RESET ROLE;
