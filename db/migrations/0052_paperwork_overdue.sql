-- Paperwork overdue reminder (FR-NTF-04 paperwork pending, FR-NTF-03 documents
-- pending; docs/notifications.md `checklist.item_overdue`; docs/paperwork-api.md).
-- Runs after 0046 (authz.notification_emit_once) and after 0051, whose
-- authz.notification_recipients it extends (numbered 0052 so 0051 cannot undo it).
--
-- authz.emit_paperwork_overdue(day): for every checklist item that is still
-- outstanding (pending or received) and whose due date is before `day` (the
-- worker's America/New_York date; a future day is refused), on a placement
-- that was not backed out, emits one `checklist.item_overdue` event, exactly
-- once per item and due date (ledger key "<item id>:<due date>"; changing the
-- due date re-arms the reminder). Payload: ids and a count only
-- ({checklistItemId, placementId, daysOverdue, assigneeId?}); recipients are
-- resolved by authz.notification_recipients (recruiter, lead, manager of the
-- placement's snapshot; the assignee when they hold documents_team).
-- The worker may execute this function only (rule 2/7); it gets no table access.
-- authz.notification_recipients is replaced with one change in its
-- `checklist.item_overdue` branch: the payload's assigneeId is a recipient only
-- when it is the item's current assignee (review fix; the producer already
-- takes it from checklist_item.assignee_id, never from caller input).
-- Every IF is NULL-safe (rule 1).
SET search_path = eureka, public;

SET ROLE authz_definer;

CREATE FUNCTION authz.emit_paperwork_overdue(p_day date)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  n integer := 0;
  r record;
BEGIN
  IF p_day IS NULL OR NOT coalesce(p_day <= (pg_catalog.now() AT TIME ZONE 'America/New_York')::date, false) THEN
    RAISE EXCEPTION 'invalid paperwork-overdue run' USING ERRCODE = 'check_violation';
  END IF;
  FOR r IN
    SELECT i.id, i.placement_id, i.due_on, i.assignee_id,
           i.id::text || ':' || i.due_on::text AS k
      FROM eureka.checklist_item i
      JOIN eureka.placement p ON p.id = i.placement_id
     WHERE i.status IN ('pending', 'received')
       AND i.due_on IS NOT NULL AND i.due_on < p_day
       AND p.status IS DISTINCT FROM 'backout'
       AND NOT EXISTS (SELECT 1 FROM eureka.notification_ledger l
                        WHERE l.job = 'paperwork-overdue' AND l.key = i.id::text || ':' || i.due_on::text)
     ORDER BY i.due_on, i.id
     LIMIT 5000
  LOOP
    IF authz.notification_emit_once('paperwork-overdue', r.k, 'checklist.item_overdue', 'checklist_item', r.id,
         pg_catalog.jsonb_build_object('checklistItemId', r.id, 'placementId', r.placement_id,
           'daysOverdue', LEAST(p_day - r.due_on, 3650))
         || CASE WHEN r.assignee_id IS NOT NULL
                 THEN pg_catalog.jsonb_build_object('assigneeId', r.assignee_id) ELSE '{}'::jsonb END) IS NOT NULL THEN
      n := n + 1;
    END IF;
  END LOOP;
  RETURN n;
END $$;

-- The 0051 recipient resolver, unchanged except the `checklist.item_overdue`
-- branch: the assignee is added only when the payload's assigneeId is the
-- item's current assignee (and the item belongs to the payload's placement).
-- CREATE OR REPLACE as authz_definer keeps the owner, signature, search_path
-- and grants (EXECUTE for eureka_worker only). A later migration replacing
-- this function must carry the branch over.
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
    -- 0052: the assignee only when the payload names the item's current
    -- assignee (the producer derives it from checklist_item.assignee_id; the
    -- payload alone never adds a recipient).
    SELECT ci.assignee_id INTO v_assign FROM eureka.checklist_item ci
     WHERE ci.id = (v_payload ->> 'checklistItemId')::uuid
       AND ci.placement_id = (v_payload ->> 'placementId')::uuid
       AND ci.assignee_id = (v_payload ->> 'assigneeId')::uuid;
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

RESET ROLE;

REVOKE ALL ON FUNCTION authz.emit_paperwork_overdue(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.emit_paperwork_overdue(date) TO eureka_worker;
