-- Sales / placements gaps (Eureka App 4 gap list, slice sales-placements;
-- docs/placements-api.md "Sales/placements gaps (migration 0160)").
--   1. Placement status `joining_issue`: the candidate could not join because
--      of an issue at joining (a closing outcome next to `bgc_failed`). Reached
--      from any open (pre-join) state with placement:update and a reason, like
--      `backout`; the candidate goes back to `active` (when still in
--      `confirmation`), the submission is freed for a new placement, and it is
--      not an earlier placement for first-placement detection.
--   2. `placement.reconfirmed`: "existing consultant re-confirmed", entered by
--      the user on placement entry (authz.create_placement p_reconfirmed),
--      independent of the database-computed is_first_placement. Fixed after
--      creation (the 0022 write guard keeps every non-status column immutable).
--   3. `placement.technology_id`: technology snapshot of the candidate at
--      creation (PL-2), so the placements report filters and exports by
--      technology for every placement:read holder (e.g. BU Head has no
--      candidate:read). Back-filled from the candidate for existing rows.
--      Indexes for the report filters (vendor, client, location, technology).
--   4. BGC employment and address history as 3 / 5 / 7 / 10 year choices.
--      Existing values are rounded up to the next choice (1-3 -> 3, 4-5 -> 5,
--      6-7 -> 7, 8 or more -> 10) so the check still covers what was recorded;
--      0 ("none requested") becomes NULL. Rewritten through the normal
--      definer path, so the version moves and a history row (actor NULL:
--      system) records the change.
-- Every IF is NULL-safe (rule 1); functions pin search_path, no PUBLIC execute (rule 2).
SET search_path = eureka, public;

-- ---------- 1-3: placement columns, constraints, indexes ----------
SET ROLE eureka_owner;

ALTER TABLE eureka.placement
  ADD COLUMN reconfirmed   boolean NOT NULL DEFAULT false,
  ADD COLUMN technology_id uuid REFERENCES eureka.technology(id);

ALTER TABLE eureka.placement DROP CONSTRAINT placement_status_check;
ALTER TABLE eureka.placement ADD CONSTRAINT placement_status_check CHECK (status IN
  ('confirmed', 'paperwork', 'bgc', 'ready', 'joined', 'backout', 'bgc_failed', 'joining_issue'));
ALTER TABLE eureka.placement DROP CONSTRAINT placement_reason;
ALTER TABLE eureka.placement ADD CONSTRAINT placement_reason CHECK (status NOT IN ('backout', 'bgc_failed', 'joining_issue')
                                                               OR nullif(btrim(status_reason), '') IS NOT NULL);

-- PL-1: a joining issue frees the submission like a backout.
DROP INDEX eureka.placement_active_submission;
CREATE UNIQUE INDEX placement_active_submission ON eureka.placement (submission_id)
  WHERE status NOT IN ('backout', 'bgc_failed', 'joining_issue');

CREATE INDEX placement_vendor ON eureka.placement (vendor_id);
CREATE INDEX placement_client ON eureka.placement (client_id);
CREATE INDEX placement_location ON eureka.placement (location_id);
CREATE INDEX placement_technology ON eureka.placement (technology_id);

-- Back-fill the technology snapshot. The owner reads and writes both tables
-- directly for this one statement; the write guard (only the definer, only
-- status columns) and FORCE are restored in the same transaction.
ALTER TABLE eureka.placement DISABLE TRIGGER placement_write_guard;
ALTER TABLE eureka.placement NO FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.candidate NO FORCE ROW LEVEL SECURITY;
UPDATE eureka.placement p SET technology_id = c.technology_id
  FROM eureka.candidate c WHERE c.id = p.candidate_id AND p.technology_id IS NULL;
ALTER TABLE eureka.candidate FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.placement FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.placement ENABLE TRIGGER placement_write_guard;

RESET ROLE;

-- ---------- functions ----------
SET ROLE authz_definer;

-- Same as 0023 plus p_reconfirmed (DEFAULT false: the 9-argument calls of the
-- sheet import, the seeds and the tests keep working unchanged) and the
-- technology snapshot; joining_issue is treated like backout.
DROP FUNCTION authz.create_placement(uuid, text, numeric, text, text, text, date, uuid, jsonb);

CREATE FUNCTION authz.create_placement(
  p_submission uuid, p_type text, p_rate numeric, p_work_mode text, p_city text, p_state text,
  p_start date, p_partner uuid, p_contacts jsonb, p_reconfirmed boolean DEFAULT false)
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
END $$;

-- Same as 0048 plus `joining_issue` (from an open state, reason required,
-- placement:update; side effects as backout).
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
END $$;

-- ---------- 4: BGC history years ----------
-- Through the definer (as authz.update_bgc writes): the guard bumps the
-- version and authz.bgc_history records the change with no actor.
UPDATE eureka.bgc SET
  employment_years = CASE WHEN employment_years IS NULL OR employment_years <= 0 THEN NULL
                          WHEN employment_years <= 3 THEN 3 WHEN employment_years <= 5 THEN 5
                          WHEN employment_years <= 7 THEN 7 ELSE 10 END,
  address_years    = CASE WHEN address_years IS NULL OR address_years <= 0 THEN NULL
                          WHEN address_years <= 3 THEN 3 WHEN address_years <= 5 THEN 5
                          WHEN address_years <= 7 THEN 7 ELSE 10 END
 WHERE employment_years IS NOT NULL AND employment_years NOT IN (3, 5, 7, 10)
    OR address_years IS NOT NULL AND address_years NOT IN (3, 5, 7, 10);

RESET ROLE;

SET ROLE eureka_owner;
ALTER TABLE eureka.bgc DROP CONSTRAINT bgc_employment_years_check;
ALTER TABLE eureka.bgc DROP CONSTRAINT bgc_address_years_check;
ALTER TABLE eureka.bgc ADD CONSTRAINT bgc_employment_years_check CHECK (employment_years IN (3, 5, 7, 10));
ALTER TABLE eureka.bgc ADD CONSTRAINT bgc_address_years_check CHECK (address_years IN (3, 5, 7, 10));
RESET ROLE;

-- ---------- grants ----------
REVOKE ALL ON FUNCTION authz.create_placement(uuid, text, numeric, text, text, text, date, uuid, jsonb, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.create_placement(uuid, text, numeric, text, text, text, date, uuid, jsonb, boolean) TO eureka_app;
-- CREATE OR REPLACE keeps the ACL; restated so this file stands on its own.
REVOKE ALL ON FUNCTION authz.transition_placement(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.transition_placement(uuid, text, text) TO eureka_app;

-- ---------- contracts (0086) ----------
-- joining_issue closes the placement like backout, so no contract may be added after it.
-- Body is 0086's authz.create_contract verbatim apart from the closed-status list.
SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.create_contract(
  p_placement uuid, p_kind text, p_title text, p_reference text, p_starts_on date, p_ends_on date, p_notes text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  me  uuid := authz.current_user_id();
  p   record;
  cid uuid;
  n   integer;
BEGIN
  IF me IS NULL OR p_placement IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT pl.id, pl.client_id, pl.candidate_id, pl.recruiter_id, pl.team_id, pl.location_id, pl.status INTO p
    FROM eureka.placement pl WHERE pl.id = p_placement;
  -- Read-before-write (HANDOFF rule 6): the placement read rule of 0022, else 404.
  IF NOT FOUND OR NOT coalesce(authz.has_org('placement:read')
       OR p.recruiter_id = ANY (authz.recruiter_ids('placement:read'))
       OR p.team_id = ANY (authz.team_ids('placement:read'))
       OR p.location_id = ANY (authz.location_ids('placement:read'))
       OR p.candidate_id = ANY (authz.owned_candidate_ids('placement:read')), false) THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'no_data_found';
  END IF;
  -- Sales over the actor snapshot (placement:update), or Accounts (invoice:update at org scope), else 403.
  IF NOT coalesce(authz.has_org('invoice:update')
       OR authz.has_org('placement:update')
       OR p.recruiter_id = ANY (authz.recruiter_ids('placement:update'))
       OR p.team_id = ANY (authz.owned_team_ids('placement:update')), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF coalesce(p.status, '') IN ('backout', 'bgc_failed', 'joining_issue') THEN
    RAISE EXCEPTION 'placement_closed' USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO eureka.contract (placement_id, client_id, kind, title, reference, starts_on, ends_on, notes, created_by)
  VALUES (p_placement, p.client_id, p_kind, pg_catalog.btrim(p_title), NULLIF(pg_catalog.btrim(p_reference), ''),
          p_starts_on, p_ends_on, NULLIF(pg_catalog.btrim(p_notes), ''), me)
  RETURNING id INTO cid;
  SELECT count(*)::integer INTO n FROM eureka.contract c WHERE c.placement_id = p_placement;

  -- Ids, the kind code and a count only (rule 5): Accounts, HR and Associate HR open the placement for the rest.
  INSERT INTO eureka.outbox_event (type, aggregate_type, aggregate_id, payload)
  VALUES ('contract.created', 'contract', cid, pg_catalog.jsonb_build_object(
    'contractId', cid, 'placementId', p_placement, 'candidateId', p.candidate_id, 'kind', p_kind,
    'contractCount', LEAST(n, 1000), 'notify', pg_catalog.jsonb_build_array('hr', 'associate_hr', 'accounts')));
  RETURN cid;
END $$;
RESET ROLE;
REVOKE ALL ON FUNCTION authz.create_contract(uuid, text, text, text, date, date, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.create_contract(uuid, text, text, text, date, date, text) TO eureka_app;
