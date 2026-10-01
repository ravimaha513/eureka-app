-- Candidate extras (HANDOFF task 3; design B2.2, B3, B4.5, B4.8 N2/N11, FR-CAN-02/09/10).
--   1. batch: training batches (location, technology, start month). Readable by
--      every candidate:read holder; created only through authz.create_batch by
--      Sales leadership (candidate:create at team, hierarchy or org scope).
--      candidate.batch_id is a profile field (candidate:update, column guard)
--      and must point at a batch of the candidate's own location that is still
--      planned or in training.
--   2. candidate_event: append-only per-candidate timeline written only by
--      definer triggers (creation, status, visibility, rating, assignment,
--      batch, submissions, interviews, placements). Rows carry ids and state
--      identifiers only: no names, phones, emails, rates or free-text reasons
--      (from_value/to_value are CHECK-constrained identifiers). Readable where
--      the candidate is readable (candidate:read RLS, EXISTS by primary key);
--      events about a submission, interview or placement additionally need
--      that record to be readable (D-02: recruiters see only their own activity).
--   3. authz.candidate_duplicates: duplicate check on normalized email and
--      E.164 phone (N11: name plus email or phone required). Returns at most
--      three matches, each with the owning team's name and its lead as the
--      contact; the candidate id only when the caller can read that candidate.
-- Out of scope here: resumes (need the Phase 3 document quarantine pipeline)
-- and the DOB blind index (OD-04 open; needs KMS field encryption).
-- Every IF is NULL-safe (see 0012/0015).
SET search_path = eureka, public;

-- ---------- tables ----------
SET ROLE eureka_owner;

CREATE TABLE eureka.batch (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id   uuid NOT NULL REFERENCES eureka.location(id),
  technology_id uuid NOT NULL REFERENCES eureka.technology(id),
  start_month   date NOT NULL CHECK (start_month = date_trunc('month', start_month)::date
                                     AND start_month BETWEEN date '2000-01-01' AND date '2100-12-01'),
  size_planned  integer CHECK (size_planned BETWEEN 1 AND 500),
  status        text NOT NULL DEFAULT 'planned'
                CHECK (status IN ('planned', 'in_training', 'completed', 'cancelled')),
  created_by    uuid NOT NULL REFERENCES eureka.app_user(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (location_id, technology_id, start_month)
);

ALTER TABLE eureka.candidate ADD COLUMN batch_id uuid REFERENCES eureka.batch(id);
CREATE INDEX candidate_batch ON eureka.candidate (batch_id) WHERE batch_id IS NOT NULL;

-- Duplicate check lookups (normalized: lower-case email, E.164 phone).
CREATE INDEX person_phone ON eureka.person (phone_e164) WHERE phone_e164 IS NOT NULL;
CREATE INDEX person_email_lower ON eureka.person (lower(personal_email::text)) WHERE personal_email IS NOT NULL;
CREATE INDEX candidate_marketing_email_lower ON eureka.candidate (lower(marketing_email::text)) WHERE marketing_email IS NOT NULL;

CREATE TABLE eureka.candidate_event (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  candidate_id uuid NOT NULL REFERENCES eureka.candidate(id),
  type         text NOT NULL CHECK (type IN (
                 'candidate.created', 'candidate.status_changed', 'candidate.visibility_changed',
                 'candidate.rating_changed', 'candidate.assigned', 'candidate.batch_changed',
                 'submission.created', 'submission.status_changed',
                 'interview.scheduled', 'interview.status_changed', 'interview.cleared',
                 'placement.created', 'placement.status_changed')),
  at           timestamptz NOT NULL DEFAULT now(),
  -- No FK, like audit_event: the actor is whatever user context the write ran under.
  actor_id     uuid,
  ref_type     text CHECK (ref_type IN ('submission', 'interview', 'placement', 'team', 'batch')),
  ref_id       uuid,
  -- State identifiers only (statuses, visibility, rating digits): never free text.
  from_value   text CHECK (from_value ~ '^[a-z0-9_]{1,40}$'),
  to_value     text CHECK (to_value ~ '^[a-z0-9_]{1,40}$'),
  CONSTRAINT candidate_event_ref CHECK (ref_id IS NULL OR ref_type IS NOT NULL)
);
CREATE INDEX candidate_event_timeline ON eureka.candidate_event (candidate_id, id DESC);

-- Batches and events are written only inside authz_definer functions; the
-- server stamps who and when. Neither is ever updated or deleted here.
CREATE FUNCTION eureka.candidate_extras_write_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF current_user IS DISTINCT FROM 'authz_definer' THEN
    RAISE EXCEPTION '% rows are written only by definer functions', TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_TABLE_NAME = 'candidate_event' THEN
    NEW.at := pg_catalog.now();
    NEW.actor_id := authz.current_user_id();
  ELSE
    NEW.created_at := pg_catalog.now();
    NEW.created_by := authz.current_user_id();
    NEW.status := 'planned';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER batch_write_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.batch
  FOR EACH ROW EXECUTE FUNCTION eureka.candidate_extras_write_guard();
CREATE TRIGGER candidate_event_write_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.candidate_event
  FOR EACH ROW EXECUTE FUNCTION eureka.candidate_extras_write_guard();

-- batch_id joins the candidate:update profile fields. Otherwise unchanged from 0013.
CREATE OR REPLACE FUNCTION eureka.candidate_column_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  is_definer boolean := current_user = 'authz_definer';
  owns_old   boolean;
BEGIN
  -- Never changeable through the API.
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.person_id IS DISTINCT FROM OLD.person_id
     OR NEW.location_id IS DISTINCT FROM OLD.location_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'column is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Status columns change only through authz.transition_candidate (N2).
  IF (NEW.marketing_status IS DISTINCT FROM OLD.marketing_status
      OR NEW.bench_since IS DISTINCT FROM OLD.bench_since) AND NOT is_definer THEN
    RAISE EXCEPTION 'status changes must use a transition' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF (NEW.technology_id, NEW.gh_location_id, NEW.priority, NEW.marketing_email, NEW.vitel_number,
      NEW.marketing_start_date, NEW.in_person_ok, NEW.batch_id)
     IS DISTINCT FROM
     (OLD.technology_id, OLD.gh_location_id, OLD.priority, OLD.marketing_email, OLD.vitel_number,
      OLD.marketing_start_date, OLD.in_person_ok, OLD.batch_id)
     AND NOT authz.owns('candidate:update', OLD.recruiter_id, OLD.team_id, OLD.location_id) THEN
    RAISE EXCEPTION 'not permitted to update profile fields' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.technical_rating IS DISTINCT FROM OLD.technical_rating
     AND NOT authz.owns('candidate.rating:update', OLD.recruiter_id, OLD.team_id, OLD.location_id) THEN
    RAISE EXCEPTION 'not permitted to update technical rating' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.visibility IS DISTINCT FROM OLD.visibility
     AND NOT authz.owns('candidate.visibility:update', OLD.recruiter_id, OLD.team_id, OLD.location_id) THEN
    RAISE EXCEPTION 'not permitted to change visibility' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.team_id IS DISTINCT FROM OLD.team_id
     OR (NEW.recruiter_id IS DISTINCT FROM OLD.recruiter_id AND NOT is_definer) THEN
    owns_old := authz.owns('candidate:assign', OLD.recruiter_id, OLD.team_id, OLD.location_id);
    IF NOT owns_old
       OR NOT coalesce(authz.has_org('candidate:assign') OR NEW.team_id = ANY (authz.team_ids('candidate:assign')), false) THEN
      RAISE EXCEPTION 'not permitted to reassign candidate' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  NEW.updated_at := now();
  NEW.row_version := OLD.row_version + 1;
  RETURN NEW;
END $$;

ALTER TABLE eureka.batch           ENABLE ROW LEVEL SECURITY; ALTER TABLE eureka.batch           FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.candidate_event ENABLE ROW LEVEL SECURITY; ALTER TABLE eureka.candidate_event FORCE ROW LEVEL SECURITY;

-- Batches are planning data: any candidate:read holder may list them.
CREATE POLICY batch_read ON eureka.batch FOR SELECT TO eureka_app
  USING ((SELECT authz.has_perm('candidate:read')));
CREATE POLICY definer_read   ON eureka.batch FOR SELECT TO authz_definer USING (true);
CREATE POLICY definer_insert ON eureka.batch FOR INSERT TO authz_definer WITH CHECK (true);

-- Timeline: readable where the candidate is (the EXISTS runs under the
-- caller's candidate policy, whose scope arrays are InitPlans), and activity
-- events only where the referenced activity row is readable too (by primary key).
CREATE POLICY candidate_event_read ON eureka.candidate_event FOR SELECT TO eureka_app USING (
  EXISTS (SELECT 1 FROM eureka.candidate c WHERE c.id = candidate_event.candidate_id)
  AND CASE candidate_event.ref_type
        WHEN 'submission' THEN EXISTS (SELECT 1 FROM eureka.submission s WHERE s.id = candidate_event.ref_id)
        WHEN 'interview'  THEN EXISTS (SELECT 1 FROM eureka.interview i WHERE i.id = candidate_event.ref_id)
        WHEN 'placement'  THEN EXISTS (SELECT 1 FROM eureka.placement p WHERE p.id = candidate_event.ref_id)
        ELSE true
      END
);
CREATE POLICY definer_insert ON eureka.candidate_event FOR INSERT TO authz_definer WITH CHECK (true);

-- The duplicate check reads person rows through definer_read (0011).

RESET ROLE;

REVOKE ALL ON eureka.batch, eureka.candidate_event FROM PUBLIC;
REVOKE ALL ON FUNCTION eureka.candidate_extras_write_guard() FROM PUBLIC;
GRANT SELECT ON eureka.batch, eureka.candidate_event TO eureka_app;
GRANT SELECT, INSERT ON eureka.batch TO authz_definer;
GRANT INSERT ON eureka.candidate_event TO authz_definer;

-- ---------- functions ----------
SET ROLE authz_definer;

-- Sales leadership plans batches: candidate:create at team, hierarchy or org
-- scope (a recruiter's "own" grant does not qualify). Mirrors canCreateBatch()
-- in packages/shared.
CREATE FUNCTION authz.batch_manager() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM authz.grants('candidate:create') g WHERE g.scope IN ('team', 'hierarchy', 'org'))
$$;

CREATE FUNCTION authz.create_batch(p_location uuid, p_technology uuid, p_start_month date, p_size integer)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE new_id uuid;
BEGIN
  IF authz.current_user_id() IS NULL OR NOT coalesce(authz.batch_manager(), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_location IS NULL OR p_technology IS NULL OR p_start_month IS NULL
     OR NOT EXISTS (SELECT 1 FROM eureka.location l WHERE l.id = p_location)
     OR NOT EXISTS (SELECT 1 FROM eureka.technology t WHERE t.id = p_technology AND t.active)
     OR (p_size IS NOT NULL AND NOT coalesce(p_size BETWEEN 1 AND 500, false)) THEN
    RAISE EXCEPTION 'invalid_batch' USING ERRCODE = 'check_violation';
  END IF;
  BEGIN
    INSERT INTO eureka.batch (location_id, technology_id, start_month, size_planned)
    VALUES (p_location, p_technology, pg_catalog.date_trunc('month', p_start_month)::date, p_size)
    RETURNING id INTO new_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'batch_exists' USING ERRCODE = 'unique_violation';
  END;
  RETURN new_id;
END $$;

-- A candidate's batch must be at the candidate's location and still open.
CREATE FUNCTION authz.candidate_batch_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.batch_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.batch_id IS NOT DISTINCT FROM OLD.batch_id THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM eureka.batch b
                 WHERE b.id = NEW.batch_id AND b.location_id = NEW.location_id
                   AND b.status IN ('planned', 'in_training')) THEN
    RAISE EXCEPTION 'batch_not_allowed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- Internal writer. Not executable by the app: rows come only from the triggers below.
CREATE FUNCTION authz.add_candidate_event(
  p_candidate uuid, p_type text, p_ref_type text, p_ref_id uuid, p_from text, p_to text) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  INSERT INTO eureka.candidate_event (candidate_id, type, ref_type, ref_id, from_value, to_value)
  VALUES (p_candidate, p_type, p_ref_type, p_ref_id, p_from, p_to)
$$;

CREATE FUNCTION authz.candidate_event_on_candidate() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM authz.add_candidate_event(NEW.id, 'candidate.created', NULL, NULL, NULL, NEW.marketing_status);
    IF NEW.batch_id IS NOT NULL THEN
      PERFORM authz.add_candidate_event(NEW.id, 'candidate.batch_changed', 'batch', NEW.batch_id, NULL, NULL);
    END IF;
    RETURN NULL;
  END IF;
  IF NEW.marketing_status IS DISTINCT FROM OLD.marketing_status THEN
    PERFORM authz.add_candidate_event(NEW.id, 'candidate.status_changed', NULL, NULL, OLD.marketing_status, NEW.marketing_status);
  END IF;
  IF NEW.visibility IS DISTINCT FROM OLD.visibility THEN
    PERFORM authz.add_candidate_event(NEW.id, 'candidate.visibility_changed', NULL, NULL, OLD.visibility, NEW.visibility);
  END IF;
  IF NEW.technical_rating IS DISTINCT FROM OLD.technical_rating THEN
    PERFORM authz.add_candidate_event(NEW.id, 'candidate.rating_changed', NULL, NULL,
      OLD.technical_rating::text, NEW.technical_rating::text);
  END IF;
  IF (NEW.team_id, NEW.recruiter_id) IS DISTINCT FROM (OLD.team_id, OLD.recruiter_id) THEN
    PERFORM authz.add_candidate_event(NEW.id, 'candidate.assigned', 'team', NEW.team_id, NULL, NULL);
  END IF;
  IF NEW.batch_id IS DISTINCT FROM OLD.batch_id THEN
    PERFORM authz.add_candidate_event(NEW.id, 'candidate.batch_changed', 'batch', NEW.batch_id, NULL, NULL);
  END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION authz.candidate_event_on_activity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE kind text := TG_TABLE_NAME;
BEGIN
  IF kind = 'submission' THEN
    IF TG_OP = 'INSERT' THEN
      PERFORM authz.add_candidate_event(NEW.candidate_id, 'submission.created', 'submission', NEW.id, NULL, NEW.status);
    ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
      PERFORM authz.add_candidate_event(NEW.candidate_id, 'submission.status_changed', 'submission', NEW.id, OLD.status, NEW.status);
    END IF;
  ELSIF kind = 'interview' THEN
    IF TG_OP = 'INSERT' THEN
      PERFORM authz.add_candidate_event(NEW.candidate_id, 'interview.scheduled', 'interview', NEW.id, NULL, NEW.call_status);
    ELSE
      IF NEW.call_status IS DISTINCT FROM OLD.call_status THEN
        PERFORM authz.add_candidate_event(NEW.candidate_id, 'interview.status_changed', 'interview', NEW.id, OLD.call_status, NEW.call_status);
      END IF;
      IF NEW.cleared IS DISTINCT FROM OLD.cleared THEN
        PERFORM authz.add_candidate_event(NEW.candidate_id, 'interview.cleared', 'interview', NEW.id, NULL,
          CASE WHEN coalesce(NEW.cleared, false) THEN 'cleared' ELSE 'not_cleared' END);
      END IF;
    END IF;
  ELSIF kind = 'placement' THEN
    IF TG_OP = 'INSERT' THEN
      PERFORM authz.add_candidate_event(NEW.candidate_id, 'placement.created', 'placement', NEW.id, NULL, NEW.status);
    ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
      PERFORM authz.add_candidate_event(NEW.candidate_id, 'placement.status_changed', 'placement', NEW.id, OLD.status, NEW.status);
    END IF;
  END IF;
  RETURN NULL;
END $$;

-- Duplicate check (design B3, N11). Inputs are normalized by the API (lower-case
-- email, E.164 phone) and re-validated here. A match reveals only that a likely
-- duplicate exists, which supplied identifier matched, the owning team's name
-- and its lead as the contact; the candidate id only when the caller can read
-- that candidate. The API rate-limits and audits every call.
CREATE FUNCTION authz.candidate_duplicates(p_first text, p_last text, p_email text, p_phone text)
RETURNS TABLE (candidate_id uuid, team_name text, contact_name text, matched_on text[])
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  em text := nullif(pg_catalog.lower(pg_catalog.btrim(p_email)), '');
  ph text := nullif(pg_catalog.btrim(p_phone), '');
BEGIN
  IF authz.current_user_id() IS NULL OR NOT coalesce(authz.has_perm('candidate:create'), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF nullif(pg_catalog.btrim(p_first), '') IS NULL OR nullif(pg_catalog.btrim(p_last), '') IS NULL
     OR (em IS NULL AND ph IS NULL) THEN
    RAISE EXCEPTION 'name_and_contact_required' USING ERRCODE = 'check_violation';
  END IF;
  IF (ph IS NOT NULL AND NOT coalesce(ph ~ '^\+[1-9][0-9]{7,14}$', false))
     OR (em IS NOT NULL AND NOT coalesce(pg_catalog.char_length(em) <= 254 AND em ~ '^[^@[:space:]]+@[^@[:space:]]+$', false)) THEN
    RAISE EXCEPTION 'invalid_contact' USING ERRCODE = 'check_violation';
  END IF;
  RETURN QUERY
  WITH hits AS (
    SELECT c.id, c.team_id, c.created_at,
      (em IS NOT NULL AND (pg_catalog.lower(p.personal_email::text) = em
                           OR pg_catalog.lower(c.marketing_email::text) = em)) AS by_email,
      (ph IS NOT NULL AND p.phone_e164 = ph) AS by_phone
    FROM eureka.candidate c JOIN eureka.person p ON p.id = c.person_id
    WHERE (em IS NOT NULL AND (pg_catalog.lower(p.personal_email::text) = em
                               OR pg_catalog.lower(c.marketing_email::text) = em))
       OR (ph IS NOT NULL AND p.phone_e164 = ph)
    ORDER BY c.created_at, c.id
    LIMIT 3
  )
  SELECT CASE WHEN coalesce(authz.candidate_visible(h.id, 'candidate:read'), false) THEN h.id END,
         t.name, u.display_name,
         pg_catalog.array_remove(ARRAY[CASE WHEN h.by_email THEN 'email' END, CASE WHEN h.by_phone THEN 'phone' END], NULL)
  FROM hits h
  JOIN eureka.team t ON t.id = h.team_id
  LEFT JOIN eureka.app_user u ON u.id = t.lead_id
  ORDER BY h.created_at, h.id;
END $$;

RESET ROLE;

CREATE TRIGGER candidate_batch_check BEFORE INSERT OR UPDATE OF batch_id ON eureka.candidate
  FOR EACH ROW EXECUTE FUNCTION authz.candidate_batch_check();
CREATE TRIGGER candidate_event_insert AFTER INSERT ON eureka.candidate
  FOR EACH ROW EXECUTE FUNCTION authz.candidate_event_on_candidate();
CREATE TRIGGER candidate_event_update AFTER UPDATE ON eureka.candidate
  FOR EACH ROW WHEN ((OLD.marketing_status, OLD.visibility, OLD.technical_rating, OLD.team_id, OLD.recruiter_id, OLD.batch_id)
                     IS DISTINCT FROM
                     (NEW.marketing_status, NEW.visibility, NEW.technical_rating, NEW.team_id, NEW.recruiter_id, NEW.batch_id))
  EXECUTE FUNCTION authz.candidate_event_on_candidate();
CREATE TRIGGER candidate_event_insert AFTER INSERT ON eureka.submission
  FOR EACH ROW EXECUTE FUNCTION authz.candidate_event_on_activity();
CREATE TRIGGER candidate_event_update AFTER UPDATE ON eureka.submission
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION authz.candidate_event_on_activity();
CREATE TRIGGER candidate_event_insert AFTER INSERT ON eureka.interview
  FOR EACH ROW EXECUTE FUNCTION authz.candidate_event_on_activity();
CREATE TRIGGER candidate_event_update AFTER UPDATE ON eureka.interview
  FOR EACH ROW WHEN ((OLD.call_status, OLD.cleared) IS DISTINCT FROM (NEW.call_status, NEW.cleared))
  EXECUTE FUNCTION authz.candidate_event_on_activity();
CREATE TRIGGER candidate_event_insert AFTER INSERT ON eureka.placement
  FOR EACH ROW EXECUTE FUNCTION authz.candidate_event_on_activity();
CREATE TRIGGER candidate_event_update AFTER UPDATE ON eureka.placement
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION authz.candidate_event_on_activity();

-- EXECUTE: the app calls create_batch and the duplicate check; batch_manager,
-- the writer and the trigger functions are internal (no app grant).
REVOKE ALL ON FUNCTION authz.batch_manager() FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.create_batch(uuid, uuid, date, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.candidate_batch_check() FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.add_candidate_event(uuid, text, text, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.candidate_event_on_candidate() FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.candidate_event_on_activity() FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.candidate_duplicates(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.create_batch(uuid, uuid, date, integer) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.candidate_duplicates(text, text, text, text) TO eureka_app;
