-- Optimistic concurrency and race fixes for shared HR / interview / facilities
-- records (backend audit R-10: E-04, B-03, D-13; E-10). All If-Match handling
-- is optional (owner decision): no header behaves as before, a stale header
-- answers 412 `stale`.
--   1. eureka.interview.row_version (docs/interviews-settings-api.md IS-12):
--      server-managed, 1 on insert, bumped by eureka.interview_guard on every
--      user/definer update (the worker's feedback-email mark does not bump it).
--      Same guard as 0360 otherwise.
--   2. authz.assert_interview_staff_free (IS-13): the coach and panel members
--      of a live interview may not be in another live interview at an
--      overlapping time (coach or panelist there). Serialised per user with a
--      transaction advisory lock, so two concurrent bookings of one person
--      cannot both pass. 409 interviewer_conflict; the other interview is
--      never named (design B3).
--   3. row_version on eureka.assignment_plan (planned end date; the worker's
--      ending-soon mark does not bump it) and eureka.assignment_employment
--      (payroll company, dates, pay rate), with optional-version overloads of
--      authz.set_assignment_end_date / authz.set_assignment_employment
--      (docs/employees-api.md). A missing row counts as version 0.
--   4. authz.bill_void(uuid, text, integer): void with an optional row_version
--      (docs/facilities-api.md; 412 stale).
-- Every IF is NULL-safe (rule 1); functions REVOKE ALL FROM PUBLIC with a
-- pinned search_path and EXECUTE to eureka_app only (rule 2); nothing new
-- reaches audit_event (rule 5); applies as a non-superuser (rule 7).

-- ---------- 1. interview row_version ----------
SET ROLE eureka_owner;

ALTER TABLE eureka.interview ADD COLUMN row_version integer NOT NULL DEFAULT 1 CHECK (row_version >= 1);

CREATE OR REPLACE FUNCTION eureka.interview_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  perm constant text := 'interview:update';
  sales_ok boolean;
  loc_ok boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF coalesce(authz.submission_closed(NEW.submission_id), false) THEN
      RAISE EXCEPTION 'submission_closed' USING ERRCODE = 'check_violation';
    END IF;
    IF coalesce(NEW.cleared, false) OR coalesce(NEW.consent_captured, false)
       OR NEW.feedback_email_sent_at IS NOT NULL OR NEW.cleared_at IS NOT NULL OR NEW.cleared_by IS NOT NULL
       OR NEW.call_status IS DISTINCT FROM 'scheduled'
       OR NEW.result IS DISTINCT FROM 'pending' OR NEW.result_at IS NOT NULL OR NEW.result_by IS NOT NULL THEN
      RAISE EXCEPTION 'server_managed_field' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.updated_at := now();
    NEW.row_version := 1;
    RETURN NEW;
  END IF;

  IF current_user = 'eureka_worker' THEN
    IF (to_jsonb(NEW) - 'feedback_email_sent_at') IS DISTINCT FROM (to_jsonb(OLD) - 'feedback_email_sent_at') THEN
      RAISE EXCEPTION 'worker may only mark feedback email sent' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW.id, NEW.submission_id, NEW.client_id) IS DISTINCT FROM (OLD.id, OLD.submission_id, OLD.client_id) THEN
    RAISE EXCEPTION 'column is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW.feedback_email_sent_at, NEW.cleared_at, NEW.cleared_by, NEW.result_at, NEW.result_by)
     IS DISTINCT FROM (OLD.feedback_email_sent_at, OLD.cleared_at, OLD.cleared_by, OLD.result_at, OLD.result_by) THEN
    RAISE EXCEPTION 'server_managed_field' USING ERRCODE = 'insufficient_privilege';
  END IF;

  sales_ok := coalesce(authz.has_org(perm)
    OR OLD.recruiter_id = ANY (authz.recruiter_ids(perm))
    OR OLD.team_id = ANY (authz.owned_team_ids(perm)), false);
  loc_ok := coalesce(OLD.location_id = ANY (authz.location_ids(perm)), false);

  IF (NEW.round, NEW.starts_at, NEW.ends_at, NEW.otter_url, NEW.recording_url, NEW.coach_id, NEW.invite_received,
      NEW.interview_type, NEW.meeting_url, NEW.result)
     IS DISTINCT FROM (OLD.round, OLD.starts_at, OLD.ends_at, OLD.otter_url, OLD.recording_url, OLD.coach_id, OLD.invite_received,
      OLD.interview_type, OLD.meeting_url, OLD.result)
     AND NOT sales_ok THEN
    RAISE EXCEPTION 'field_not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW.cleared, NEW.consent_captured, NEW.system_name)
     IS DISTINCT FROM (OLD.cleared, OLD.consent_captured, OLD.system_name)
     AND NOT loc_ok THEN
    RAISE EXCEPTION 'field_not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.call_status IS DISTINCT FROM OLD.call_status AND NOT (sales_ok OR loc_ok) THEN
    RAISE EXCEPTION 'field_not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.cleared IS DISTINCT FROM OLD.cleared THEN
    NEW.cleared_at := CASE WHEN NEW.cleared THEN now() END;
    NEW.cleared_by := CASE WHEN NEW.cleared THEN authz.current_user_id() END;
  END IF;
  IF NEW.result IS DISTINCT FROM OLD.result THEN
    NEW.result_at := CASE WHEN NEW.result IS DISTINCT FROM 'pending' THEN now() END;
    NEW.result_by := CASE WHEN NEW.result IS DISTINCT FROM 'pending' THEN authz.current_user_id() END;
  END IF;
  -- Rule 4: the version is the server's, whatever the statement wrote.
  NEW.row_version := OLD.row_version + 1;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- ---------- 3. employment row versions (guards) ----------
ALTER TABLE eureka.assignment_plan ADD COLUMN row_version integer NOT NULL DEFAULT 1 CHECK (row_version >= 1);
ALTER TABLE eureka.assignment_employment ADD COLUMN row_version integer NOT NULL DEFAULT 1 CHECK (row_version >= 1);

-- A new planned end date bumps the version; the ending-soon notice mark does not.
CREATE FUNCTION eureka.assignment_plan_version() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.row_version := 1;
  ELSIF NEW.planned_end_date IS DISTINCT FROM OLD.planned_end_date THEN
    NEW.row_version := OLD.row_version + 1;
  ELSE
    NEW.row_version := OLD.row_version;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER assignment_plan_version BEFORE INSERT OR UPDATE ON eureka.assignment_plan
  FOR EACH ROW EXECUTE FUNCTION eureka.assignment_plan_version();

CREATE FUNCTION eureka.assignment_employment_version() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.row_version := 1;
  ELSE
    NEW.row_version := OLD.row_version + 1;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER assignment_employment_version BEFORE INSERT OR UPDATE ON eureka.assignment_employment
  FOR EACH ROW EXECUTE FUNCTION eureka.assignment_employment_version();

RESET ROLE;

REVOKE ALL ON FUNCTION eureka.assignment_plan_version() FROM PUBLIC;
REVOKE ALL ON FUNCTION eureka.assignment_employment_version() FROM PUBLIC;
-- The app reads the version with the other employment facts (assignment_plan is readable whole already).
GRANT SELECT (row_version) ON eureka.assignment_employment TO eureka_app;

SET ROLE authz_definer;

-- ---------- 2. coach / panel double-booking ----------
-- API (interviews.service create/update): after the interview row and its panel
-- are written, checks p_users (the coach and/or panel members whose booking
-- changed) against every other live interview overlapping this one's slot,
-- where they are coach or panel member. Callers: whoever may update the
-- interview or its submission (otherwise 403). A cancelled / rescheduled /
-- no-invite interview books nobody. Adjacent slots do not overlap.
CREATE FUNCTION authz.assert_interview_staff_free(p_interview uuid, p_users uuid[])
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  me record;
  users uuid[];
BEGIN
  IF authz.current_user_id() IS NULL OR p_interview IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT i.id, i.recruiter_id, i.team_id, i.location_id, i.starts_at, i.ends_at, i.call_status
    INTO me FROM eureka.interview i WHERE i.id = p_interview;
  IF NOT FOUND OR NOT coalesce(authz.owns('interview:update', me.recruiter_id, me.team_id, me.location_id)
                               OR authz.owns('submission:update', me.recruiter_id, me.team_id, me.location_id), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT coalesce(pg_catalog.array_agg(DISTINCT u ORDER BY u), '{}') INTO users
    FROM pg_catalog.unnest(p_users) AS u WHERE u IS NOT NULL;
  IF coalesce(pg_catalog.cardinality(users), 0) = 0
     OR coalesce(me.call_status IN ('cancelled', 'rescheduled', 'no_invite'), true) THEN
    RETURN;
  END IF;
  -- One booking check per person at a time, in a fixed order (no deadlocks
  -- between two writers sharing people).
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('interview_staff:' || u::text, 0))
    FROM pg_catalog.unnest(users) WITH ORDINALITY AS t(u, n) ORDER BY n;
  IF EXISTS (
       SELECT 1 FROM eureka.interview o
        WHERE o.id <> me.id
          AND o.call_status NOT IN ('cancelled', 'rescheduled', 'no_invite')
          AND o.starts_at < me.ends_at AND o.ends_at > me.starts_at
          AND (o.coach_id = ANY (users)
               OR o.id IN (SELECT p.interview_id FROM eureka.interview_panelist p WHERE p.user_id = ANY (users)))) THEN
    RAISE EXCEPTION 'interviewer_conflict' USING ERRCODE = 'exclusion_violation';
  END IF;
END $$;

-- ---------- 3. employment writes with an optional version ----------
-- Same as authz.set_assignment_end_date(uuid, date) (404/403 first, through
-- authz.assignment_for_update, which also takes the assignment lock every
-- employment write takes), then: p_expected_version not NULL and not the
-- plan's row_version (0 when no planned date yet) -> 'stale'. Returns the new
-- version too.
CREATE FUNCTION authz.set_assignment_end_date(p_assignment uuid, p_planned date, p_expected_version integer)
RETURNS TABLE (previous_date date, planned_date date, new_version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE a record; cur integer; r record;
BEGIN
  SELECT * INTO a FROM authz.assignment_for_update(p_assignment);
  SELECT pp.row_version INTO cur FROM eureka.assignment_plan pp WHERE pp.assignment_id = a.id FOR UPDATE;
  cur := coalesce(cur, 0);
  IF p_expected_version IS NOT NULL AND p_expected_version IS DISTINCT FROM cur THEN
    RAISE EXCEPTION 'stale' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO r FROM authz.set_assignment_end_date(p_assignment, p_planned);
  RETURN QUERY SELECT r.previous_date, r.planned_date,
    (SELECT pp.row_version FROM eureka.assignment_plan pp WHERE pp.assignment_id = a.id);
END $$;

-- Same as authz.set_assignment_employment(uuid, jsonb), with the version check
-- against assignment_employment.row_version (0 when no row yet).
CREATE FUNCTION authz.set_assignment_employment(p_assignment uuid, p_changes jsonb, p_expected_version integer)
RETURNS TABLE (changed text[], new_version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE a record; cur integer; ch text[];
BEGIN
  SELECT * INTO a FROM authz.assignment_for_update(p_assignment);
  SELECT x.row_version INTO cur FROM eureka.assignment_employment x WHERE x.assignment_id = a.id FOR UPDATE;
  cur := coalesce(cur, 0);
  IF p_expected_version IS NOT NULL AND p_expected_version IS DISTINCT FROM cur THEN
    RAISE EXCEPTION 'stale' USING ERRCODE = 'check_violation';
  END IF;
  ch := authz.set_assignment_employment(p_assignment, p_changes);
  RETURN QUERY SELECT ch, (SELECT x.row_version FROM eureka.assignment_employment x WHERE x.assignment_id = a.id);
END $$;

-- ---------- 4. bill void with an optional version ----------
-- authz.bill_void(uuid, text) after the same scope check (404/403) and a row
-- lock: p_row_version not NULL and not the bill's row_version -> 'stale'.
CREATE FUNCTION authz.bill_void(p_id uuid, p_reason text, p_row_version integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE cur eureka.utility_bill%ROWTYPE;
BEGIN
  PERFORM authz.bill_scope(p_id, 'bill:manage');
  SELECT * INTO cur FROM eureka.utility_bill b WHERE b.id = p_id FOR UPDATE;
  IF cur.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'bill_voided' USING ERRCODE = 'check_violation';
  END IF;
  IF p_row_version IS NOT NULL AND p_row_version IS DISTINCT FROM cur.row_version THEN
    RAISE EXCEPTION 'stale' USING ERRCODE = 'check_violation';
  END IF;
  RETURN authz.bill_void(p_id, p_reason);
END $$;

RESET ROLE;

REVOKE ALL ON FUNCTION authz.assert_interview_staff_free(uuid, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.set_assignment_end_date(uuid, date, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.set_assignment_employment(uuid, jsonb, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.bill_void(uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.assert_interview_staff_free(uuid, uuid[]) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.set_assignment_end_date(uuid, date, integer) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.set_assignment_employment(uuid, jsonb, integer) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.bill_void(uuid, text, integer) TO eureka_app;
