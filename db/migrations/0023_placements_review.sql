-- Placements review fixes (docs/placements-api.md).
--   1. assignment_read keys on assignment:read (actor snapshot or owned
--      candidate of the placement), and the placement must be visible too.
--   2. placement_contact / assignment policies probe the placement by primary
--      key (EXISTS) instead of scanning every visible placement.
--   3. authz.transition_placement returns the actual from/to statuses, read
--      under the row lock, so the audit never records a stale "from".
--   4. authz.create_placement and authz.transition_placement report the
--      candidate status change they made (candidate_from/candidate_to, NULL
--      when the candidate did not move) so the API can audit it.
-- Every IF is NULL-safe (see 0012/0015).
SET search_path = eureka, public;

-- ---------- 1, 2: read policies ----------
SET ROLE eureka_owner;

DROP POLICY placement_contact_read ON eureka.placement_contact;
-- Readable wherever the placement is (the EXISTS runs under the caller's placement policy).
CREATE POLICY placement_contact_read ON eureka.placement_contact FOR SELECT TO eureka_app
  USING (EXISTS (SELECT 1 FROM eureka.placement p WHERE p.id = placement_contact.placement_id));

DROP POLICY assignment_read ON eureka.assignment;
-- assignment:read on the placement's actor snapshot or its (owned) candidate,
-- and the placement itself visible. Scope arrays are InitPlans (once per statement).
CREATE POLICY assignment_read ON eureka.assignment FOR SELECT TO eureka_app USING (
  EXISTS (
    SELECT 1 FROM eureka.placement p
    WHERE p.id = assignment.placement_id
      AND ((SELECT authz.has_org('assignment:read'))
           OR p.recruiter_id = ANY ((SELECT authz.recruiter_ids('assignment:read'))::uuid[])
           OR p.team_id      = ANY ((SELECT authz.team_ids('assignment:read'))::uuid[])
           OR p.location_id  = ANY ((SELECT authz.location_ids('assignment:read'))::uuid[])
           OR p.candidate_id = ANY ((SELECT authz.owned_candidate_ids('assignment:read'))::uuid[])))
);

RESET ROLE;

-- ---------- 3, 4: functions ----------
SET ROLE authz_definer;

DROP FUNCTION authz.create_placement(uuid, text, numeric, text, text, text, date, uuid, jsonb);
DROP FUNCTION authz.transition_placement(uuid, text, text);

-- PL-1..PL-3, PL-5, PL-7. Returns the new id, the first-placement flag and the
-- candidate status change (candidate_from -> candidate_to).
CREATE FUNCTION authz.create_placement(
  p_submission uuid, p_type text, p_rate numeric, p_work_mode text, p_city text, p_state text,
  p_start date, p_partner uuid, p_contacts jsonb)
RETURNS TABLE (placement_id uuid, is_first_placement boolean, candidate_from text, candidate_to text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  actor uuid := authz.current_user_id();
  s record; c record;
  first boolean;
  new_id uuid;
  ct jsonb;
BEGIN
  SELECT * INTO s FROM eureka.submission WHERE id = p_submission FOR UPDATE;
  IF NOT FOUND OR actor IS NULL OR NOT coalesce(
       authz.owns('submission:read', s.recruiter_id, s.team_id, s.location_id)
       OR authz.candidate_owned(s.candidate_id, 'submission:read'), false) THEN
    RAISE EXCEPTION 'submission_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT coalesce(authz.owns('placement:create', s.recruiter_id, s.team_id, s.location_id)
                  AND authz.owns('submission:update', s.recruiter_id, s.team_id, s.location_id), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF s.status IS DISTINCT FROM 'selected' THEN
    RAISE EXCEPTION 'submission_not_selected' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM eureka.placement p
             WHERE p.submission_id = p_submission AND p.status NOT IN ('backout', 'bgc_failed')) THEN
    RAISE EXCEPTION 'placement_exists' USING ERRCODE = 'unique_violation';
  END IF;
  SELECT cd.* INTO c FROM eureka.candidate cd WHERE cd.id = s.candidate_id FOR UPDATE;
  IF NOT FOUND OR c.marketing_status IS NULL OR c.marketing_status NOT IN ('active', 'full_of_interviews') THEN
    RAISE EXCEPTION 'candidate_not_available' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT coalesce(authz.candidate_visible(c.id, 'placement:create'), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_type IS NULL OR p_work_mode IS NULL OR p_start IS NULL
     OR NOT coalesce(p_type IN ('c2c', 'w2', '1099') AND p_work_mode IN ('onsite', 'remote', 'hybrid'), false) THEN
    RAISE EXCEPTION 'invalid_placement' USING ERRCODE = 'check_violation';
  END IF;
  IF p_contacts IS NOT NULL AND (pg_catalog.jsonb_typeof(p_contacts) IS DISTINCT FROM 'array'
                                 OR pg_catalog.jsonb_array_length(p_contacts) > 10) THEN
    RAISE EXCEPTION 'invalid_placement' USING ERRCODE = 'check_violation';
  END IF;

  first := NOT EXISTS (SELECT 1 FROM eureka.placement p
                       WHERE p.person_id = c.person_id
                         AND (p.joined_at IS NOT NULL OR p.status <> 'backout'));

  INSERT INTO eureka.placement (submission_id, candidate_id, person_id, recruiter_id, team_id, location_id,
      client_id, vendor_id, implementation_partner_id, placement_type, rate, work_mode, project_city,
      project_state, tentative_start, is_first_placement, status, created_by)
  VALUES (s.id, s.candidate_id, c.person_id, s.recruiter_id, s.team_id, s.location_id,
      s.client_id, s.vendor_id, p_partner, p_type, p_rate, p_work_mode, nullif(pg_catalog.btrim(p_city), ''),
      nullif(pg_catalog.btrim(p_state), ''), p_start, first, 'confirmed', actor)
  RETURNING id INTO new_id;

  FOR ct IN SELECT e FROM pg_catalog.jsonb_array_elements(coalesce(p_contacts, '[]'::jsonb)) AS e LOOP
    IF pg_catalog.jsonb_typeof(ct) IS DISTINCT FROM 'object'
       OR pg_catalog.jsonb_typeof(ct -> 'kind') IS DISTINCT FROM 'string'
       OR pg_catalog.jsonb_typeof(ct -> 'name') IS DISTINCT FROM 'string'
       OR coalesce(pg_catalog.jsonb_typeof(ct -> 'email'), 'null') NOT IN ('string', 'null')
       OR coalesce(pg_catalog.jsonb_typeof(ct -> 'phone'), 'null') NOT IN ('string', 'null') THEN
      RAISE EXCEPTION 'invalid_placement' USING ERRCODE = 'check_violation';
    END IF;
    INSERT INTO eureka.placement_contact (placement_id, kind, name, email, phone)
    VALUES (new_id, ct ->> 'kind', pg_catalog.btrim(ct ->> 'name'),
            nullif(pg_catalog.btrim(ct ->> 'email'), ''), nullif(pg_catalog.btrim(ct ->> 'phone'), ''));
  END LOOP;

  PERFORM authz.candidate_status_by_placement(c.id, 'confirmation');

  INSERT INTO eureka.outbox_event (type, aggregate_type, aggregate_id, payload)
  VALUES ('placement.created', 'placement', new_id, pg_catalog.jsonb_build_object(
    'placementId', new_id, 'submissionId', s.id, 'candidateId', s.candidate_id, 'status', 'confirmed',
    'isFirstPlacement', first, 'notify', pg_catalog.jsonb_build_array('hr', 'accounts', 'immigration')));

  RETURN QUERY SELECT new_id, first, c.marketing_status::text, 'confirmation'::text;
END $$;

-- PL-4, PL-5, PL-7. Returns the placement status change as read under the row
-- lock and the candidate status change it caused (both NULL when none).
CREATE FUNCTION authz.transition_placement(p_placement uuid, p_to text, p_reason text)
RETURNS TABLE (from_status text, to_status text, candidate_from text, candidate_to text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  actor uuid := authz.current_user_id();
  p record;
  reason text := nullif(pg_catalog.btrim(p_reason), '');
  cand_status text;
  cand_to text;
  next_no integer;
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
    IF cand_status = 'confirmation' THEN
      PERFORM authz.candidate_status_by_placement(p.candidate_id, 'active');
      cand_to := 'active';
    END IF;
  ELSIF p_to = 'bgc_failed' AND p.status = 'joined' THEN
    UPDATE eureka.assignment a SET end_date = greatest(a.start_date, CURRENT_DATE), end_reason = 'bgc_failed'
     WHERE a.placement_id = p.id AND a.end_date IS NULL;
    IF cand_status = 'placed' THEN
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

RESET ROLE;

REVOKE ALL ON FUNCTION authz.create_placement(uuid, text, numeric, text, text, text, date, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.transition_placement(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.create_placement(uuid, text, numeric, text, text, text, date, uuid, jsonb) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.transition_placement(uuid, text, text) TO eureka_app;
