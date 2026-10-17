-- Employees gaps (Eureka App 4 gap list, Employees bundle; contract
-- docs/employees-api.md "0150").
--
--   1. eureka.assignment_employment: HR-owned employment facts per assignment
--      (design B2.4 payroll_entity_id, everify_date, onboarded_date, plus the
--      employee's pay rate). The payroll company is one of the group's own
--      companies (eureka.company, 0054; AS-09 legal entity). Kept apart from
--      eureka.assignment so the 0022 assignment guard stays unchanged, like
--      eureka.assignment_plan (0045). Readable wherever the assignment is
--      (EXISTS by primary key); the app has no column privilege on pay_rate:
--      authz.assignment_pay_rates returns it only with rate:read over the
--      placement's actor snapshot (the placement rate rule, PL-6). Written only
--      through authz.set_assignment_employment (assignment:update on the actor
--      snapshot and employee:read at org scope, as every employment write;
--      the pay rate also needs rate:read over the actor snapshot).
--   2. authz.payroll_companies: id, name and status of the group's companies
--      for employee:read (org) and report:read holders, who hold no company:read
--      (that stays the Location Ops Admin's, with addresses and notes).
--   3. authz.employment_movements: the joinings/exits rows, or the assignments
--      running in a period (active-employee count), with ids, dates, reason
--      categories and the payroll company, for callers with employee:read,
--      assignment:read and report:read at org scope whose placement scope does
--      not reach the placements (Immigration, which now holds report:read). The
--      same facts are already readable to them as employment history
--      (employment_event, 0045); no client, vendor, recruiter or rate.
--   4. Leaving a project: authz.assign_employee_team lets HR/Accounts/Associate
--      HR (assignment:update + employee:read at org scope) put a benched
--      employee's candidate in a Sales team without candidate:assign. The
--      recruiter is cleared (the new lead assigns one) and `candidate.assigned`
--      (FR-NTF-10) is recorded for the new lead and manager. The candidate
--      column guard (last replaced in 0065) lets definer code change team_id
--      only under authz.employment_team_context, a transaction-scoped marker
--      only this function writes; everything else is unchanged.
--   5. Document types E-Verify copy and Form 1099 (restricted: case results and
--      tax forms carry SSN/TIN), matching packages/shared DOCUMENT_TYPES.
--   6. Bench alert POC (FR-NTF-05): `employee.bench_time` also reaches the
--      recruiter of the candidate's latest assignment's placement (reason
--      `poc`). authz.notification_recipients is the 0089 version with that one
--      branch added; a later replacement must carry every branch over.
-- Rule 5: audit rows (written by the API) carry field names and ids only;
-- never the pay rate. Every IF is NULL-safe (rule 1). Every function: REVOKE
-- ALL FROM PUBLIC, pinned search_path, EXECUTE only where needed (rule 2).
SET search_path = eureka, public;

-- ---------- 1. assignment_employment ----------
SET ROLE eureka_owner;

CREATE TABLE eureka.assignment_employment (
  assignment_id      uuid PRIMARY KEY REFERENCES eureka.assignment(id),
  payroll_company_id uuid REFERENCES eureka.company(id),
  everify_date       date CHECK (everify_date BETWEEN date '2000-01-01' AND date '2100-12-31'),
  onboarded_date     date CHECK (onboarded_date BETWEEN date '2000-01-01' AND date '2100-12-31'),
  -- Hourly pay rate of the employee, same unit and bound as placement rates.
  pay_rate           numeric(12,2) CHECK (pay_rate > 0 AND pay_rate <= 1000),
  updated_by         uuid REFERENCES eureka.app_user(id),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assignment_employment_company ON eureka.assignment_employment (payroll_company_id)
  WHERE payroll_company_id IS NOT NULL;

-- Only the definer function writes; the server stamps who and when (rule 4);
-- nothing is deleted.
CREATE FUNCTION eureka.assignment_employment_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF current_user IS DISTINCT FROM 'authz_definer' THEN
    RAISE EXCEPTION 'employment data changes only through employment functions'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'employment data is never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.assignment_id IS DISTINCT FROM OLD.assignment_id THEN
    RAISE EXCEPTION 'column is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.updated_by := authz.current_user_id();
  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END $$;
CREATE TRIGGER assignment_employment_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.assignment_employment
  FOR EACH ROW EXECUTE FUNCTION eureka.assignment_employment_guard();
CREATE TRIGGER assignment_employment_truncate_guard BEFORE TRUNCATE ON eureka.assignment_employment
  FOR EACH STATEMENT EXECUTE FUNCTION eureka.employment_truncate_guard();

ALTER TABLE eureka.assignment_employment ENABLE ROW LEVEL SECURITY;
ALTER TABLE eureka.assignment_employment FORCE ROW LEVEL SECURITY;
-- Part of the assignment: readable wherever the assignment is (rule 3: EXISTS by key).
CREATE POLICY assignment_employment_read ON eureka.assignment_employment FOR SELECT TO eureka_app
  USING (EXISTS (SELECT 1 FROM eureka.assignment a WHERE a.id = assignment_employment.assignment_id));
CREATE POLICY definer_read   ON eureka.assignment_employment FOR SELECT TO authz_definer USING (true);
CREATE POLICY definer_insert ON eureka.assignment_employment FOR INSERT TO authz_definer WITH CHECK (true);
CREATE POLICY definer_update ON eureka.assignment_employment FOR UPDATE TO authz_definer USING (true) WITH CHECK (true);

-- ---------- 4. candidate column guard: team change by assign_employee_team ----------
-- The 0065 guard, unchanged except the reassignment branch: definer code may
-- change team_id without candidate:assign only while
-- authz.employment_team_context holds this transaction and candidate (written
-- only by authz.assign_employee_team, which re-checks its own rights).
CREATE OR REPLACE FUNCTION eureka.candidate_column_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  is_definer boolean := current_user = 'authz_definer';
  owns_old   boolean;
  employment boolean := false;
BEGIN
  -- Never changeable through the API.
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.person_id IS DISTINCT FROM OLD.person_id
     OR NEW.location_id IS DISTINCT FROM OLD.location_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'column is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Status columns change only through authz.transition_candidate (N2).
  IF (NEW.marketing_status IS DISTINCT FROM OLD.marketing_status
      OR NEW.bench_since IS DISTINCT FROM OLD.bench_since) AND NOT is_definer THEN
    RAISE EXCEPTION 'status changes must use a transition' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF ((NEW.technology_id, NEW.gh_location_id, NEW.priority, NEW.marketing_email, NEW.vitel_number,
       NEW.marketing_start_date, NEW.in_person_ok)
      IS DISTINCT FROM
      (OLD.technology_id, OLD.gh_location_id, OLD.priority, OLD.marketing_email, OLD.vitel_number,
       OLD.marketing_start_date, OLD.in_person_ok)
      OR (NEW.batch_id IS DISTINCT FROM OLD.batch_id AND NOT is_definer))
     AND NOT authz.owns('candidate:update', OLD.recruiter_id, OLD.team_id, OLD.location_id) THEN
    RAISE EXCEPTION 'not permitted to update profile fields' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.technical_rating IS DISTINCT FROM OLD.technical_rating
     AND NOT authz.owns('candidate.rating:update', OLD.recruiter_id, OLD.team_id, OLD.location_id) THEN
    RAISE EXCEPTION 'not permitted to update technical rating' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.visibility IS DISTINCT FROM OLD.visibility
     AND NOT authz.owns('candidate.visibility:update', OLD.recruiter_id, OLD.team_id, OLD.location_id) THEN
    RAISE EXCEPTION 'not permitted to change visibility' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.team_id IS DISTINCT FROM OLD.team_id
     OR (NEW.recruiter_id IS DISTINCT FROM OLD.recruiter_id AND NOT is_definer) THEN
    -- Only the definer may read the marker (the app role has no privilege on it).
    IF is_definer THEN
      employment := EXISTS (SELECT 1 FROM authz.employment_team_context x
                             WHERE x.xact = pg_catalog.pg_current_xact_id() AND x.candidate_id = OLD.id);
    END IF;
    IF NOT coalesce(employment, false) THEN
      owns_old := authz.owns('candidate:assign', OLD.recruiter_id, OLD.team_id, OLD.location_id);
      IF NOT owns_old
         OR NOT coalesce(authz.has_org('candidate:assign') OR NEW.team_id = ANY (authz.team_ids('candidate:assign')), false) THEN
        RAISE EXCEPTION 'not permitted to reassign candidate' USING ERRCODE = 'insufficient_privilege';
      END IF;
    END IF;
  END IF;

  NEW.updated_at := now();
  NEW.row_version := OLD.row_version + 1;
  RETURN NEW;
END $$;

RESET ROLE;

REVOKE ALL ON eureka.assignment_employment FROM PUBLIC;
REVOKE ALL ON FUNCTION eureka.assignment_employment_guard() FROM PUBLIC;
-- App: everything but the pay rate (authz.assignment_pay_rates).
GRANT SELECT (assignment_id, payroll_company_id, everify_date, onboarded_date, updated_by, updated_at)
  ON eureka.assignment_employment TO eureka_app;
GRANT SELECT, INSERT ON eureka.assignment_employment TO authz_definer;
GRANT UPDATE (payroll_company_id, everify_date, onboarded_date, pay_rate, updated_by, updated_at)
  ON eureka.assignment_employment TO authz_definer;
-- authz.assign_employee_team moves the candidate's team (recruiter_id: 0013).
GRANT UPDATE (team_id) ON eureka.candidate TO authz_definer;

-- ---------- 5. document types ----------
SET ROLE authz_definer;
INSERT INTO authz.document_type (key, label, classification) VALUES
  ('everify', 'E-Verify copy', 'restricted'),
  ('form_1099', 'Form 1099', 'restricted');

-- Transaction-scoped marker for the candidate guard (written only below).
CREATE TABLE authz.employment_team_context (
  xact         xid8 NOT NULL,
  candidate_id uuid NOT NULL,
  PRIMARY KEY (xact, candidate_id)
);
REVOKE ALL ON authz.employment_team_context FROM PUBLIC;

-- ---------- 2. payroll companies (names for employee and report readers) ----------
CREATE FUNCTION authz.payroll_companies()
RETURNS TABLE (id uuid, name text, status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT c.id, c.name, c.status FROM eureka.company c
   WHERE authz.current_user_id() IS NOT NULL
     AND coalesce(authz.has_org('employee:read') OR authz.has_perm('report:read'), false)
$$;

-- ---------- 1. employment facts: write and pay rate read ----------
-- p_changes: a JSON object with any of payrollCompanyId (uuid|null),
-- everifyDate / onboardedDate ("YYYY-MM-DD"|null), payRate (number|null).
-- 404/403 as every employment write (authz.assignment_for_update); payRate
-- also needs rate:read over the placement's actor snapshot. Works on ended
-- assignments too (history corrections). Returns the changed field names.
CREATE FUNCTION authz.set_assignment_employment(p_assignment uuid, p_changes jsonb)
RETURNS text[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  a record; k text; v jsonb; d date; n numeric;
  cur_company uuid; cur_ev date; cur_on date; cur_pay numeric; found_row boolean;
  new_company uuid; new_ev date; new_on date; new_pay numeric;
  changed text[] := '{}';
BEGIN
  IF p_changes IS NULL OR pg_catalog.jsonb_typeof(p_changes) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'invalid_field' USING ERRCODE = 'check_violation';
  END IF;
  FOR k IN SELECT pg_catalog.jsonb_object_keys(p_changes) LOOP
    IF NOT coalesce(k IN ('payrollCompanyId', 'everifyDate', 'onboardedDate', 'payRate'), false) THEN
      RAISE EXCEPTION 'invalid_field' USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;

  SELECT * INTO a FROM authz.assignment_for_update(p_assignment);
  IF p_changes ? 'payRate'
     AND NOT coalesce(authz.owns('rate:read', a.recruiter_id, a.team_id, a.location_id), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT x.payroll_company_id, x.everify_date, x.onboarded_date, x.pay_rate, true
    INTO cur_company, cur_ev, cur_on, cur_pay, found_row
    FROM eureka.assignment_employment x WHERE x.assignment_id = a.id FOR UPDATE;
  new_company := cur_company; new_ev := cur_ev; new_on := cur_on; new_pay := cur_pay;

  IF p_changes ? 'payrollCompanyId' THEN
    v := p_changes -> 'payrollCompanyId';
    IF pg_catalog.jsonb_typeof(v) = 'null' THEN
      new_company := NULL;
    ELSIF pg_catalog.jsonb_typeof(v) = 'string'
          AND coalesce((v #>> '{}') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', false) THEN
      new_company := (v #>> '{}')::uuid;
      -- A new choice must be an active company; keeping the current one is fine.
      IF new_company IS DISTINCT FROM cur_company
         AND NOT EXISTS (SELECT 1 FROM eureka.company c WHERE c.id = new_company AND c.status = 'active') THEN
        RAISE EXCEPTION 'invalid_company' USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      RAISE EXCEPTION 'invalid_company' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  FOREACH k IN ARRAY ARRAY['everifyDate', 'onboardedDate'] LOOP
    IF p_changes ? k THEN
      v := p_changes -> k;
      IF pg_catalog.jsonb_typeof(v) = 'null' THEN
        d := NULL;
      ELSIF pg_catalog.jsonb_typeof(v) = 'string' AND coalesce((v #>> '{}') ~ '^\d{4}-\d{2}-\d{2}$', false) THEN
        BEGIN
          d := (v #>> '{}')::date;
        EXCEPTION WHEN others THEN
          RAISE EXCEPTION 'invalid_date' USING ERRCODE = 'check_violation';
        END;
        IF NOT coalesce(d BETWEEN date '2000-01-01' AND date '2100-12-31', false) THEN
          RAISE EXCEPTION 'invalid_date' USING ERRCODE = 'check_violation';
        END IF;
      ELSE
        RAISE EXCEPTION 'invalid_date' USING ERRCODE = 'check_violation';
      END IF;
      IF k = 'everifyDate' THEN new_ev := d; ELSE new_on := d; END IF;
    END IF;
  END LOOP;

  IF p_changes ? 'payRate' THEN
    v := p_changes -> 'payRate';
    IF pg_catalog.jsonb_typeof(v) = 'null' THEN
      new_pay := NULL;
    ELSIF pg_catalog.jsonb_typeof(v) = 'number' THEN
      n := (v #>> '{}')::numeric;
      IF NOT coalesce(n > 0 AND n <= 1000 AND pg_catalog.round(n, 2) = n, false) THEN
        RAISE EXCEPTION 'invalid_rate' USING ERRCODE = 'check_violation';
      END IF;
      new_pay := n;
    ELSE
      RAISE EXCEPTION 'invalid_rate' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF new_company IS DISTINCT FROM cur_company THEN changed := changed || 'payrollCompanyId'::text; END IF;
  IF new_ev IS DISTINCT FROM cur_ev THEN changed := changed || 'everifyDate'::text; END IF;
  IF new_on IS DISTINCT FROM cur_on THEN changed := changed || 'onboardedDate'::text; END IF;
  IF new_pay IS DISTINCT FROM cur_pay THEN changed := changed || 'payRate'::text; END IF;
  IF coalesce(pg_catalog.cardinality(changed), 0) = 0 THEN
    RAISE EXCEPTION 'unchanged' USING ERRCODE = 'check_violation';
  END IF;

  IF coalesce(found_row, false) THEN
    UPDATE eureka.assignment_employment x
       SET payroll_company_id = new_company, everify_date = new_ev, onboarded_date = new_on, pay_rate = new_pay
     WHERE x.assignment_id = a.id;
  ELSE
    INSERT INTO eureka.assignment_employment (assignment_id, payroll_company_id, everify_date, onboarded_date, pay_rate)
    VALUES (a.id, new_company, new_ev, new_on, new_pay);
  END IF;
  RETURN changed;
END $$;

-- Pay rates of a person's assignments the caller may see: employee:read at
-- org scope, the assignment visible (assignment:read and placement:read, as
-- the read policies) and rate:read over the placement's actor snapshot.
CREATE FUNCTION authz.assignment_pay_rates(p_person uuid)
RETURNS TABLE (assignment_id uuid, pay_rate numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT a.id, x.pay_rate
    FROM eureka.assignment a
    JOIN eureka.placement p ON p.id = a.placement_id
    JOIN eureka.assignment_employment x ON x.assignment_id = a.id
   WHERE a.person_id = p_person AND x.pay_rate IS NOT NULL
     AND authz.current_user_id() IS NOT NULL
     AND coalesce(authz.has_org('employee:read'), false)
     AND coalesce(
       (authz.owns('assignment:read', p.recruiter_id, p.team_id, p.location_id)
        OR authz.candidate_owned(p.candidate_id, 'assignment:read'))
       AND (authz.owns('placement:read', p.recruiter_id, p.team_id, p.location_id)
            OR authz.candidate_owned(p.candidate_id, 'placement:read'))
       AND authz.owns('rate:read', p.recruiter_id, p.team_id, p.location_id), false)
$$;

-- ---------- 3. joinings/exits for employee readers without placement scope ----------
-- p_active = false: assignments that started or ended in the period (joinings
-- and exits); true: assignments running on any day of it (active employees).
CREATE FUNCTION authz.employment_movements(p_from date, p_to date, p_active boolean)
RETURNS TABLE (assignment_id uuid, person_id uuid, assignment_no integer, start_date date, end_date date, end_reason text,
               is_first_placement boolean, placement_id uuid, candidate_id uuid, team_id uuid, location_id uuid,
               payroll_company_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF authz.current_user_id() IS NULL
     OR NOT coalesce(authz.has_org('employee:read') AND authz.has_org('assignment:read')
                     AND authz.has_org('report:read'), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_active IS NULL OR NOT coalesce(p_from <= p_to AND p_to - p_from <= 731, false) THEN
    RAISE EXCEPTION 'invalid_period' USING ERRCODE = 'check_violation';
  END IF;
  RETURN QUERY
  SELECT a.id, a.person_id, a.assignment_no, a.start_date, a.end_date, a.end_reason, p.is_first_placement, p.id,
         p.candidate_id, p.team_id, p.location_id, x.payroll_company_id
    FROM eureka.assignment a
    JOIN eureka.placement p ON p.id = a.placement_id
    LEFT JOIN eureka.assignment_employment x ON x.assignment_id = a.id
   WHERE CASE WHEN p_active THEN a.start_date <= p_to AND (a.end_date IS NULL OR a.end_date >= p_from)
              ELSE a.start_date BETWEEN p_from AND p_to OR a.end_date BETWEEN p_from AND p_to END;
END $$;

-- ---------- 4. leaving a project: HR/Accounts assign the team ----------
-- The employee must be on the bench (came off a project) and the candidate on
-- the bench or back in marketing. 404/403 as every employment write
-- (authz.employee_for_update: employee:read at org scope, assignment:update on
-- the latest assignment's actor snapshot). The recruiter is cleared: the new
-- team's lead assigns one.
CREATE FUNCTION authz.assign_employee_team(p_person uuid, p_team uuid)
RETURNS TABLE (cand_id uuid, from_team_id uuid, to_team_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE e record; cur_team uuid; st text;
BEGIN
  SELECT * INTO e FROM authz.employee_for_update(p_person);
  IF e.status IS DISTINCT FROM 'bench' THEN
    RAISE EXCEPTION 'invalid_transition' USING ERRCODE = 'check_violation';
  END IF;
  IF p_team IS NULL OR NOT EXISTS (SELECT 1 FROM eureka.team t WHERE t.id = p_team) THEN
    RAISE EXCEPTION 'invalid_team' USING ERRCODE = 'check_violation';
  END IF;
  SELECT c.team_id, c.marketing_status INTO cur_team, st FROM eureka.candidate c WHERE c.id = e.candidate_id FOR UPDATE;
  IF NOT coalesce(st IN ('bench', 'active'), false) THEN
    RAISE EXCEPTION 'candidate_not_on_bench' USING ERRCODE = 'check_violation';
  END IF;
  IF cur_team IS NOT DISTINCT FROM p_team THEN
    RAISE EXCEPTION 'unchanged' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO authz.employment_team_context (xact, candidate_id) VALUES (pg_catalog.pg_current_xact_id(), e.candidate_id);
  UPDATE eureka.candidate c SET team_id = p_team, recruiter_id = NULL WHERE c.id = e.candidate_id;
  DELETE FROM authz.employment_team_context x
   WHERE x.xact = pg_catalog.pg_current_xact_id() AND x.candidate_id = e.candidate_id;
  -- FR-NTF-10: the new team's lead and that lead's manager (ids only, rule 5).
  INSERT INTO eureka.outbox_event (type, aggregate_type, aggregate_id, payload)
  VALUES ('candidate.assigned', 'candidate', e.candidate_id,
          pg_catalog.jsonb_build_object('candidateId', e.candidate_id, 'teamId', p_team)
          || CASE WHEN cur_team IS NOT NULL THEN pg_catalog.jsonb_build_object('fromTeamId', cur_team) ELSE '{}'::jsonb END);
  RETURN QUERY SELECT e.candidate_id, cur_team, p_team;
END $$;

-- ---------- 6. notification registry: bench alert POC ----------
-- The resolver as last replaced by 0089 (interview-alerts: interview.requested,
-- contract.created, staff.birthdays_today), with the bench-time POC: the
-- recruiter of the placement of the candidate's latest assignment (reason
-- `poc`), while an active user.
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
    UNION ALL SELECT v_poc, 'poc' WHERE v_poc IS NOT NULL
  )
  SELECT DISTINCT r.uid, r.why FROM r JOIN eureka.app_user u ON u.id = r.uid
   WHERE u.status = 'active' AND (p_user IS NULL OR r.uid = p_user);
END $$;

RESET ROLE;

REVOKE ALL ON FUNCTION authz.payroll_companies() FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.set_assignment_employment(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.assignment_pay_rates(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.employment_movements(date, date, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.assign_employee_team(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.notification_recipients(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.payroll_companies() TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.set_assignment_employment(uuid, jsonb) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.assignment_pay_rates(uuid) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.employment_movements(date, date, boolean) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.assign_employee_team(uuid, uuid) TO eureka_app;
-- notification_recipients keeps its 0046 grant (eureka_worker); CREATE OR REPLACE keeps the ACL.
