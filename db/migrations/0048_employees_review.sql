-- Employees review fixes (0045; independent review 2026-10-03).
--   1. BLOCKING: authz.transition_placement (0023) moved a `placed` candidate
--      to `bench` on `joined -> bgc_failed` even when the placement's
--      assignment had already been ended (project exit, 0045). After a
--      re-placement (the candidate `placed` again on a newer assignment) this
--      benched the candidate while the employee stayed on assignment, and Sales
--      could then open a second assignment for the same person. Now the
--      after-joining branch takes the per-person lock (same order as joining and
--      the employment functions) and benches the candidate only when it closed
--      this placement's open assignment and the person has no other open one.
--      bgc_failed on a joined placement whose assignment is already closed is
--      still recorded (status, reason, outbox), but moves neither the
--      candidate nor the employee. Every other behaviour, the signature, the
--      return columns, ownership, search_path and grants are unchanged (used by
--      the API, the sheet import and the paperwork/BGC work).
--   2. Invariant: at most one open assignment per person (partial unique index).
--   3. authz.return_employee_to_market also refuses when any placement of the
--      person failed its background check after joining (not only when the
--      latest assignment ended with reason bgc_failed), see 1.
--   4. NULL-safe comparisons (rule 1) in the 0045 functions replaced here.
-- Backfilled 0045 history (one INSERT for `started`, then one for `ended`)
-- is ordered by the API by (at, effective_on, id), so no row is rewritten.
-- Every IF is NULL-safe (rule 1); search_path pinned, no PUBLIC execute (rule 2).
SET search_path = eureka, public;

-- ---------- 2. invariant ----------
SET ROLE eureka_owner;
DROP INDEX eureka.assignment_open_person;
CREATE UNIQUE INDEX assignment_open_person ON eureka.assignment (person_id) WHERE end_date IS NULL;
RESET ROLE;

SET ROLE authz_definer;

-- ---------- 1. transition_placement ----------
-- PL-4, PL-5, PL-7. Returns the placement status change as read under the row
-- lock and the candidate status change it caused (both NULL when none).
CREATE OR REPLACE FUNCTION authz.transition_placement(p_placement uuid, p_to text, p_reason text)
RETURNS TABLE (from_status text, to_status text, candidate_from text, candidate_to text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  actor uuid := authz.current_user_id();
  p record;
  reason text := nullif(pg_catalog.btrim(p_reason), '');
  cand_status text;
  cand_to text;
  next_no integer;
  closed integer := 0;
BEGIN
  SELECT * INTO p FROM eureka.placement WHERE id = p_placement FOR UPDATE;
  IF NOT FOUND OR actor IS NULL OR NOT coalesce(
       authz.owns('placement:read', p.recruiter_id, p.team_id, p.location_id)
       OR authz.candidate_owned(p.candidate_id, 'placement:read'), false) THEN
    RAISE EXCEPTION 'placement_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT coalesce(authz.owns('placement:update', p.recruiter_id, p.team_id, p.location_id), false)
     OR (coalesce(p_to = 'bgc_failed', false)
         AND NOT coalesce(authz.owns('placement.bgc_status:update', p.recruiter_id, p.team_id, p.location_id), false)) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_to IS NULL OR NOT coalesce(
       (p.status, p_to) IN (('confirmed', 'paperwork'), ('paperwork', 'bgc'), ('bgc', 'ready'), ('ready', 'joined'))
       OR (p_to = 'backout' AND p.status IN ('confirmed', 'paperwork', 'bgc', 'ready'))
       OR (p_to = 'bgc_failed' AND p.status IN ('confirmed', 'paperwork', 'bgc', 'ready', 'joined')), false) THEN
    RAISE EXCEPTION 'invalid_transition' USING ERRCODE = 'check_violation';
  END IF;
  IF p_to IN ('backout', 'bgc_failed') AND reason IS NULL THEN
    RAISE EXCEPTION 'reason_required' USING ERRCODE = 'check_violation';
  END IF;

  SELECT c.marketing_status INTO cand_status FROM eureka.candidate c WHERE c.id = p.candidate_id FOR UPDATE;

  IF p_to = 'joined' THEN
    PERFORM authz.candidate_status_by_placement(p.candidate_id, 'placed');
    cand_to := 'placed';
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('eureka.assignment:' || p.person_id::text));
    SELECT coalesce(max(a.assignment_no), 0) + 1 INTO next_no FROM eureka.assignment a WHERE a.person_id = p.person_id;
    INSERT INTO eureka.assignment (person_id, placement_id, assignment_no, start_date)
    VALUES (p.person_id, p.id, next_no, CURRENT_DATE);
  ELSIF p_to IN ('backout', 'bgc_failed') AND p.status IS DISTINCT FROM 'joined' THEN
    IF cand_status IS NOT DISTINCT FROM 'confirmation' THEN
      PERFORM authz.candidate_status_by_placement(p.candidate_id, 'active');
      cand_to := 'active';
    END IF;
  ELSIF p_to = 'bgc_failed' AND p.status IS NOT DISTINCT FROM 'joined' THEN
    -- Same lock order as joining and the employment functions (0045).
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('eureka.assignment:' || p.person_id::text));
    UPDATE eureka.assignment a SET end_date = greatest(a.start_date, CURRENT_DATE), end_reason = 'bgc_failed'
     WHERE a.placement_id = p.id AND a.end_date IS NULL;
    GET DIAGNOSTICS closed = ROW_COUNT;
    -- Only when this placement's assignment was the one keeping the candidate
    -- placed: an assignment already ended (project exit) leaves the candidate
    -- and the employee where a later placement put them.
    IF coalesce(closed, 0) > 0 AND cand_status IS NOT DISTINCT FROM 'placed'
       AND NOT EXISTS (SELECT 1 FROM eureka.assignment o WHERE o.person_id = p.person_id AND o.end_date IS NULL) THEN
      PERFORM authz.candidate_status_by_placement(p.candidate_id, 'bench');
      cand_to := 'bench';
    END IF;
  END IF;

  UPDATE eureka.placement
     SET status = p_to, status_reason = reason,
         status_changed_at = pg_catalog.now(), status_changed_by = actor,
         joined_at = CASE WHEN p_to = 'joined' THEN pg_catalog.now() ELSE joined_at END
   WHERE id = p.id;

  INSERT INTO eureka.outbox_event (type, aggregate_type, aggregate_id, payload)
  VALUES ('placement.state_changed', 'placement', p.id, pg_catalog.jsonb_build_object(
    'placementId', p.id, 'candidateId', p.candidate_id, 'from', p.status, 'to', p_to,
    'notify', pg_catalog.jsonb_build_array('hr', 'accounts', 'immigration')));

  RETURN QUERY SELECT p.status::text, p_to,
    CASE WHEN cand_to IS NOT NULL THEN cand_status END, cand_to;
END $$;

-- ---------- 4. 0045 functions, NULL-safe ----------
CREATE OR REPLACE FUNCTION authz.employee_on_assignment_end() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE e record; p record; to_status text; benched boolean;
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
  benched := coalesce(e.status = 'on_assignment' AND to_status = 'bench', false);
  IF benched THEN
    UPDATE eureka.employee SET status = 'bench', status_since = greatest(e.employee_since, NEW.end_date)
     WHERE person_id = NEW.person_id;
  END IF;
  INSERT INTO eureka.employment_event (person_id, assignment_id, kind, actor_id, from_status, to_status, effective_on, reason)
  VALUES (NEW.person_id, NEW.id, 'ended', authz.current_user_id(), e.status,
          CASE WHEN e.status IS NOT DISTINCT FROM 'on_assignment' THEN to_status ELSE e.status END, NEW.end_date, NEW.end_reason);
  IF benched THEN
    INSERT INTO eureka.outbox_event (type, aggregate_type, aggregate_id, payload)
    VALUES ('employee.benched', 'employee', NEW.person_id, pg_catalog.jsonb_build_object(
      'personId', NEW.person_id, 'candidateId', p.candidate_id, 'assignmentId', NEW.id,
      'placementId', NEW.placement_id, 'endDate', NEW.end_date, 'endReason', NEW.end_reason,
      'notify', pg_catalog.jsonb_build_array('hr', 'accounts', 'immigration', 'bu_head', 'ceo')));
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION authz.end_assignment(p_assignment uuid, p_end date, p_reason text)
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
  -- At most one assignment is open per person (unique index), so this one kept the candidate placed.
  IF cand_from IS NOT DISTINCT FROM 'placed' THEN
    PERFORM authz.candidate_status_by_employment(a.candidate_id, 'bench');
    cand_to := 'bench';
  END IF;
  SELECT e.status INTO emp_to FROM eureka.employee e WHERE e.person_id = a.person_id;
  RETURN QUERY SELECT a.person_id, emp_from, emp_to,
    CASE WHEN cand_to IS NOT NULL THEN cand_from END, cand_to;
END $$;

-- ---------- 3. return to market ----------
CREATE OR REPLACE FUNCTION authz.return_employee_to_market(p_person uuid)
RETURNS TABLE (candidate_id uuid, candidate_from text, candidate_to text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE e record; cur text;
BEGIN
  SELECT * INTO e FROM authz.employee_for_update(p_person);
  IF e.status IS DISTINCT FROM 'bench' THEN
    RAISE EXCEPTION 'invalid_transition' USING ERRCODE = 'check_violation';
  END IF;
  -- Re-placing after a failed background check is an open product question:
  -- refused when the last assignment ended that way or any placement of the
  -- person failed its check after joining (also after an earlier project exit).
  IF e.last_reason IS NOT DISTINCT FROM 'bgc_failed'
     OR EXISTS (SELECT 1 FROM eureka.placement pl
                WHERE pl.person_id = e.person_id AND pl.status = 'bgc_failed' AND pl.joined_at IS NOT NULL) THEN
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

RESET ROLE;

-- CREATE OR REPLACE keeps each ACL; restated so this file stands on its own.
REVOKE ALL ON FUNCTION authz.transition_placement(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.employee_on_assignment_end() FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.end_assignment(uuid, date, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.return_employee_to_market(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.transition_placement(uuid, text, text) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.end_assignment(uuid, date, text) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.return_employee_to_market(uuid) TO eureka_app;
