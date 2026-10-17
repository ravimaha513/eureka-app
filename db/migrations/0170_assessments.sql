-- Assessments ("gliders") on a submission, for the candidate pipeline report
-- (gap list "Candidate pipeline report"; contract docs/pipeline-vendors-api.md
-- PV-1..PV-4).
--
-- Vendors and clients often send an online assessment (Glider and similar)
-- between the submission and the interviews. Today nothing records it, so the
-- pipeline (marketing start -> submissions -> interviews -> assessments ->
-- confirmation -> paperwork -> joining) has no assessment stage.
--
--   1. eureka.assessment: one row per assessment sent for a submission. The
--      candidate is a server snapshot of the submission's candidate (the
--      pipeline report groups by candidate). No free text: platform and status
--      are codes, the score is a number, dates are dates.
--   2. Read (RLS): wherever the parent submission is readable (EXISTS by
--      primary key under submission_read; its scope arrays are InitPlans).
--   3. Writes only through authz.assessment_create / authz.assessment_update
--      (SECURITY DEFINER, owned by authz_definer), which re-check in the
--      database: 404 (`submission_not_found` / `assessment_not_found`) unless
--      the submission is readable under submission:read (actor snapshot or
--      owned candidate), 403 (`not_permitted`) unless submission:update covers
--      the submission's actor snapshot (the rule submission status changes
--      follow: submission_update, SubmissionsService.changeStatus). The
--      guard trigger refuses every other writer, and a BEFORE INSERT/UPDATE
--      guard stamps the server-managed columns (rule 4).
--   4. Update uses the row version the client saw (`stale` otherwise).
-- Audit: the API records ids and codes only (rule 5).
-- Every IF is NULL-safe (rule 1); every function pins search_path, is not
-- executable by PUBLIC and is granted to exactly the role that needs it (rule 2).
SET search_path = eureka, public;

SET ROLE eureka_owner;

CREATE TABLE eureka.assessment (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL REFERENCES eureka.submission(id),
  -- Snapshot of the submission's candidate (server-set).
  candidate_id  uuid NOT NULL REFERENCES eureka.candidate(id),
  platform      text NOT NULL CHECK (platform IN ('glider', 'hackerrank', 'codility', 'vendor_portal', 'other')),
  status        text NOT NULL CHECK (status IN ('assigned', 'completed', 'passed', 'failed', 'expired', 'cancelled')),
  assigned_on   date NOT NULL CHECK (assigned_on BETWEEN date '2000-01-01' AND date '2100-12-31'),
  due_on        date,
  completed_on  date,
  score         smallint CHECK (score BETWEEN 0 AND 100),
  created_by    uuid NOT NULL REFERENCES eureka.app_user(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid NOT NULL REFERENCES eureka.app_user(id),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  row_version   integer NOT NULL DEFAULT 1,
  CONSTRAINT assessment_due CHECK (due_on IS NULL OR due_on >= assigned_on),
  CONSTRAINT assessment_completed CHECK (completed_on IS NULL OR completed_on >= assigned_on),
  CONSTRAINT assessment_outcome CHECK (status NOT IN ('completed', 'passed', 'failed') OR completed_on IS NOT NULL)
);
CREATE INDEX assessment_submission ON eureka.assessment (submission_id);
CREATE INDEX assessment_candidate ON eureka.assessment (candidate_id);

-- Only the definer functions write; they set every server-managed column.
CREATE FUNCTION eureka.assessment_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'assessments are never truncated' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF current_user IS DISTINCT FROM 'authz_definer' THEN
    RAISE EXCEPTION 'assessments are written only by the assessment functions' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'assessments are never deleted (cancel instead)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.candidate_id := (SELECT s.candidate_id FROM eureka.submission s WHERE s.id = NEW.submission_id);
    NEW.created_at := pg_catalog.now();
    NEW.updated_at := NEW.created_at;
    NEW.updated_by := NEW.created_by;
    NEW.row_version := 1;
  ELSE
    IF NEW.submission_id IS DISTINCT FROM OLD.submission_id OR NEW.candidate_id IS DISTINCT FROM OLD.candidate_id
       OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'immutable assessment field' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.updated_at := pg_catalog.now();
    NEW.row_version := OLD.row_version + 1;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER assessment_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.assessment
  FOR EACH ROW EXECUTE FUNCTION eureka.assessment_guard();
CREATE TRIGGER assessment_no_truncate BEFORE TRUNCATE ON eureka.assessment
  FOR EACH STATEMENT EXECUTE FUNCTION eureka.assessment_guard();

ALTER TABLE eureka.assessment ENABLE ROW LEVEL SECURITY;
ALTER TABLE eureka.assessment FORCE ROW LEVEL SECURITY;
-- Readable wherever the submission is (EXISTS by primary key under submission_read).
CREATE POLICY assessment_read ON eureka.assessment FOR SELECT TO eureka_app
  USING (EXISTS (SELECT 1 FROM eureka.submission s WHERE s.id = assessment.submission_id));
CREATE POLICY definer_read   ON eureka.assessment FOR SELECT TO authz_definer USING (true);
CREATE POLICY definer_insert ON eureka.assessment FOR INSERT TO authz_definer WITH CHECK (true);
CREATE POLICY definer_update ON eureka.assessment FOR UPDATE TO authz_definer USING (true) WITH CHECK (true);

RESET ROLE;

REVOKE ALL ON eureka.assessment FROM PUBLIC;
GRANT SELECT ON eureka.assessment TO eureka_app;
GRANT SELECT, INSERT, UPDATE ON eureka.assessment TO authz_definer;
REVOKE ALL ON FUNCTION eureka.assessment_guard() FROM PUBLIC;

-- ---------- definer functions ----------
SET ROLE authz_definer;

-- Submission visible for a permission: the actor snapshot or the owned
-- candidate (mirrors submission_read and the API's activity predicate).
CREATE FUNCTION authz.assessment_submission_covered(p_submission uuid, perm text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce((
    SELECT authz.owns(perm, s.recruiter_id, s.team_id, s.location_id)
        OR authz.candidate_owned(s.candidate_id, perm)
      FROM eureka.submission s WHERE s.id = p_submission), false)
$$;

CREATE FUNCTION authz.assessment_check(
  p_platform text, p_status text, p_assigned date, p_due date, p_completed date, p_score integer)
RETURNS void
LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_platform IS NULL OR p_platform NOT IN ('glider', 'hackerrank', 'codility', 'vendor_portal', 'other')
     OR p_status IS NULL OR p_status NOT IN ('assigned', 'completed', 'passed', 'failed', 'expired', 'cancelled')
     OR p_assigned IS NULL OR p_assigned < date '2000-01-01' OR p_assigned > date '2100-12-31'
     OR (p_due IS NOT NULL AND p_due < p_assigned)
     OR (p_completed IS NOT NULL AND p_completed < p_assigned)
     OR (p_score IS NOT NULL AND (p_score < 0 OR p_score > 100)) THEN
    RAISE EXCEPTION 'invalid_assessment' USING ERRCODE = 'check_violation';
  END IF;
  IF p_status IN ('completed', 'passed', 'failed') AND p_completed IS NULL THEN
    RAISE EXCEPTION 'completed_on_required' USING ERRCODE = 'check_violation';
  END IF;
END $$;

CREATE FUNCTION authz.assessment_create(
  p_submission uuid, p_platform text, p_status text, p_assigned date, p_due date, p_completed date, p_score integer)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE s record; v_id uuid;
BEGIN
  -- Lock the submission so it cannot close concurrently.
  SELECT * INTO s FROM eureka.submission WHERE id = p_submission FOR SHARE;
  IF NOT FOUND OR authz.current_user_id() IS NULL
     OR NOT authz.assessment_submission_covered(p_submission, 'submission:read') THEN
    RAISE EXCEPTION 'submission_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT coalesce(authz.owns('submission:update', s.recruiter_id, s.team_id, s.location_id), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF s.status IN ('rejected', 'withdrawn') THEN
    RAISE EXCEPTION 'submission_closed' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM authz.assessment_check(p_platform, p_status, p_assigned, p_due, p_completed, p_score);
  IF (SELECT count(*) FROM eureka.assessment a WHERE a.submission_id = p_submission) >= 20 THEN
    RAISE EXCEPTION 'limit_reached' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO eureka.assessment (submission_id, candidate_id, platform, status, assigned_on, due_on, completed_on, score,
                                 created_by, updated_by)
  VALUES (p_submission, s.candidate_id, p_platform, p_status, p_assigned, p_due, p_completed, p_score,
          authz.current_user_id(), authz.current_user_id())
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE FUNCTION authz.assessment_update(
  p_id uuid, p_row_version integer, p_platform text, p_status text, p_assigned date, p_due date, p_completed date,
  p_score integer)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE a record; v integer;
BEGIN
  SELECT * INTO a FROM eureka.assessment WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR authz.current_user_id() IS NULL
     OR NOT authz.assessment_submission_covered(a.submission_id, 'submission:read') THEN
    RAISE EXCEPTION 'assessment_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT coalesce((SELECT authz.owns('submission:update', s.recruiter_id, s.team_id, s.location_id)
                      FROM eureka.submission s WHERE s.id = a.submission_id), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_row_version IS NULL OR p_row_version IS DISTINCT FROM a.row_version THEN
    RAISE EXCEPTION 'stale' USING ERRCODE = 'serialization_failure';
  END IF;
  PERFORM authz.assessment_check(p_platform, p_status, p_assigned, p_due, p_completed, p_score);
  UPDATE eureka.assessment
     SET platform = p_platform, status = p_status, assigned_on = p_assigned, due_on = p_due,
         completed_on = p_completed, score = p_score, updated_by = authz.current_user_id()
   WHERE id = p_id
  RETURNING row_version INTO v;
  RETURN v;
END $$;

RESET ROLE;

REVOKE ALL ON FUNCTION authz.assessment_submission_covered(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.assessment_check(text, text, date, date, date, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.assessment_create(uuid, text, text, date, date, date, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.assessment_update(uuid, integer, text, text, date, date, date, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.assessment_create(uuid, text, text, date, date, date, integer) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.assessment_update(uuid, integer, text, text, date, date, date, integer) TO eureka_app;
