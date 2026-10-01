-- Placements (docs/placements-api.md PL-1..PL-9; design B2.2/B2.4, B2.6, B3, B4.5, B4.8 N2).
--   * placement, placement_contact, assignment: RLS forced; the app reads them
--     under policies mirroring submission/interview and never writes them.
--     Every write goes through authz.create_placement / authz.transition_placement.
--   * outbox_event: notifications (HR, Accounts, Immigration) recorded in the
--     same transaction; delivered by a later worker job (PL-7).
--   * idempotency_key: Idempotency-Key for POST /placements (PL-8).
--   * Candidate status side effects (PL-5) through an internal definer function
--     authorized by the placement action, not by candidate:update (N2).
--   * Manual candidate transitions are refused while a placement is open.
-- Every IF is NULL-safe (see 0012/0015): a NULL argument, id, user context or
-- scope result counts as "no".
SET search_path = eureka, public;

-- ---------- tables ----------
SET ROLE eureka_owner;

-- Reference list like client and vendor (RLS allow-list).
CREATE TABLE eureka.implementation_partner (
  id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE CHECK (char_length(btrim(name)) BETWEEN 1 AND 200)
);

CREATE TABLE eureka.placement (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id             uuid NOT NULL REFERENCES eureka.submission(id),
  -- Snapshots from the submission and candidate (PL-2), set by authz.create_placement.
  candidate_id              uuid NOT NULL REFERENCES eureka.candidate(id),
  person_id                 uuid NOT NULL REFERENCES eureka.person(id),
  recruiter_id              uuid NOT NULL REFERENCES eureka.app_user(id),
  team_id                   uuid REFERENCES eureka.team(id),
  location_id               uuid REFERENCES eureka.location(id),
  client_id                 uuid NOT NULL REFERENCES eureka.client(id),
  vendor_id                 uuid REFERENCES eureka.vendor(id),
  implementation_partner_id uuid REFERENCES eureka.implementation_partner(id),
  placement_type            text NOT NULL CHECK (placement_type IN ('c2c', 'w2', '1099')),
  -- Hourly rate, same unit and bound as submission rates.
  rate                      numeric(12,2) CHECK (rate > 0 AND rate <= 1000),
  work_mode                 text NOT NULL CHECK (work_mode IN ('onsite', 'remote', 'hybrid')),
  project_city              text CHECK (char_length(btrim(project_city)) BETWEEN 1 AND 80
                                        AND project_city !~ '[[:cntrl:]]'),
  project_state             text CHECK (project_state ~ '^[A-Za-z][A-Za-z .''-]{1,39}$'),
  tentative_start           date NOT NULL CHECK (tentative_start BETWEEN date '2000-01-01' AND date '2100-12-31'),
  is_first_placement        boolean NOT NULL,
  status                    text NOT NULL DEFAULT 'confirmed' CHECK (status IN
    ('confirmed', 'paperwork', 'bgc', 'ready', 'joined', 'backout', 'bgc_failed')),
  status_reason             text CHECK (char_length(status_reason) <= 500),
  status_changed_at         timestamptz,
  status_changed_by         uuid REFERENCES eureka.app_user(id),
  joined_at                 timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  created_by                uuid NOT NULL REFERENCES eureka.app_user(id),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT placement_joined_at CHECK (status NOT IN ('joined') OR joined_at IS NOT NULL),
  CONSTRAINT placement_reason CHECK (status NOT IN ('backout', 'bgc_failed')
                                     OR nullif(btrim(status_reason), '') IS NOT NULL)
);
-- PL-1: one active placement per submission; one open (pre-join) placement per candidate.
CREATE UNIQUE INDEX placement_active_submission ON eureka.placement (submission_id)
  WHERE status NOT IN ('backout', 'bgc_failed');
CREATE UNIQUE INDEX placement_open_candidate ON eureka.placement (candidate_id)
  WHERE status IN ('confirmed', 'paperwork', 'bgc', 'ready');
CREATE INDEX placement_person ON eureka.placement (person_id);
CREATE INDEX placement_team ON eureka.placement (team_id);
CREATE INDEX placement_recruiter ON eureka.placement (recruiter_id);
CREATE INDEX placement_created ON eureka.placement (created_at, id);

CREATE TABLE eureka.placement_contact (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  placement_id uuid NOT NULL REFERENCES eureka.placement(id),
  kind         text NOT NULL CHECK (kind IN ('vendor_poc', 'invoicing_poc', 'client_manager')),
  name         text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120 AND name !~ '[[:cntrl:]]'),
  email        text CHECK (char_length(email) <= 254 AND email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  phone        text CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX placement_contact_placement ON eureka.placement_contact (placement_id);

CREATE TABLE eureka.assignment (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id     uuid NOT NULL REFERENCES eureka.person(id),
  placement_id  uuid NOT NULL UNIQUE REFERENCES eureka.placement(id),
  assignment_no integer NOT NULL CHECK (assignment_no >= 1),
  start_date    date NOT NULL,
  end_date      date,
  end_reason    text CHECK (end_reason IN ('bgc_failed', 'completed', 'terminated', 'resigned')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (person_id, assignment_no),
  CONSTRAINT assignment_end CHECK ((end_date IS NULL) = (end_reason IS NULL)),
  CONSTRAINT assignment_dates CHECK (end_date IS NULL OR end_date >= start_date)
);

-- Transactional outbox (PL-7). Payloads carry ids and states only, never PII.
CREATE TABLE eureka.outbox_event (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type           text NOT NULL CHECK (type ~ '^[a-z][a-z_]*\.[a-z][a-z_]*$' AND char_length(type) <= 80),
  aggregate_type text NOT NULL CHECK (aggregate_type ~ '^[a-z][a-z_]{0,39}$'),
  aggregate_id   uuid NOT NULL,
  payload        jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at     timestamptz NOT NULL DEFAULT now(),
  published_at   timestamptz
);
CREATE INDEX outbox_event_unpublished ON eureka.outbox_event (created_at, id) WHERE published_at IS NULL;

-- Idempotency-Key (design B3). One row per (user, endpoint, key); the stored
-- response is replayed for a repeat with the same request hash.
CREATE TABLE eureka.idempotency_key (
  key          text NOT NULL CHECK (key ~ '^[\x21-\x7e]{1,200}$'),
  user_id      uuid NOT NULL REFERENCES eureka.app_user(id),
  endpoint     text NOT NULL CHECK (char_length(endpoint) BETWEEN 1 AND 100),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  response     jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, endpoint, key)
);

-- Defense in depth: only the definer functions write placement data. The app
-- holds no INSERT/UPDATE/DELETE on these tables; these triggers also refuse
-- the owner and any future grant.
CREATE FUNCTION eureka.placement_write_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF current_user IS DISTINCT FROM 'authz_definer' THEN
    RAISE EXCEPTION 'placement data changes only through placement functions'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'placement data is never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'placement' THEN
    -- Only the status columns move; snapshots and terms are fixed at creation.
    IF (to_jsonb(NEW) - ARRAY['status','status_reason','status_changed_at','status_changed_by','joined_at','updated_at'])
       IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['status','status_reason','status_changed_at','status_changed_by','joined_at','updated_at']) THEN
      RAISE EXCEPTION 'column is immutable' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.updated_at := pg_catalog.now();
  ELSIF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'assignment' THEN
    IF (to_jsonb(NEW) - ARRAY['end_date','end_reason','updated_at'])
       IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['end_date','end_reason','updated_at']) THEN
      RAISE EXCEPTION 'column is immutable' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.updated_at := pg_catalog.now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER placement_write_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.placement
  FOR EACH ROW EXECUTE FUNCTION eureka.placement_write_guard();
CREATE TRIGGER placement_contact_write_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.placement_contact
  FOR EACH ROW EXECUTE FUNCTION eureka.placement_write_guard();
CREATE TRIGGER assignment_write_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.assignment
  FOR EACH ROW EXECUTE FUNCTION eureka.placement_write_guard();
CREATE TRIGGER outbox_event_write_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.outbox_event
  FOR EACH ROW EXECUTE FUNCTION eureka.placement_write_guard();

-- Idempotency rows: the server stamps created_at; key, endpoint, hash and owner never change.
CREATE FUNCTION eureka.idempotency_key_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := pg_catalog.now();
    IF NEW.response IS NOT NULL THEN
      RAISE EXCEPTION 'server_managed_field' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.key, NEW.user_id, NEW.endpoint, NEW.request_hash, NEW.created_at)
     IS DISTINCT FROM (OLD.key, OLD.user_id, OLD.endpoint, OLD.request_hash, OLD.created_at)
     OR OLD.response IS NOT NULL THEN
    RAISE EXCEPTION 'idempotency key is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER idempotency_key_guard BEFORE INSERT OR UPDATE ON eureka.idempotency_key
  FOR EACH ROW EXECUTE FUNCTION eureka.idempotency_key_guard();

ALTER TABLE eureka.placement         ENABLE ROW LEVEL SECURITY; ALTER TABLE eureka.placement         FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.placement_contact ENABLE ROW LEVEL SECURITY; ALTER TABLE eureka.placement_contact FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.assignment        ENABLE ROW LEVEL SECURITY; ALTER TABLE eureka.assignment        FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.outbox_event      ENABLE ROW LEVEL SECURITY; ALTER TABLE eureka.outbox_event      FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.idempotency_key   ENABLE ROW LEVEL SECURITY; ALTER TABLE eureka.idempotency_key   FORCE ROW LEVEL SECURITY;

RESET ROLE;

REVOKE ALL ON eureka.implementation_partner, eureka.placement, eureka.placement_contact,
  eureka.assignment, eureka.outbox_event, eureka.idempotency_key FROM PUBLIC;
REVOKE ALL ON FUNCTION eureka.placement_write_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION eureka.idempotency_key_guard() FROM PUBLIC;

-- ---------- grants ----------
GRANT SELECT ON eureka.implementation_partner TO eureka_app;
-- App: read only. Rates are filtered by the API field policy (PL-6), as for submissions.
GRANT SELECT ON eureka.placement, eureka.placement_contact, eureka.assignment TO eureka_app;
GRANT SELECT, INSERT (key, user_id, endpoint, request_hash) ON eureka.idempotency_key TO eureka_app;
GRANT UPDATE (response) ON eureka.idempotency_key TO eureka_app;

-- Definer: exactly what the two functions write.
GRANT SELECT, INSERT ON eureka.placement TO authz_definer;
GRANT UPDATE (status, status_reason, status_changed_at, status_changed_by, joined_at, updated_at)
  ON eureka.placement TO authz_definer;
GRANT INSERT ON eureka.placement_contact TO authz_definer;
GRANT SELECT, INSERT ON eureka.assignment TO authz_definer;
GRANT UPDATE (end_date, end_reason, updated_at) ON eureka.assignment TO authz_definer;
GRANT INSERT ON eureka.outbox_event TO authz_definer;

CREATE POLICY definer_read   ON eureka.placement FOR SELECT TO authz_definer USING (true);
CREATE POLICY definer_insert ON eureka.placement FOR INSERT TO authz_definer WITH CHECK (true);
CREATE POLICY definer_update ON eureka.placement FOR UPDATE TO authz_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_insert ON eureka.placement_contact FOR INSERT TO authz_definer WITH CHECK (true);
CREATE POLICY definer_read   ON eureka.assignment FOR SELECT TO authz_definer USING (true);
CREATE POLICY definer_insert ON eureka.assignment FOR INSERT TO authz_definer WITH CHECK (true);
CREATE POLICY definer_update ON eureka.assignment FOR UPDATE TO authz_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_insert ON eureka.outbox_event FOR INSERT TO authz_definer WITH CHECK (true);

-- ---------- app read policies (design B4.4: actor snapshot or owned candidate) ----------
CREATE POLICY placement_read ON eureka.placement FOR SELECT TO eureka_app USING (
  (SELECT authz.has_org('placement:read'))
  OR recruiter_id = ANY ((SELECT authz.recruiter_ids('placement:read'))::uuid[])
  OR team_id      = ANY ((SELECT authz.team_ids('placement:read'))::uuid[])
  OR location_id  = ANY ((SELECT authz.location_ids('placement:read'))::uuid[])
  OR candidate_id = ANY ((SELECT authz.owned_candidate_ids('placement:read'))::uuid[])
);
-- Contacts and the assignment are readable wherever their placement is (the
-- sub-select runs under the caller's placement policy).
CREATE POLICY placement_contact_read ON eureka.placement_contact FOR SELECT TO eureka_app
  USING (placement_id IN (SELECT p.id FROM eureka.placement p));
CREATE POLICY assignment_read ON eureka.assignment FOR SELECT TO eureka_app
  USING (placement_id IN (SELECT p.id FROM eureka.placement p));
-- Idempotency rows belong to their user only.
CREATE POLICY idempotency_own ON eureka.idempotency_key FOR ALL TO eureka_app
  USING (user_id = (SELECT authz.current_user_id()))
  WITH CHECK (user_id = (SELECT authz.current_user_id()));
-- outbox_event: no app or worker policy yet (default deny); delivery job comes later.

-- ---------- functions ----------
SET ROLE authz_definer;

-- Candidate status side effects of placement events (PL-5, design N2). Not
-- executable by the app: authorization is the placement action that calls it.
-- Pairs are the candidate state machine edges placements drive (design B2.6);
-- full_of_interviews -> confirmation is added for a selection while the
-- candidate is marked full of interviews.
CREATE FUNCTION authz.candidate_status_by_placement(p_candidate uuid, p_to text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE cur text;
BEGIN
  SELECT c.marketing_status INTO cur FROM eureka.candidate c WHERE c.id = p_candidate FOR UPDATE;
  IF NOT FOUND OR p_to IS NULL OR NOT coalesce((cur, p_to) IN (
      ('active', 'confirmation'), ('full_of_interviews', 'confirmation'),
      ('confirmation', 'placed'), ('confirmation', 'active'), ('placed', 'bench')), false) THEN
    RAISE EXCEPTION 'invalid_transition' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE eureka.candidate
     SET marketing_status = p_to,
         bench_since = CASE WHEN p_to = 'bench' THEN CURRENT_DATE ELSE NULL END
   WHERE id = p_candidate;
END $$;

-- PL-1..PL-3, PL-5, PL-7. Returns the new id and first-placement flag.
CREATE FUNCTION authz.create_placement(
  p_submission uuid, p_type text, p_rate numeric, p_work_mode text, p_city text, p_state text,
  p_start date, p_partner uuid, p_contacts jsonb)
RETURNS TABLE (placement_id uuid, is_first_placement boolean)
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
  -- PL-1: placement:create on the actor snapshot, and the caller can update the submission.
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
  -- Like submission:create, placement:create needs the candidate visible (incl. Open-to-all-teams).
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

  -- PL-3: first placement unless an earlier one for the person reached joined
  -- or did not end in backout.
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

  RETURN QUERY SELECT new_id, first;
END $$;

-- PL-4, PL-5, PL-7. Forward steps one at a time; backout before joined;
-- bgc_failed from any live state (needs placement.bgc_status:update).
CREATE FUNCTION authz.transition_placement(p_placement uuid, p_to text, p_reason text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  actor uuid := authz.current_user_id();
  p record;
  reason text := nullif(pg_catalog.btrim(p_reason), '');
  cand_status text;
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
    -- Candidate confirmation -> placed and a new assignment (number per person).
    PERFORM authz.candidate_status_by_placement(p.candidate_id, 'placed');
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('eureka.assignment:' || p.person_id::text));
    SELECT coalesce(max(a.assignment_no), 0) + 1 INTO next_no FROM eureka.assignment a WHERE a.person_id = p.person_id;
    INSERT INTO eureka.assignment (person_id, placement_id, assignment_no, start_date)
    VALUES (p.person_id, p.id, next_no, CURRENT_DATE);
  ELSIF p_to IN ('backout', 'bgc_failed') AND p.status IS DISTINCT FROM 'joined' THEN
    -- Back on the market; a candidate moved elsewhere meanwhile (terminated) stays put.
    IF cand_status = 'confirmation' THEN
      PERFORM authz.candidate_status_by_placement(p.candidate_id, 'active');
    END IF;
  ELSIF p_to = 'bgc_failed' AND p.status = 'joined' THEN
    UPDATE eureka.assignment SET end_date = greatest(start_date, CURRENT_DATE), end_reason = 'bgc_failed'
     WHERE placement_id = p.id AND end_date IS NULL;
    IF cand_status = 'placed' THEN
      PERFORM authz.candidate_status_by_placement(p.candidate_id, 'bench');
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
  RETURN p_to;
END $$;

-- True when the candidate has an open (pre-join) placement and the caller can
-- read the candidate; false otherwise (reveals nothing about other candidates).
CREATE FUNCTION authz.candidate_has_open_placement(p_candidate uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce(authz.candidate_visible(p_candidate, 'candidate:read'), false) AND EXISTS (
    SELECT 1 FROM eureka.placement p
    WHERE p.candidate_id = p_candidate AND p.status IN ('confirmed', 'paperwork', 'bgc', 'ready'))
$$;

-- Manual candidate transitions (0015) are refused while a placement is open:
-- the placement drives the candidate until it joins or backs out.
CREATE OR REPLACE FUNCTION authz.transition_candidate(p_candidate uuid, p_to text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE c record;
BEGIN
  SELECT * INTO c FROM eureka.candidate WHERE id = p_candidate FOR UPDATE;
  IF NOT FOUND OR NOT coalesce(
       authz.owns('candidate:read', c.recruiter_id, c.team_id, c.location_id)
       OR (authz.all_teams('candidate:read') AND c.visibility = 'all_teams'
           AND c.marketing_status IN ('active','full_of_interviews')), false) THEN
    RAISE EXCEPTION 'candidate not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT coalesce(authz.owns('candidate:update', c.recruiter_id, c.team_id, c.location_id), false) THEN
    RAISE EXCEPTION 'not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_to IS NULL OR NOT coalesce((c.marketing_status, p_to) IN (
      ('in_training','active'),
      ('active','on_hold'), ('active','stopped'), ('active','full_of_interviews'), ('active','confirmation'),
      ('on_hold','active'), ('full_of_interviews','active'),
      ('confirmation','active'), ('bench','active'),
      ('in_training','terminated'), ('active','terminated'), ('on_hold','terminated'),
      ('stopped','terminated'), ('full_of_interviews','terminated'), ('confirmation','terminated'),
      ('bench','terminated')), false) THEN
    RAISE EXCEPTION 'invalid transition % -> %', c.marketing_status, p_to USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM eureka.placement p
             WHERE p.candidate_id = p_candidate AND p.status IN ('confirmed', 'paperwork', 'bgc', 'ready')) THEN
    RAISE EXCEPTION 'placement_open' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE eureka.candidate SET marketing_status = p_to,
    bench_since = CASE WHEN p_to = 'bench' THEN current_date ELSE NULL END
  WHERE id = p_candidate;
  RETURN p_to;
END $$;

RESET ROLE;

REVOKE ALL ON FUNCTION authz.candidate_status_by_placement(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.create_placement(uuid, text, numeric, text, text, text, date, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.transition_placement(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.candidate_has_open_placement(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.create_placement(uuid, text, numeric, text, text, text, date, uuid, jsonb) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.transition_placement(uuid, text, text) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.candidate_has_open_placement(uuid) TO eureka_app;
