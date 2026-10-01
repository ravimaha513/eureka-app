-- Review follow-ups for 0026 (candidate extras), 2026-10-01.
--   1. D-02: candidate status changes driven by a placement were recorded on
--      the timeline with no reference, so any viewer of the candidate (e.g.
--      another team through Open to all teams) saw the placement history and
--      who drove it. They now carry ref_type 'placement' and the placement id,
--      so they are listed only where that placement is readable. The link is
--      passed through authz.placement_status_context, a table only
--      authz_definer can write (a client-set GUC could be spoofed).
--   2. authz.candidate_duplicates scanned every candidate when an email was
--      given (OR across person and candidate columns). It is now a UNION of
--      three index lookups followed by primary-key joins; same output.
--   3. Batches: status changes through authz.set_batch_status (planned ->
--      in_training -> completed; planned/in_training -> cancelled), same
--      permission as create; create and status changes limited to locations
--      in the caller's scope (locations of teams they own for candidate:create
--      and of those teams' candidates).
--   4. Rule 4 (pre-existing gap): eureka.candidate had no BEFORE INSERT guard,
--      so the app could insert a candidate already active, open to all teams,
--      rated or back-dated. App-role inserts now start from server defaults.
-- Every IF is NULL-safe (see 0012/0015).
SET search_path = eureka, public;

-- ---------- 1. placement-driven status events ----------
SET ROLE authz_definer;

-- One row per (transaction, candidate) while authz.candidate_status_by_placement
-- updates the candidate; deleted before it returns. No grants: the app and the
-- worker can neither read nor write it.
CREATE TABLE authz.placement_status_context (
  xact         xid8 NOT NULL,
  candidate_id uuid NOT NULL,
  placement_id uuid NOT NULL,
  PRIMARY KEY (xact, candidate_id)
);
REVOKE ALL ON authz.placement_status_context FROM PUBLIC;

-- Unchanged from 0022 except that it records which placement drives the change.
-- The acting placement is the candidate's latest: only one can be open, and a
-- new one needs the candidate active or full of interviews (PL-1, PL-5).
CREATE OR REPLACE FUNCTION authz.candidate_status_by_placement(p_candidate uuid, p_to text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE cur text; pl uuid;
BEGIN
  SELECT c.marketing_status INTO cur FROM eureka.candidate c WHERE c.id = p_candidate FOR UPDATE;
  IF NOT FOUND OR p_to IS NULL OR NOT coalesce((cur, p_to) IN (
      ('active', 'confirmation'), ('full_of_interviews', 'confirmation'),
      ('confirmation', 'placed'), ('confirmation', 'active'), ('placed', 'bench')), false) THEN
    RAISE EXCEPTION 'invalid_transition' USING ERRCODE = 'check_violation';
  END IF;
  SELECT p.id INTO pl FROM eureka.placement p WHERE p.candidate_id = p_candidate
   ORDER BY p.created_at DESC, p.id DESC LIMIT 1;
  IF pl IS NULL THEN
    RAISE EXCEPTION 'invalid_transition' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO authz.placement_status_context (xact, candidate_id, placement_id)
  VALUES (pg_catalog.pg_current_xact_id(), p_candidate, pl)
  ON CONFLICT (xact, candidate_id) DO UPDATE SET placement_id = EXCLUDED.placement_id;
  UPDATE eureka.candidate
     SET marketing_status = p_to,
         bench_since = CASE WHEN p_to = 'bench' THEN CURRENT_DATE ELSE NULL END
   WHERE id = p_candidate;
  DELETE FROM authz.placement_status_context
   WHERE xact = pg_catalog.pg_current_xact_id() AND candidate_id = p_candidate;
END $$;

-- Unchanged from 0026 except the status branch, which picks up the placement.
CREATE OR REPLACE FUNCTION authz.candidate_event_on_candidate() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE pl uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM authz.add_candidate_event(NEW.id, 'candidate.created', NULL, NULL, NULL, NEW.marketing_status);
    IF NEW.batch_id IS NOT NULL THEN
      PERFORM authz.add_candidate_event(NEW.id, 'candidate.batch_changed', 'batch', NEW.batch_id, NULL, NULL);
    END IF;
    RETURN NULL;
  END IF;
  IF NEW.marketing_status IS DISTINCT FROM OLD.marketing_status THEN
    SELECT x.placement_id INTO pl FROM authz.placement_status_context x
     WHERE x.xact = pg_catalog.pg_current_xact_id() AND x.candidate_id = NEW.id;
    PERFORM authz.add_candidate_event(NEW.id, 'candidate.status_changed',
      CASE WHEN pl IS NOT NULL THEN 'placement' END, pl, OLD.marketing_status, NEW.marketing_status);
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

-- ---------- 2. duplicate check: index lookups, then primary-key joins ----------
CREATE OR REPLACE FUNCTION authz.candidate_duplicates(p_first text, p_last text, p_email text, p_phone text)
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
  WITH m AS (
    -- person_email_lower, candidate_marketing_email_lower, person_phone (0026)
    SELECT c.id, 'email'::text AS kind FROM eureka.person p JOIN eureka.candidate c ON c.person_id = p.id
     WHERE em IS NOT NULL AND p.personal_email IS NOT NULL AND pg_catalog.lower(p.personal_email::text) = em
    UNION
    SELECT c.id, 'email' FROM eureka.candidate c
     WHERE em IS NOT NULL AND c.marketing_email IS NOT NULL AND pg_catalog.lower(c.marketing_email::text) = em
    UNION
    SELECT c.id, 'phone' FROM eureka.person p JOIN eureka.candidate c ON c.person_id = p.id
     WHERE ph IS NOT NULL AND p.phone_e164 IS NOT NULL AND p.phone_e164 = ph
  ),
  ids AS (
    SELECT m.id, pg_catalog.bool_or(m.kind = 'email') AS by_email, pg_catalog.bool_or(m.kind = 'phone') AS by_phone
    FROM m GROUP BY m.id
  ),
  hits AS (
    -- LATERAL keeps this a primary-key probe per match (a plain join was
    -- planned as a hash join over every candidate).
    SELECT ids.id, c.team_id, c.created_at, ids.by_email, ids.by_phone
    FROM ids CROSS JOIN LATERAL (
      SELECT cd.team_id, cd.created_at FROM eureka.candidate cd WHERE cd.id = ids.id) c
    ORDER BY c.created_at, ids.id
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

-- ---------- 3. batches: scope and status changes ----------

-- Locations where the caller may plan batches: every location with an org
-- candidate:create grant; otherwise the locations of the teams their Sales
-- grant owns (team or hierarchy, never "own") and of those teams' candidates.
CREATE FUNCTION authz.batch_location_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH t AS (SELECT authz.owned_team_ids('candidate:create') AS ids)
  SELECT CASE
    WHEN authz.has_org('candidate:create') THEN (SELECT coalesce(pg_catalog.array_agg(l.id), '{}') FROM eureka.location l)
    ELSE (SELECT coalesce(pg_catalog.array_agg(DISTINCT x), '{}') FROM (
      SELECT tm.location_id AS x FROM eureka.team tm, t WHERE tm.id = ANY (t.ids) AND tm.location_id IS NOT NULL
      UNION
      SELECT c.location_id FROM eureka.candidate c, t WHERE c.team_id = ANY (t.ids)) s)
  END
$$;

CREATE OR REPLACE FUNCTION authz.create_batch(p_location uuid, p_technology uuid, p_start_month date, p_size integer)
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
  IF NOT coalesce(p_location = ANY (authz.batch_location_ids()), false) THEN
    RAISE EXCEPTION 'location_not_in_scope' USING ERRCODE = 'insufficient_privilege';
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

CREATE FUNCTION authz.set_batch_status(p_batch uuid, p_to text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE b record;
BEGIN
  SELECT * INTO b FROM eureka.batch WHERE id = p_batch FOR UPDATE;
  IF NOT FOUND OR authz.current_user_id() IS NULL OR NOT coalesce(authz.has_perm('candidate:read'), false) THEN
    RAISE EXCEPTION 'batch_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT coalesce(authz.batch_manager() AND b.location_id = ANY (authz.batch_location_ids()), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_to IS NULL OR NOT coalesce((b.status, p_to) IN (
      ('planned', 'in_training'), ('in_training', 'completed'),
      ('planned', 'cancelled'), ('in_training', 'cancelled')), false) THEN
    RAISE EXCEPTION 'invalid_transition' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE eureka.batch SET status = p_to WHERE id = p_batch;
  RETURN p_to;
END $$;

RESET ROLE;

-- The write guard now lets the definer change a batch's status (and nothing
-- else); events stay append-only and batches are never deleted.
SET ROLE eureka_owner;
CREATE OR REPLACE FUNCTION eureka.candidate_extras_write_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF current_user IS DISTINCT FROM 'authz_definer' THEN
    RAISE EXCEPTION '% rows are written only by definer functions', TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'batch' THEN
    IF (pg_catalog.to_jsonb(NEW) - 'status') IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - 'status') THEN
      RAISE EXCEPTION 'only the batch status changes' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
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

-- ---------- 4. candidate BEFORE INSERT guard (rule 4) ----------
-- Application-role inserts (API, import commit) start from server defaults;
-- status, visibility and rating change only through their own paths later.
-- Seeds and migrations run as the owner or the migration user and are not
-- affected.
CREATE FUNCTION eureka.candidate_insert_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF current_user IN ('eureka_app', 'eureka_worker') THEN
    IF NEW.marketing_status IS DISTINCT FROM 'in_training' OR NEW.visibility IS DISTINCT FROM 'team'
       OR NEW.technical_rating IS NOT NULL OR NEW.bench_since IS NOT NULL
       OR NEW.row_version IS DISTINCT FROM 1 THEN
      RAISE EXCEPTION 'server_managed_field' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.created_at := pg_catalog.now();
    NEW.updated_at := pg_catalog.now();
  END IF;
  RETURN NEW;
END $$;
-- Named to fire before the other BEFORE INSERT triggers (name order).
CREATE TRIGGER candidate_0_insert_guard BEFORE INSERT ON eureka.candidate
  FOR EACH ROW EXECUTE FUNCTION eureka.candidate_insert_guard();
CREATE POLICY definer_update ON eureka.batch FOR UPDATE TO authz_definer USING (true) WITH CHECK (true);
RESET ROLE;

GRANT UPDATE (status) ON eureka.batch TO authz_definer;

REVOKE ALL ON FUNCTION eureka.candidate_insert_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.batch_location_ids() FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.set_batch_status(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.set_batch_status(uuid, text) TO eureka_app;
-- Replaced functions keep their grants (create_batch, candidate_duplicates:
-- eureka_app; candidate_status_by_placement and the trigger: internal).
