-- authz.edit_submission: current definition (repeatable; db/functions/README.md).
-- Corrects a submission's details (0420, docs/submissions-api.md "Editing details").
-- submission.details:update on the actor snapshot (lead: team, manager / AD: hierarchy,
-- CEO: org); the rate also needs rate:read there, since a rate you cannot see is not
-- one you can correct. Status is not editable here (authz.transition_submission).
-- Locks: once a placement is in progress the placement holds the client, vendor and
-- rate, so the submission is frozen (submission_placed); once any interview exists it
-- carries the client, so the client is fixed (client_locked).
-- Returns the names of the fields that actually changed (empty: nothing to do).

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.edit_submission(p_submission uuid, p_changes jsonb)
 RETURNS text[]
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  actor uuid := authz.current_user_id();
  s record; j record;
  v_title text; v_client uuid; v_vendor uuid; v_rate numeric; v_job uuid; v_at timestamptz;
  ch text[] := ARRAY[]::text[];
BEGIN
  SELECT * INTO s FROM eureka.submission x WHERE x.id = p_submission FOR UPDATE;
  IF NOT FOUND OR actor IS NULL OR NOT coalesce(
       authz.owns('submission:read', s.recruiter_id, s.team_id, s.location_id)
       OR authz.candidate_owned(s.candidate_id, 'submission:read'), false) THEN
    RAISE EXCEPTION 'submission_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT coalesce(authz.owns('submission.details:update', s.recruiter_id, s.team_id, s.location_id), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF pg_catalog.jsonb_typeof(p_changes) IS DISTINCT FROM 'object'
     OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_object_keys(p_changes) k
                WHERE k NOT IN ('jobTitle', 'clientId', 'vendorId', 'rate', 'jobId', 'submittedAt')) THEN
    RAISE EXCEPTION 'invalid_change' USING ERRCODE = 'check_violation';
  END IF;
  IF p_changes ? 'rate' AND NOT coalesce(authz.owns('rate:read', s.recruiter_id, s.team_id, s.location_id), false) THEN
    RAISE EXCEPTION 'field_not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_title  := CASE WHEN p_changes ? 'jobTitle' THEN pg_catalog.btrim(p_changes ->> 'jobTitle') ELSE s.job_title END;
  v_client := CASE WHEN p_changes ? 'clientId' THEN (p_changes ->> 'clientId')::uuid ELSE s.client_id END;
  v_vendor := CASE WHEN p_changes ? 'vendorId' THEN (p_changes ->> 'vendorId')::uuid ELSE s.vendor_id END;
  v_rate   := CASE WHEN p_changes ? 'rate' THEN (p_changes ->> 'rate')::numeric ELSE s.rate END;
  v_job    := CASE WHEN p_changes ? 'jobId' THEN (p_changes ->> 'jobId')::uuid ELSE s.job_id END;
  v_at     := CASE WHEN p_changes ? 'submittedAt' THEN (p_changes ->> 'submittedAt')::timestamptz ELSE s.submitted_at END;

  IF v_title IS DISTINCT FROM s.job_title THEN ch := pg_catalog.array_append(ch, 'jobTitle'); END IF;
  IF v_client IS DISTINCT FROM s.client_id THEN ch := pg_catalog.array_append(ch, 'clientId'); END IF;
  IF v_vendor IS DISTINCT FROM s.vendor_id THEN ch := pg_catalog.array_append(ch, 'vendorId'); END IF;
  IF v_rate IS DISTINCT FROM s.rate THEN ch := pg_catalog.array_append(ch, 'rate'); END IF;
  IF v_job IS DISTINCT FROM s.job_id THEN ch := pg_catalog.array_append(ch, 'jobId'); END IF;
  IF v_at IS DISTINCT FROM s.submitted_at THEN ch := pg_catalog.array_append(ch, 'submittedAt'); END IF;
  IF pg_catalog.cardinality(ch) = 0 THEN
    RETURN ch;
  END IF;

  IF EXISTS (SELECT 1 FROM eureka.placement p
             WHERE p.submission_id = p_submission AND p.status NOT IN ('backout', 'bgc_failed')) THEN
    RAISE EXCEPTION 'submission_placed' USING ERRCODE = 'check_violation';
  END IF;
  IF 'clientId' = ANY (ch) AND EXISTS (SELECT 1 FROM eureka.interview i WHERE i.submission_id = p_submission) THEN
    RAISE EXCEPTION 'client_locked' USING ERRCODE = 'check_violation';
  END IF;

  IF coalesce(pg_catalog.length(v_title), 0) NOT BETWEEN 1 AND 160 THEN
    RAISE EXCEPTION 'invalid_job_title' USING ERRCODE = 'check_violation';
  END IF;
  IF v_client IS NULL OR NOT EXISTS (SELECT 1 FROM eureka.client c WHERE c.id = v_client) THEN
    RAISE EXCEPTION 'client_not_found' USING ERRCODE = 'check_violation';
  END IF;
  IF v_vendor IS NOT NULL AND NOT EXISTS (SELECT 1 FROM eureka.vendor v WHERE v.id = v_vendor) THEN
    RAISE EXCEPTION 'vendor_not_found' USING ERRCODE = 'check_violation';
  END IF;
  IF 'rate' = ANY (ch) AND v_rate IS NOT NULL AND NOT (v_rate > 0 AND v_rate <= 1000 AND v_rate = pg_catalog.round(v_rate, 2)) THEN
    RAISE EXCEPTION 'invalid_rate' USING ERRCODE = 'check_violation';
  END IF;
  IF 'submittedAt' = ANY (ch) AND (v_at IS NULL OR v_at > pg_catalog.now() + interval '5 minutes'
                                   OR v_at < timestamptz '2000-01-01 00:00:00+00') THEN
    RAISE EXCEPTION 'invalid_submitted_at' USING ERRCODE = 'check_violation';
  END IF;
  -- The job link follows the 0060 insert rule: a readable, open client requirement of
  -- the submission's client. Re-checked when the job or the client changes.
  IF v_job IS NOT NULL AND ('jobId' = ANY (ch) OR 'clientId' = ANY (ch)) THEN
    IF NOT coalesce(authz.job_visible(v_job), false) THEN
      RAISE EXCEPTION 'job_not_found' USING ERRCODE = 'check_violation';
    END IF;
    SELECT x.kind, x.client_id, x.status INTO j FROM eureka.job x WHERE x.id = v_job;
    IF j.kind IS DISTINCT FROM 'client_requirement' OR j.client_id IS DISTINCT FROM v_client THEN
      RAISE EXCEPTION 'job_client_mismatch' USING ERRCODE = 'check_violation';
    END IF;
    IF 'jobId' = ANY (ch) AND j.status IS DISTINCT FROM 'open' THEN
      RAISE EXCEPTION 'job_not_open' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  UPDATE eureka.submission
     SET job_title = v_title, client_id = v_client, vendor_id = v_vendor, rate = v_rate,
         job_id = v_job, submitted_at = v_at,
         details_edited_at = pg_catalog.now(), details_edited_by = actor
   WHERE id = p_submission;
  RETURN ch;
END $function$;

REVOKE ALL ON FUNCTION authz.edit_submission(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.edit_submission(uuid, jsonb) TO eureka_app;
RESET ROLE;
