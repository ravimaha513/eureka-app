-- authz.transition_placement: current definition (repeatable; db/functions/README.md).
-- Earlier bodies: migrations 0022, 0023, 0048, 0160. Change this file, not a new migration.

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.transition_placement(p_placement uuid, p_to text, p_reason text)
 RETURNS TABLE(from_status text, to_status text, candidate_from text, candidate_to text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
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
       OR (p_to IN ('backout', 'joining_issue') AND p.status IN ('confirmed', 'paperwork', 'bgc', 'ready'))
       OR (p_to = 'bgc_failed' AND p.status IN ('confirmed', 'paperwork', 'bgc', 'ready', 'joined')), false) THEN
    RAISE EXCEPTION 'invalid_transition' USING ERRCODE = 'check_violation';
  END IF;
  IF p_to IN ('backout', 'bgc_failed', 'joining_issue') AND reason IS NULL THEN
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
  ELSIF p_to IN ('backout', 'bgc_failed', 'joining_issue') AND p.status IS DISTINCT FROM 'joined' THEN
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
END $function$;

REVOKE ALL ON FUNCTION authz.transition_placement(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.transition_placement(uuid, text, text) TO eureka_app;
RESET ROLE;
