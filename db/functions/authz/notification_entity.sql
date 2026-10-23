-- authz.notification_entity: current definition (repeatable; db/functions/README.md).
-- Earlier bodies: migrations 0051, 0062, 0070, 0089, 0100, 0112, 0171, 0180. Change this file, not a new migration.

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.notification_entity(p_event uuid)
 RETURNS TABLE(entity_type text, entity_id uuid)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
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
END $function$;

REVOKE ALL ON FUNCTION authz.notification_entity(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.notification_entity(uuid) TO eureka_worker;
RESET ROLE;
