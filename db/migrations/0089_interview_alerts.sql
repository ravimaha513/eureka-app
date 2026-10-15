-- Interview request alerts and the notification registry additions of the
-- interview-alerts package (contract docs/alerts-calendar-birthdays.md IA-1..IA-5,
-- docs/notifications.md).
--   1. authz.interview_notice(): AFTER INSERT / UPDATE trigger on
--      eureka.interview that records `interview.requested` in the outbox when
--      an interview is created, moved to another slot or cancelled (ids, the
--      change code and the New York date only). Interviews already in the
--      past (imported history, late edits) emit nothing. Recipients: the
--      interview coordinators (role interview_coordinator).
--   2. authz.interview_notice_details(event): the full interview details for
--      the coordinators' email, read by the worker at send time (owner
--      decision 2026-10-15: the alert carries the candidate's email and the
--      interview facts; the outbox payload and the inbox row still carry ids
--      only). Nothing of it is stored outside the interview tables.
--   3. authz.notification_recipients / authz.notification_entity replaced on
--      top of 0070 (every earlier branch carried over) with
--      `interview.requested` (interview_coordinator; entity interview),
--      `contract.created` (0086: hr, associate_hr, accounts; entity placement)
--      and `staff.birthdays_today` (0087: ceo; entity digest = the event).
--      The notification entity check gains 'interview' and 'digest'.
-- Every IF is NULL-safe (rule 1); functions pin search_path and are granted
-- to exactly the role that needs them (rule 2).
SET search_path = eureka, public;

-- The detail read joins the org and lookup tables (no RLS on them; grants only).
GRANT SELECT ON eureka.client, eureka.team, eureka.location, eureka.technology TO authz_definer;
-- person has RLS forced (0005); the definer reads it only here (0009 gave candidate, submission, interview).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policies
                  WHERE schemaname = 'eureka' AND tablename = 'person' AND policyname = 'definer_read') THEN
    EXECUTE 'CREATE POLICY definer_read ON eureka.person FOR SELECT TO authz_definer USING (true)';
  END IF;
END $$;

-- ---------- 1. interview trigger ----------
SET ROLE authz_definer;
CREATE FUNCTION authz.interview_notice() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE chg text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    chg := 'created';
  ELSIF NEW.call_status = 'cancelled' AND OLD.call_status IS DISTINCT FROM 'cancelled' THEN
    chg := 'cancelled';
  ELSIF NEW.call_status IS DISTINCT FROM 'cancelled'
        AND (NEW.starts_at, NEW.ends_at) IS DISTINCT FROM (OLD.starts_at, OLD.ends_at) THEN
    chg := 'rescheduled';
  ELSE
    RETURN NULL;
  END IF;
  -- History (imports, late edits of past interviews) is not coordinated.
  IF NEW.starts_at IS NULL OR NEW.starts_at < pg_catalog.now() THEN
    RETURN NULL;
  END IF;
  INSERT INTO eureka.outbox_event (type, aggregate_type, aggregate_id, payload)
  VALUES ('interview.requested', 'interview', NEW.id, pg_catalog.jsonb_build_object(
    'interviewId', NEW.id, 'submissionId', NEW.submission_id, 'candidateId', NEW.candidate_id,
    'change', chg, 'startsOn', (NEW.starts_at AT TIME ZONE 'America/New_York')::date,
    'notify', pg_catalog.jsonb_build_array('interview_coordinator')));
  RETURN NULL;
END $$;

-- ---------- 2. details for the coordinators' email ----------
CREATE FUNCTION authz.interview_notice_details(p_event uuid)
RETURNS TABLE (
  change text, call_status text, round text, interview_type text, starts_at timestamptz, ends_at timestamptz,
  meeting_url text, candidate_name text, candidate_email text, technology text, client_name text, job_title text,
  recruiter_name text, coach_name text, team_name text, location_name text, panel_names text[])
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_payload jsonb;
BEGIN
  SELECT e.payload INTO v_payload FROM eureka.outbox_event e
   WHERE e.id = p_event AND e.type = 'interview.requested' AND e.published_at IS NULL;
  IF v_payload IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY
    SELECT v_payload ->> 'change', i.call_status, i.round, i.interview_type, i.starts_at, i.ends_at, i.meeting_url,
           p.first_name || ' ' || p.last_name,
           coalesce(c.marketing_email, p.personal_email)::text,
           t.name, cl.name, s.job_title, ru.display_name, cu.display_name, tm.name, l.name,
           ARRAY(SELECT pu.display_name || CASE WHEN pl.is_lead THEN ' (lead)' ELSE '' END
                   FROM eureka.interview_panelist pl JOIN eureka.app_user pu ON pu.id = pl.user_id
                  WHERE pl.interview_id = i.id ORDER BY pl.is_lead DESC, pu.display_name, pu.id)
      FROM eureka.interview i
      JOIN eureka.candidate c ON c.id = i.candidate_id
      JOIN eureka.person p ON p.id = c.person_id
      LEFT JOIN eureka.technology t ON t.id = c.technology_id
      LEFT JOIN eureka.submission s ON s.id = i.submission_id
      LEFT JOIN eureka.client cl ON cl.id = i.client_id
      LEFT JOIN eureka.app_user ru ON ru.id = i.recruiter_id
      LEFT JOIN eureka.app_user cu ON cu.id = i.coach_id
      LEFT JOIN eureka.team tm ON tm.id = i.team_id
      LEFT JOIN eureka.location l ON l.id = i.location_id
     WHERE i.id = (v_payload ->> 'interviewId')::uuid;
END $$;

-- ---------- 3. registry ----------
-- 0070's resolver (0051 + 0052 + 0062 + 0070 branches) with the three new types.
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

-- 0070's entity mapping with the three new types (a later migration replacing this function must carry every branch over).
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
  END IF;
END $$;
RESET ROLE;

REVOKE ALL ON FUNCTION authz.interview_notice() FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.interview_notice_details(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.notification_recipients(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.notification_entity(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.interview_notice() TO eureka_owner;
GRANT EXECUTE ON FUNCTION authz.interview_notice_details(uuid) TO eureka_worker;
GRANT EXECUTE ON FUNCTION authz.notification_recipients(uuid, uuid) TO eureka_worker;
GRANT EXECUTE ON FUNCTION authz.notification_entity(uuid) TO eureka_worker;

SET ROLE eureka_owner;
-- Fires after the guard of 0017 accepted the row; the worker's feedback mark touches none of these columns.
CREATE TRIGGER interview_notice AFTER INSERT OR UPDATE OF starts_at, ends_at, call_status ON eureka.interview
  FOR EACH ROW EXECUTE FUNCTION authz.interview_notice();

ALTER TABLE eureka.notification DROP CONSTRAINT notification_entity_type_check;
ALTER TABLE eureka.notification ADD CONSTRAINT notification_entity_type_check
  CHECK (entity_type IN ('placement', 'candidate', 'application', 'conversation', 'interview', 'digest'));
RESET ROLE;
