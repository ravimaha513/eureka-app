-- Employees, assignment lifecycle and joinings/exits (FR-EMP-01..09; design
-- AS-08, B2.4, B2.6, B4.4, B5 flow 6 "project exit", B6 project-exit, B7).
--
--   1. eureka.employee: the employee child record of a person (AS-08: candidate
--      and employee are one person with role-specific child records; a
--      placement creates an assignment, not a new person). Created by the
--      database when a person's first assignment opens (placement `joined`),
--      never by a client. Holds the employee status (on_assignment, bench,
--      exited), dates and the exit reason category. No new PII: names, phones,
--      emails stay on person/candidate under their own policies; SSN and other
--      encrypted fields are out of scope (field encryption is built separately).
--      Readable only with employee:read at org scope (B4.4 "org-scoped roles only").
--   2. eureka.assignment_plan: the planned (expected) end date of an open
--      assignment, set or extended by HR/Accounts, and the date for which the
--      `assignment.ending_soon` notice was emitted (dedupe). Kept apart from
--      eureka.assignment so the 0022 assignment guard stays unchanged (its
--      columns, other than the end, are fixed at creation). Readable wherever
--      the assignment is (EXISTS by primary key under assignment_read).
--   3. eureka.employment_event: append-only history (started, end date set or
--      changed, ended, exited, returned to marketing) with dates, statuses and
--      reason categories only: no free text (rule 5). Readable with employee:read
--      at org scope.
--   4. Lifecycle, all through SECURITY DEFINER functions that re-check
--      visibility (404) and assignment:update on the placement's actor snapshot
--      (403), NULL-safe:
--        authz.end_assignment            project exit: end date + reason category,
--                                        candidate placed -> bench (B2.6 edge)
--        authz.set_assignment_end_date   planned end date / extension
--        authz.exit_employee             bench -> exited (leaves the company)
--        authz.return_employee_to_market bench employee: candidate bench -> active,
--                                        so Sales can place them again through the
--                                        unchanged placement flow (reassignment)
--      Status follows the assignments through triggers on eureka.assignment,
--      so the placement paths (joined, bgc_failed after joining) and these
--      functions keep the employee in step without duplicating the placement
--      state machine or first-placement detection.
--   5. Outbox rows (ids, dates, statuses and categories only), for the
--      notifications work: `employee.benched` (an assignment ended and the
--      employee has no other open one; includes bgc_failed after joining),
--      `employee.exited`, and `assignment.ending_soon` (worker job through
--      authz.assignment_ending_soon_scan, once per planned end date). Shapes:
--      docs/employees-api.md. They are not in the 0024 delivery job's types, so
--      they stay unpublished until a delivery job handles them.
--   6. Joinings/exits reports read eureka.assignment under the caller's RLS
--      (no definer); this migration only adds the date indexes they need.
-- Every IF is NULL-safe (rule 1). Every function: REVOKE ALL FROM PUBLIC,
-- pinned search_path, EXECUTE only where needed (rule 2).
SET search_path = eureka, public;

-- ---------- tables ----------
SET ROLE eureka_owner;

CREATE TABLE eureka.employee (
  person_id      uuid PRIMARY KEY REFERENCES eureka.person(id),
  -- Candidate record of the latest assignment's placement.
  candidate_id   uuid NOT NULL REFERENCES eureka.candidate(id),
  status         text NOT NULL CHECK (status IN ('on_assignment', 'bench', 'exited')),
  employee_since date NOT NULL,
  status_since   date NOT NULL,
  exited_on      date,
  exit_reason    text CHECK (exit_reason IN ('resigned', 'terminated', 'other')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT employee_exit CHECK ((status = 'exited') = (exited_on IS NOT NULL)
                                  AND (exited_on IS NULL) = (exit_reason IS NULL)),
  CONSTRAINT employee_dates CHECK (status_since >= employee_since)
);
CREATE INDEX employee_status ON eureka.employee (status, status_since DESC, person_id DESC);
CREATE INDEX employee_candidate ON eureka.employee (candidate_id);

CREATE TABLE eureka.assignment_plan (
  assignment_id     uuid PRIMARY KEY REFERENCES eureka.assignment(id),
  planned_end_date  date NOT NULL CHECK (planned_end_date BETWEEN date '2000-01-01' AND date '2100-12-31'),
  -- planned_end_date for which assignment.ending_soon was emitted (NULL: not yet).
  ending_notice_for date,
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assignment_plan_end ON eureka.assignment_plan (planned_end_date);

CREATE TABLE eureka.employment_event (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  person_id     uuid NOT NULL REFERENCES eureka.person(id),
  assignment_id uuid REFERENCES eureka.assignment(id),
  kind          text NOT NULL CHECK (kind IN
                  ('started', 'end_date_set', 'ended', 'exited', 'returned_to_market')),
  at            timestamptz NOT NULL DEFAULT now(),
  -- Whatever user context the write ran under (NULL for system writes); no FK, like audit_event.
  actor_id      uuid,
  from_status   text CHECK (from_status IN ('on_assignment', 'bench', 'exited')),
  to_status     text CHECK (to_status IN ('on_assignment', 'bench', 'exited')),
  -- The date the event is about (start, end, planned end, exit) and the date it replaced.
  effective_on  date,
  previous_on   date,
  -- Category identifiers only (end/exit reasons), never free text (rule 5).
  reason        text CHECK (reason ~ '^[a-z_]{1,40}$')
);
CREATE INDEX employment_event_person ON eureka.employment_event (person_id, id);

-- Report and list filters (joinings by start date, exits by end date, open assignments).
CREATE INDEX assignment_start ON eureka.assignment (start_date);
CREATE INDEX assignment_end ON eureka.assignment (end_date) WHERE end_date IS NOT NULL;
CREATE INDEX assignment_open_person ON eureka.assignment (person_id) WHERE end_date IS NULL;

-- Only the definer functions and triggers (as authz_definer) write these tables;
-- the server stamps timestamps; nothing is ever deleted; history is append-only.
CREATE FUNCTION eureka.employment_write_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF current_user IS DISTINCT FROM 'authz_definer' THEN
    RAISE EXCEPTION 'employment data changes only through employment functions'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'employment data is never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_TABLE_NAME = 'employment_event' THEN
    IF TG_OP <> 'INSERT' THEN
      RAISE EXCEPTION 'employment_event is append-only' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.at := pg_catalog.now();
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'employee' THEN
    IF TG_OP = 'INSERT' THEN
      NEW.created_at := pg_catalog.now();
    ELSIF NEW.person_id IS DISTINCT FROM OLD.person_id OR NEW.created_at IS DISTINCT FROM OLD.created_at
          OR NEW.employee_since IS DISTINCT FROM OLD.employee_since THEN
      RAISE EXCEPTION 'column is immutable' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF TG_TABLE_NAME = 'assignment_plan' AND TG_OP = 'UPDATE'
        AND NEW.assignment_id IS DISTINCT FROM OLD.assignment_id THEN
    RAISE EXCEPTION 'column is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END $$;
CREATE TRIGGER employee_write_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.employee
  FOR EACH ROW EXECUTE FUNCTION eureka.employment_write_guard();
CREATE TRIGGER assignment_plan_write_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.assignment_plan
  FOR EACH ROW EXECUTE FUNCTION eureka.employment_write_guard();
CREATE TRIGGER employment_event_write_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.employment_event
  FOR EACH ROW EXECUTE FUNCTION eureka.employment_write_guard();

-- TRUNCATE skips row triggers: refuse it for everyone (owner included).
CREATE FUNCTION eureka.employment_truncate_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'employment data is never truncated' USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER employee_truncate_guard BEFORE TRUNCATE ON eureka.employee
  FOR EACH STATEMENT EXECUTE FUNCTION eureka.employment_truncate_guard();
CREATE TRIGGER assignment_plan_truncate_guard BEFORE TRUNCATE ON eureka.assignment_plan
  FOR EACH STATEMENT EXECUTE FUNCTION eureka.employment_truncate_guard();
CREATE TRIGGER employment_event_truncate_guard BEFORE TRUNCATE ON eureka.employment_event
  FOR EACH STATEMENT EXECUTE FUNCTION eureka.employment_truncate_guard();

ALTER TABLE eureka.employee         ENABLE ROW LEVEL SECURITY; ALTER TABLE eureka.employee         FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.assignment_plan  ENABLE ROW LEVEL SECURITY; ALTER TABLE eureka.assignment_plan  FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.employment_event ENABLE ROW LEVEL SECURITY; ALTER TABLE eureka.employment_event FORCE ROW LEVEL SECURITY;

-- App read policies (rule 3: InitPlan, EXISTS by primary key).
-- B4.4: employees are visible with employee:read at org scope only.
CREATE POLICY employee_read ON eureka.employee FOR SELECT TO eureka_app
  USING ((SELECT authz.has_org('employee:read')));
CREATE POLICY employment_event_read ON eureka.employment_event FOR SELECT TO eureka_app
  USING ((SELECT authz.has_org('employee:read')));
-- The plan is part of the assignment: readable wherever the assignment is.
CREATE POLICY assignment_plan_read ON eureka.assignment_plan FOR SELECT TO eureka_app
  USING (EXISTS (SELECT 1 FROM eureka.assignment a WHERE a.id = assignment_plan.assignment_id));

-- Definer: exactly what the functions and triggers below do.
CREATE POLICY definer_read   ON eureka.employee FOR SELECT TO authz_definer USING (true);
CREATE POLICY definer_insert ON eureka.employee FOR INSERT TO authz_definer WITH CHECK (true);
CREATE POLICY definer_update ON eureka.employee FOR UPDATE TO authz_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_read   ON eureka.assignment_plan FOR SELECT TO authz_definer USING (true);
CREATE POLICY definer_insert ON eureka.assignment_plan FOR INSERT TO authz_definer WITH CHECK (true);
CREATE POLICY definer_update ON eureka.assignment_plan FOR UPDATE TO authz_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_insert ON eureka.employment_event FOR INSERT TO authz_definer WITH CHECK (true);

RESET ROLE;

REVOKE ALL ON eureka.employee, eureka.assignment_plan, eureka.employment_event FROM PUBLIC;
REVOKE ALL ON FUNCTION eureka.employment_write_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION eureka.employment_truncate_guard() FROM PUBLIC;

GRANT SELECT ON eureka.employee, eureka.assignment_plan, eureka.employment_event TO eureka_app;
GRANT SELECT, INSERT ON eureka.employee TO authz_definer;
GRANT UPDATE (candidate_id, status, status_since, exited_on, exit_reason, updated_at) ON eureka.employee TO authz_definer;
GRANT SELECT, INSERT ON eureka.assignment_plan TO authz_definer;
GRANT UPDATE (planned_end_date, ending_notice_for, updated_at) ON eureka.assignment_plan TO authz_definer;
GRANT INSERT ON eureka.employment_event TO authz_definer;

-- ---------- functions ----------
SET ROLE authz_definer;

-- Candidate status side effects of employment actions (design N2: authorized
-- by the triggering action, here assignment:update). Not executable by the app.
-- Edges are the candidate state machine's (B2.6): placed -> bench when the
-- assignment ends, bench -> active when the employee returns to marketing.
CREATE FUNCTION authz.candidate_status_by_employment(p_candidate uuid, p_to text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE cur text;
BEGIN
  SELECT c.marketing_status INTO cur FROM eureka.candidate c WHERE c.id = p_candidate FOR UPDATE;
  IF NOT FOUND OR p_to IS NULL
     OR NOT coalesce((cur, p_to) IN (('placed', 'bench'), ('bench', 'active')), false) THEN
    RAISE EXCEPTION 'invalid_transition' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE eureka.candidate
     SET marketing_status = p_to,
         bench_since = CASE WHEN p_to = 'bench' THEN CURRENT_DATE ELSE NULL END
   WHERE id = p_candidate;
END $$;

-- AFTER INSERT on eureka.assignment (placement `joined`, inside
-- authz.transition_placement as authz_definer): the person is (again) an
-- employee on assignment. A person seen for the first time gets the employee
-- record; a benched or exited employee goes back on assignment.
CREATE FUNCTION authz.employee_on_assignment_start() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE e record; cand uuid;
BEGIN
  SELECT p.candidate_id INTO cand FROM eureka.placement p WHERE p.id = NEW.placement_id;
  SELECT * INTO e FROM eureka.employee x WHERE x.person_id = NEW.person_id FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO eureka.employee (person_id, candidate_id, status, employee_since, status_since)
    VALUES (NEW.person_id, cand, 'on_assignment', NEW.start_date, NEW.start_date);
  ELSE
    UPDATE eureka.employee
       SET candidate_id = cand, status = 'on_assignment',
           status_since = greatest(e.employee_since, NEW.start_date),
           exited_on = NULL, exit_reason = NULL
     WHERE person_id = NEW.person_id;
  END IF;
  INSERT INTO eureka.employment_event (person_id, assignment_id, kind, actor_id, from_status, to_status, effective_on)
  VALUES (NEW.person_id, NEW.id, 'started', authz.current_user_id(),
          CASE WHEN e.person_id IS NOT NULL THEN e.status END, 'on_assignment', NEW.start_date);
  RETURN NULL;
END $$;

-- AFTER UPDATE OF end_date on eureka.assignment: the assignment ended (project
-- exit through authz.end_assignment, or bgc_failed after joining through
-- authz.transition_placement). Without another open assignment the employee
-- is on the bench; `employee.benched` is recorded for the notifications.
CREATE FUNCTION authz.employee_on_assignment_end() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE e record; p record; to_status text;
BEGIN
  IF OLD.end_date IS NOT NULL OR NEW.end_date IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT * INTO e FROM eureka.employee x WHERE x.person_id = NEW.person_id FOR UPDATE;
  IF e.person_id IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT pl.id, pl.candidate_id INTO p FROM eureka.placement pl WHERE pl.id = NEW.placement_id;
  to_status := CASE
    WHEN EXISTS (SELECT 1 FROM eureka.assignment a
                 WHERE a.person_id = NEW.person_id AND a.end_date IS NULL AND a.id <> NEW.id) THEN 'on_assignment'
    ELSE 'bench' END;
  IF e.status = 'on_assignment' AND to_status = 'bench' THEN
    UPDATE eureka.employee SET status = 'bench', status_since = greatest(e.employee_since, NEW.end_date)
     WHERE person_id = NEW.person_id;
  END IF;
  INSERT INTO eureka.employment_event (person_id, assignment_id, kind, actor_id, from_status, to_status, effective_on, reason)
  VALUES (NEW.person_id, NEW.id, 'ended', authz.current_user_id(), e.status,
          CASE WHEN e.status = 'on_assignment' THEN to_status ELSE e.status END, NEW.end_date, NEW.end_reason);
  IF e.status = 'on_assignment' AND to_status = 'bench' THEN
    INSERT INTO eureka.outbox_event (type, aggregate_type, aggregate_id, payload)
    VALUES ('employee.benched', 'employee', NEW.person_id, pg_catalog.jsonb_build_object(
      'personId', NEW.person_id, 'candidateId', p.candidate_id, 'assignmentId', NEW.id,
      'placementId', NEW.placement_id, 'endDate', NEW.end_date, 'endReason', NEW.end_reason,
      'notify', pg_catalog.jsonb_build_array('hr', 'accounts', 'immigration', 'bu_head', 'ceo')));
  END IF;
  RETURN NULL;
END $$;

-- Locks and returns the assignment with its placement's actor snapshot after
-- the shared checks: visible (assignment:read and placement:read on the
-- placement, as the read policies) else 404, then assignment:update on the
-- actor snapshot and employee:read at org scope else 403. Lock order matches
-- authz.transition_placement (placement, candidate, per-person advisory lock,
-- assignment) so concurrent placement and employment writes serialize instead
-- of deadlocking. Internal.
CREATE FUNCTION authz.assignment_for_update(p_assignment uuid)
RETURNS TABLE (id uuid, person_id uuid, placement_id uuid, start_date date, end_date date,
               candidate_id uuid, recruiter_id uuid, team_id uuid, location_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE pid uuid; a record; p record;
BEGIN
  SELECT x.placement_id INTO pid FROM eureka.assignment x WHERE x.id = p_assignment;
  SELECT pl.* INTO p FROM eureka.placement pl WHERE pl.id = pid FOR UPDATE;
  IF p.id IS NULL OR authz.current_user_id() IS NULL
     OR NOT coalesce(
       (authz.owns('assignment:read', p.recruiter_id, p.team_id, p.location_id)
        OR authz.candidate_owned(p.candidate_id, 'assignment:read'))
       AND (authz.owns('placement:read', p.recruiter_id, p.team_id, p.location_id)
            OR authz.candidate_owned(p.candidate_id, 'placement:read')), false) THEN
    RAISE EXCEPTION 'assignment_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  -- Employment writes also need the employee in view: employee:read at org scope (B4.4).
  IF NOT coalesce(authz.owns('assignment:update', p.recruiter_id, p.team_id, p.location_id)
                  AND authz.has_org('employee:read'), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM 1 FROM eureka.candidate c WHERE c.id = p.candidate_id FOR UPDATE;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('eureka.assignment:' || p.person_id::text));
  SELECT x.* INTO a FROM eureka.assignment x WHERE x.id = p_assignment FOR UPDATE;
  RETURN QUERY SELECT a.id, a.person_id, a.placement_id, a.start_date, a.end_date,
    p.candidate_id, p.recruiter_id, p.team_id, p.location_id;
END $$;

-- Project exit (FR-EMP-03/04, design B5 flow 6): end date and reason category
-- on the open assignment; the candidate moves placed -> bench (if still
-- placed); the employee follows through the assignment trigger. The end date
-- is today or earlier (a future end is a planned end date) and not before the
-- start. Returns the status changes for the audit.
CREATE FUNCTION authz.end_assignment(p_assignment uuid, p_end date, p_reason text)
RETURNS TABLE (person_id uuid, employee_from text, employee_to text, candidate_from text, candidate_to text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE a record; emp_from text; emp_to text; cand_from text; cand_to text;
BEGIN
  SELECT * INTO a FROM authz.assignment_for_update(p_assignment);
  IF a.end_date IS NOT NULL THEN
    RAISE EXCEPTION 'assignment_closed' USING ERRCODE = 'check_violation';
  END IF;
  IF p_reason IS NULL OR NOT coalesce(p_reason IN ('completed', 'terminated', 'resigned'), false) THEN
    RAISE EXCEPTION 'invalid_reason' USING ERRCODE = 'check_violation';
  END IF;
  IF p_end IS NULL OR NOT coalesce(p_end >= a.start_date AND p_end <= CURRENT_DATE, false) THEN
    RAISE EXCEPTION 'invalid_end_date' USING ERRCODE = 'check_violation';
  END IF;
  SELECT e.status INTO emp_from FROM eureka.employee e WHERE e.person_id = a.person_id FOR UPDATE;
  SELECT c.marketing_status INTO cand_from FROM eureka.candidate c WHERE c.id = a.candidate_id FOR UPDATE;

  UPDATE eureka.assignment x SET end_date = p_end, end_reason = p_reason WHERE x.id = a.id;
  IF cand_from = 'placed' THEN
    PERFORM authz.candidate_status_by_employment(a.candidate_id, 'bench');
    cand_to := 'bench';
  END IF;
  SELECT e.status INTO emp_to FROM eureka.employee e WHERE e.person_id = a.person_id;
  RETURN QUERY SELECT a.person_id, emp_from, emp_to,
    CASE WHEN cand_to IS NOT NULL THEN cand_from END, cand_to;
END $$;

-- Planned end date of an open assignment (set, extended or brought forward).
-- Today or later, not before the start. A change re-arms the ending-soon
-- notice. Returns the previous planned date (NULL when none).
CREATE FUNCTION authz.set_assignment_end_date(p_assignment uuid, p_planned date)
RETURNS TABLE (previous_date date, planned_date date)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE a record; prev date; emp text;
BEGIN
  SELECT * INTO a FROM authz.assignment_for_update(p_assignment);
  IF a.end_date IS NOT NULL THEN
    RAISE EXCEPTION 'assignment_closed' USING ERRCODE = 'check_violation';
  END IF;
  IF p_planned IS NULL OR NOT coalesce(p_planned >= a.start_date AND p_planned >= CURRENT_DATE
                                       AND p_planned <= date '2100-12-31', false) THEN
    RAISE EXCEPTION 'invalid_end_date' USING ERRCODE = 'check_violation';
  END IF;
  SELECT pp.planned_end_date INTO prev FROM eureka.assignment_plan pp WHERE pp.assignment_id = a.id FOR UPDATE;
  IF prev IS NOT DISTINCT FROM p_planned THEN
    RAISE EXCEPTION 'unchanged' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO eureka.assignment_plan (assignment_id, planned_end_date)
  VALUES (a.id, p_planned)
  ON CONFLICT (assignment_id) DO UPDATE SET planned_end_date = EXCLUDED.planned_end_date, ending_notice_for = NULL;
  SELECT e.status INTO emp FROM eureka.employee e WHERE e.person_id = a.person_id;
  INSERT INTO eureka.employment_event (person_id, assignment_id, kind, actor_id, from_status, to_status, effective_on, previous_on)
  VALUES (a.person_id, a.id, 'end_date_set', authz.current_user_id(), emp, emp, p_planned, prev);
  RETURN QUERY SELECT prev, p_planned;
END $$;

-- The employee (404 without employee:read at org scope, B4.4) and their latest
-- assignment, checked and locked by authz.assignment_for_update; the employee
-- row is locked last. A newer assignment opened meanwhile (a placement joined
-- between the read and the lock) is refused as a stale request. Internal.
CREATE FUNCTION authz.employee_for_update(p_person uuid)
RETURNS TABLE (person_id uuid, status text, employee_since date, candidate_id uuid,
               assignment_id uuid, last_end date, last_reason text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE e record; last_id uuid; a record; latest uuid;
BEGIN
  IF p_person IS NULL OR NOT coalesce(authz.has_org('employee:read'), false)
     OR NOT EXISTS (SELECT 1 FROM eureka.employee x WHERE x.person_id = p_person) THEN
    RAISE EXCEPTION 'employee_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  SELECT x.id INTO last_id FROM eureka.assignment x
   WHERE x.person_id = p_person ORDER BY x.assignment_no DESC LIMIT 1;
  SELECT * INTO a FROM authz.assignment_for_update(last_id);
  SELECT x.* INTO e FROM eureka.employee x WHERE x.person_id = p_person FOR UPDATE;
  SELECT x.id INTO latest FROM eureka.assignment x
   WHERE x.person_id = p_person ORDER BY x.assignment_no DESC LIMIT 1;
  IF latest IS DISTINCT FROM a.id THEN
    RAISE EXCEPTION 'invalid_transition' USING ERRCODE = 'check_violation';
  END IF;
  RETURN QUERY SELECT e.person_id, e.status, e.employee_since, e.candidate_id, a.id, a.end_date,
    (SELECT x.end_reason FROM eureka.assignment x WHERE x.id = a.id);
END $$;

-- Exit (FR-EMP: the employee leaves the company): bench -> exited, with the
-- exit date (not before the last assignment ended, not in the future) and a
-- reason category. An employee on assignment ends it first (project exit).
-- The candidate's marketing status is left as it is (open question).
CREATE FUNCTION authz.exit_employee(p_person uuid, p_exit date, p_reason text)
RETURNS TABLE (employee_from text, employee_to text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE e record;
BEGIN
  SELECT * INTO e FROM authz.employee_for_update(p_person);
  IF e.status IS DISTINCT FROM 'bench' THEN
    RAISE EXCEPTION 'invalid_transition' USING ERRCODE = 'check_violation';
  END IF;
  IF p_reason IS NULL OR NOT coalesce(p_reason IN ('resigned', 'terminated', 'other'), false) THEN
    RAISE EXCEPTION 'invalid_reason' USING ERRCODE = 'check_violation';
  END IF;
  IF p_exit IS NULL OR NOT coalesce(p_exit >= coalesce(e.last_end, e.employee_since) AND p_exit <= CURRENT_DATE, false) THEN
    RAISE EXCEPTION 'invalid_end_date' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE eureka.employee SET status = 'exited', status_since = p_exit, exited_on = p_exit, exit_reason = p_reason
   WHERE person_id = e.person_id;
  INSERT INTO eureka.employment_event (person_id, assignment_id, kind, actor_id, from_status, to_status, effective_on, reason)
  VALUES (e.person_id, e.assignment_id, 'exited', authz.current_user_id(), 'bench', 'exited', p_exit, p_reason);
  INSERT INTO eureka.outbox_event (type, aggregate_type, aggregate_id, payload)
  VALUES ('employee.exited', 'employee', e.person_id, pg_catalog.jsonb_build_object(
    'personId', e.person_id, 'candidateId', e.candidate_id, 'lastAssignmentId', e.assignment_id,
    'exitDate', p_exit, 'exitReason', p_reason,
    'notify', pg_catalog.jsonb_build_array('hr', 'accounts', 'immigration', 'bu_head', 'ceo')));
  RETURN QUERY SELECT 'bench'::text, 'exited'::text;
END $$;

-- Reassignment, first step (design B5 flow 6 and B2.6 `bench -> active`): a
-- benched employee goes back to marketing so Sales can place them again; the
-- new placement and its assignment go through the unchanged placement flow
-- (state machine, first-placement detection), and joining puts the employee
-- back on assignment. Refused after a failed background check (re-placing
-- after BGC failure is an open product question) and for exited employees.
CREATE FUNCTION authz.return_employee_to_market(p_person uuid)
RETURNS TABLE (candidate_id uuid, candidate_from text, candidate_to text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE e record; cur text;
BEGIN
  SELECT * INTO e FROM authz.employee_for_update(p_person);
  IF e.status IS DISTINCT FROM 'bench' THEN
    RAISE EXCEPTION 'invalid_transition' USING ERRCODE = 'check_violation';
  END IF;
  IF e.last_reason IS NOT DISTINCT FROM 'bgc_failed' THEN
    RAISE EXCEPTION 'bgc_failed_last' USING ERRCODE = 'check_violation';
  END IF;
  SELECT c.marketing_status INTO cur FROM eureka.candidate c WHERE c.id = e.candidate_id FOR UPDATE;
  IF cur IS DISTINCT FROM 'bench' THEN
    RAISE EXCEPTION 'candidate_not_on_bench' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM authz.candidate_status_by_employment(e.candidate_id, 'active');
  INSERT INTO eureka.employment_event (person_id, assignment_id, kind, actor_id, from_status, to_status)
  VALUES (e.person_id, e.assignment_id, 'returned_to_market', authz.current_user_id(), 'bench', 'bench');
  RETURN QUERY SELECT e.candidate_id, 'bench'::text, 'active'::text;
END $$;

-- Worker (daily): `assignment.ending_soon` once per planned end date for open
-- assignments ending within p_days (1..90) from today; at most 1000 per call.
-- Returns the number of events written.
CREATE FUNCTION authz.assignment_ending_soon_scan(p_days integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE n integer := 0; r record;
BEGIN
  IF p_days IS NULL OR p_days < 1 OR p_days > 90 THEN
    RAISE EXCEPTION 'days must be between 1 and 90' USING ERRCODE = 'check_violation';
  END IF;
  FOR r IN
    SELECT a.id, a.person_id, a.placement_id, pl.candidate_id, pp.planned_end_date
    FROM eureka.assignment_plan pp
    JOIN eureka.assignment a ON a.id = pp.assignment_id
    JOIN eureka.placement pl ON pl.id = a.placement_id
    WHERE a.end_date IS NULL
      AND pp.planned_end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + p_days
      AND pp.ending_notice_for IS DISTINCT FROM pp.planned_end_date
    ORDER BY pp.planned_end_date, a.id
    LIMIT 1000
    FOR UPDATE OF pp SKIP LOCKED
  LOOP
    UPDATE eureka.assignment_plan SET ending_notice_for = r.planned_end_date WHERE assignment_id = r.id;
    INSERT INTO eureka.outbox_event (type, aggregate_type, aggregate_id, payload)
    VALUES ('assignment.ending_soon', 'assignment', r.id, pg_catalog.jsonb_build_object(
      'assignmentId', r.id, 'placementId', r.placement_id, 'personId', r.person_id,
      'candidateId', r.candidate_id, 'plannedEndDate', r.planned_end_date,
      'daysLeft', r.planned_end_date - CURRENT_DATE,
      'notify', pg_catalog.jsonb_build_array('hr', 'accounts')));
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

RESET ROLE;

-- Status follows the assignments (created by the table owner; the functions run as authz_definer).
CREATE TRIGGER employee_on_assignment_start AFTER INSERT ON eureka.assignment
  FOR EACH ROW EXECUTE FUNCTION authz.employee_on_assignment_start();
CREATE TRIGGER employee_on_assignment_end AFTER UPDATE OF end_date ON eureka.assignment
  FOR EACH ROW EXECUTE FUNCTION authz.employee_on_assignment_end();

REVOKE ALL ON FUNCTION authz.candidate_status_by_employment(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.employee_on_assignment_start() FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.employee_on_assignment_end() FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.assignment_for_update(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.end_assignment(uuid, date, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.set_assignment_end_date(uuid, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.employee_for_update(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.exit_employee(uuid, date, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.return_employee_to_market(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.assignment_ending_soon_scan(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.end_assignment(uuid, date, text) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.set_assignment_end_date(uuid, date) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.exit_employee(uuid, date, text) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.return_employee_to_market(uuid) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.assignment_ending_soon_scan(integer) TO eureka_worker;

-- ---------- backfill ----------
-- Assignments opened before this migration (placements already joined): one
-- employee per person from their assignments, status from the open one.
-- Runs as authz_definer, the only writer the guards accept.
SET ROLE authz_definer;
INSERT INTO eureka.employee (person_id, candidate_id, status, employee_since, status_since)
SELECT a.person_id,
       (SELECT pl.candidate_id FROM eureka.assignment l JOIN eureka.placement pl ON pl.id = l.placement_id
         WHERE l.person_id = a.person_id ORDER BY l.assignment_no DESC LIMIT 1),
       CASE WHEN bool_or(a.end_date IS NULL) THEN 'on_assignment' ELSE 'bench' END,
       min(a.start_date),
       CASE WHEN bool_or(a.end_date IS NULL) THEN max(a.start_date) FILTER (WHERE a.end_date IS NULL)
            ELSE greatest(min(a.start_date), max(a.end_date)) END
FROM eureka.assignment a
GROUP BY a.person_id;
INSERT INTO eureka.employment_event (person_id, assignment_id, kind, to_status, effective_on)
SELECT a.person_id, a.id, 'started', 'on_assignment', a.start_date FROM eureka.assignment a ORDER BY a.start_date, a.id;
INSERT INTO eureka.employment_event (person_id, assignment_id, kind, from_status, to_status, effective_on, reason)
SELECT a.person_id, a.id, 'ended', 'on_assignment', 'bench', a.end_date, a.end_reason
FROM eureka.assignment a WHERE a.end_date IS NOT NULL ORDER BY a.end_date, a.id;
RESET ROLE;
