-- authz.create_placement: current definition (repeatable; db/functions/README.md).
-- Earlier bodies: migrations 0022, 0023, 0160. Change this file, not a new migration.

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.create_placement(p_submission uuid, p_type text, p_rate numeric, p_work_mode text, p_city text, p_state text, p_start date, p_partner uuid, p_contacts jsonb, p_reconfirmed boolean DEFAULT false)
 RETURNS TABLE(placement_id uuid, is_first_placement boolean, candidate_from text, candidate_to text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
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
             WHERE p.submission_id = p_submission AND p.status NOT IN ('backout', 'bgc_failed', 'joining_issue')) THEN
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

  -- PL-3: a backout or a joining issue before joining is not an earlier placement.
  first := NOT EXISTS (SELECT 1 FROM eureka.placement p
                       WHERE p.person_id = c.person_id
                         AND (p.joined_at IS NOT NULL OR p.status NOT IN ('backout', 'joining_issue')));

  INSERT INTO eureka.placement (submission_id, candidate_id, person_id, recruiter_id, team_id, location_id,
      client_id, vendor_id, implementation_partner_id, placement_type, rate, work_mode, project_city,
      project_state, tentative_start, is_first_placement, status, created_by, reconfirmed, technology_id)
  VALUES (s.id, s.candidate_id, c.person_id, s.recruiter_id, s.team_id, s.location_id,
      s.client_id, s.vendor_id, p_partner, p_type, p_rate, p_work_mode, nullif(pg_catalog.btrim(p_city), ''),
      nullif(pg_catalog.btrim(p_state), ''), p_start, first, 'confirmed', actor,
      coalesce(p_reconfirmed, false), c.technology_id)
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
END $function$;

REVOKE ALL ON FUNCTION authz.create_placement(uuid, text, numeric, text, text, text, date, uuid, jsonb, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.create_placement(uuid, text, numeric, text, text, text, date, uuid, jsonb, boolean) TO eureka_app;
RESET ROLE;
