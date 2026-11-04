-- BGC employment and address history as rows (docs/paperwork-api.md PW-12).
-- Until now the check recorded only how many years were looked at
-- (bgc.employment_years / address_years, 0400). Each row here is one employer
-- or one address with its months and whether the vendor verified it. The
-- years columns stay for checks recorded before this, and the page shows them
-- while a check has no rows of that kind.
--
-- Rows are personal data (addresses, employer notes): readable under the same
-- document:read scope as the check itself (bgc_read, 0044), written only by
-- authz.save_bgc_entry / authz.delete_bgc_entry (bgc:update over the
-- placement), and never copied into audit_event or outbox_event (rule 5):
-- the audit gets the row id, its kind and the names of the changed fields.
-- bgc_event gets 'employment_history' / 'address_history' so the check's
-- history shows that the rows changed (again without values).

SET ROLE eureka_owner;

CREATE TABLE eureka.bgc_entry (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bgc_id       uuid NOT NULL REFERENCES eureka.bgc(id),
  -- Snapshots of the check (immutable), as on bgc.
  placement_id uuid NOT NULL REFERENCES eureka.placement(id),
  candidate_id uuid NOT NULL REFERENCES eureka.candidate(id),
  recruiter_id uuid NOT NULL REFERENCES eureka.app_user(id),
  team_id      uuid REFERENCES eureka.team(id),
  location_id  uuid REFERENCES eureka.location(id),
  kind         text NOT NULL CHECK (kind IN ('employment', 'address')),
  -- employment
  employer     text CHECK (char_length(btrim(employer)) BETWEEN 1 AND 120 AND employer !~ '[[:cntrl:]]'),
  title        text CHECK (char_length(btrim(title)) BETWEEN 1 AND 120 AND title !~ '[[:cntrl:]]'),
  -- address (street optional)
  street       text CHECK (char_length(btrim(street)) BETWEEN 1 AND 200 AND street !~ '[[:cntrl:]]'),
  city         text CHECK (char_length(btrim(city)) BETWEEN 1 AND 120 AND city !~ '[[:cntrl:]]'),
  region       text CHECK (char_length(btrim(region)) BETWEEN 1 AND 120 AND region !~ '[[:cntrl:]]'),
  postal_code  text CHECK (char_length(btrim(postal_code)) BETWEEN 1 AND 20 AND postal_code !~ '[[:cntrl:]]'),
  country      text CHECK (char_length(btrim(country)) BETWEEN 1 AND 60 AND country !~ '[[:cntrl:]]'),
  -- both: whole months; end NULL = still there
  start_month  date NOT NULL CHECK (start_month BETWEEN date '1950-01-01' AND date '2100-12-01' AND EXTRACT(DAY FROM start_month) = 1),
  end_month    date CHECK (end_month BETWEEN date '1950-01-01' AND date '2100-12-01' AND EXTRACT(DAY FROM end_month) = 1),
  verification text NOT NULL DEFAULT 'pending' CHECK (verification IN ('pending', 'verified', 'unverified')),
  notes        text CHECK (char_length(btrim(notes)) BETWEEN 1 AND 1000 AND notes !~ '[\x01-\x09\x0b-\x1f\x7f]'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid REFERENCES eureka.app_user(id),
  updated_at   timestamptz,
  updated_by   uuid REFERENCES eureka.app_user(id),
  version      integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  CONSTRAINT bgc_entry_months CHECK (end_month IS NULL OR end_month >= start_month),
  CONSTRAINT bgc_entry_kind_fields CHECK (
    (kind = 'employment' AND employer IS NOT NULL
       AND street IS NULL AND city IS NULL AND region IS NULL AND postal_code IS NULL AND country IS NULL)
    OR (kind = 'address' AND city IS NOT NULL AND country IS NOT NULL AND employer IS NULL AND title IS NULL))
);
CREATE INDEX bgc_entry_bgc ON eureka.bgc_entry (bgc_id, kind, start_month);
CREATE INDEX bgc_entry_candidate ON eureka.bgc_entry (candidate_id);

-- Rule 4: snapshots, version and who/when are the server's; only the definer
-- functions write (and authz.delete_candidate deletes).
CREATE FUNCTION eureka.bgc_entry_write_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE b record;
BEGIN
  IF current_user IS DISTINCT FROM 'authz_definer' THEN
    RAISE EXCEPTION 'bgc history rows are written only by definer functions' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT x.placement_id, x.candidate_id, x.recruiter_id, x.team_id, x.location_id INTO b
      FROM eureka.bgc x WHERE x.id = NEW.bgc_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'bgc_not_found' USING ERRCODE = 'foreign_key_violation';
    END IF;
    NEW.placement_id := b.placement_id; NEW.candidate_id := b.candidate_id; NEW.recruiter_id := b.recruiter_id;
    NEW.team_id := b.team_id; NEW.location_id := b.location_id;
    NEW.created_at := pg_catalog.now(); NEW.created_by := authz.current_user_id();
    NEW.updated_at := NULL; NEW.updated_by := NULL; NEW.version := 1;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.bgc_id, NEW.placement_id, NEW.candidate_id, NEW.recruiter_id, NEW.team_id, NEW.location_id,
      NEW.kind, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.id, OLD.bgc_id, OLD.placement_id, OLD.candidate_id, OLD.recruiter_id, OLD.team_id, OLD.location_id,
      OLD.kind, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'column is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.version := OLD.version + 1;
  NEW.updated_at := pg_catalog.now();
  NEW.updated_by := authz.current_user_id();
  RETURN NEW;
END $$;
CREATE TRIGGER bgc_entry_write_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.bgc_entry
  FOR EACH ROW EXECUTE FUNCTION eureka.bgc_entry_write_guard();
CREATE TRIGGER bgc_entry_no_truncate BEFORE TRUNCATE ON eureka.bgc_entry
  FOR EACH STATEMENT EXECUTE FUNCTION eureka.paperwork_no_truncate();

-- The check's history may now name the rows (no values).
ALTER TABLE eureka.bgc_event DROP CONSTRAINT bgc_event_changed_check;
ALTER TABLE eureka.bgc_event ADD CONSTRAINT bgc_event_changed_check CHECK (cardinality(changed) >= 1 AND changed <@ ARRAY[
  'status', 'bgc_company', 'initiated_on', 'completed_on', 'helped_by', 'education_level',
  'employment_years', 'address_years', 'notes', 'employment_history', 'address_history']::text[]);

ALTER TABLE eureka.bgc_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE eureka.bgc_entry FORCE ROW LEVEL SECURITY;

-- Rule 3: the same InitPlan scope as bgc_read (document:read over the snapshot or the owned candidate).
CREATE POLICY bgc_entry_read ON eureka.bgc_entry FOR SELECT TO eureka_app USING (
  (SELECT authz.has_org('document:read'))
  OR recruiter_id = ANY ((SELECT authz.recruiter_ids('document:read'))::uuid[])
  OR team_id      = ANY ((SELECT authz.team_ids('document:read'))::uuid[])
  OR location_id  = ANY ((SELECT authz.location_ids('document:read'))::uuid[])
  OR candidate_id IN (SELECT pg_catalog.unnest((SELECT authz.owned_candidate_ids('document:read'))))
);
CREATE POLICY definer_read   ON eureka.bgc_entry FOR SELECT TO authz_definer USING (true);
CREATE POLICY definer_insert ON eureka.bgc_entry FOR INSERT TO authz_definer WITH CHECK (true);
CREATE POLICY definer_update ON eureka.bgc_entry FOR UPDATE TO authz_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_delete ON eureka.bgc_entry FOR DELETE TO authz_definer USING (true);

RESET ROLE;

REVOKE ALL ON eureka.bgc_entry FROM PUBLIC;
REVOKE ALL ON FUNCTION eureka.bgc_entry_write_guard() FROM PUBLIC;
GRANT SELECT ON eureka.bgc_entry TO eureka_app;
GRANT SELECT, INSERT, DELETE ON eureka.bgc_entry TO authz_definer;
GRANT UPDATE (employer, title, street, city, region, postal_code, country, start_month, end_month, verification, notes,
              updated_at, updated_by, version) ON eureka.bgc_entry TO authz_definer;

-- =====================================================================
-- Writes (rule 6): bgc:update over the placement, re-checked here.
-- p_fields keys (camelCase, strings or null): employment: employer, title;
-- address: street, city, region, postalCode, country; both: startMonth,
-- endMonth ('YYYY-MM'), verification, notes. A new row (p_entry NULL) needs
-- p_kind and its required fields; an update changes only the keys given.
-- =====================================================================
SET ROLE authz_definer;

CREATE FUNCTION authz.save_bgc_entry(p_placement uuid, p_entry uuid, p_kind text, p_fields jsonb, p_expected_version integer)
 RETURNS TABLE(entry_id uuid, entry_kind text, new_version integer, created boolean, changed text[])
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  actor uuid := authz.current_user_id();
  pl record; b record; e record;
  allowed text[];
  v jsonb;
  r eureka.bgc_entry%ROWTYPE;
  ch text[] := ARRAY[]::text[];
  is_new boolean := p_entry IS NULL;
BEGIN
  SELECT * INTO pl FROM eureka.placement p WHERE p.id = p_placement;
  IF NOT FOUND OR actor IS NULL OR NOT coalesce(authz.placement_covered(p_placement, 'document:read'), false) THEN
    RAISE EXCEPTION 'placement_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT coalesce(authz.placement_covered(p_placement, 'bgc:update'), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF coalesce(pl.status = 'backout', true) THEN
    RAISE EXCEPTION 'placement_closed' USING ERRCODE = 'check_violation';
  END IF;

  IF is_new THEN
    INSERT INTO eureka.bgc (placement_id) VALUES (p_placement) ON CONFLICT (placement_id) DO NOTHING;
    SELECT * INTO b FROM eureka.bgc x WHERE x.placement_id = p_placement FOR UPDATE;
    r.kind := p_kind;
    r.verification := 'pending';
  ELSE
    SELECT * INTO e FROM eureka.bgc_entry x WHERE x.id = p_entry AND x.placement_id = p_placement FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'entry_not_found' USING ERRCODE = 'no_data_found';
    END IF;
    IF p_expected_version IS NOT NULL AND p_expected_version IS DISTINCT FROM e.version THEN
      RAISE EXCEPTION 'version_mismatch' USING ERRCODE = 'serialization_failure';
    END IF;
    IF p_kind IS NOT NULL AND p_kind IS DISTINCT FROM e.kind THEN
      RAISE EXCEPTION 'invalid_change' USING ERRCODE = 'check_violation';
    END IF;
    SELECT * INTO r FROM eureka.bgc_entry x WHERE x.id = p_entry;
  END IF;

  allowed := CASE r.kind
    WHEN 'employment' THEN ARRAY['employer', 'title', 'startMonth', 'endMonth', 'verification', 'notes']
    WHEN 'address' THEN ARRAY['street', 'city', 'region', 'postalCode', 'country', 'startMonth', 'endMonth', 'verification', 'notes']
  END;
  IF allowed IS NULL
     OR pg_catalog.jsonb_typeof(p_fields) IS DISTINCT FROM 'object'
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.jsonb_object_keys(p_fields))
     OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_each(p_fields) f
                WHERE NOT f.key = ANY (allowed) OR pg_catalog.jsonb_typeof(f.value) NOT IN ('string', 'null'))
     OR coalesce(p_fields ->> 'startMonth' !~ '^[0-9]{4}-(0[1-9]|1[0-2])$', false)
     OR coalesce(p_fields ->> 'endMonth' !~ '^[0-9]{4}-(0[1-9]|1[0-2])$', false)
     OR coalesce(p_fields ->> 'verification' NOT IN ('pending', 'verified', 'unverified'), false)
     OR coalesce(p_fields ? 'verification' AND pg_catalog.jsonb_typeof(p_fields -> 'verification') = 'null', false) THEN
    RAISE EXCEPTION 'invalid_change' USING ERRCODE = 'check_violation';
  END IF;
  IF is_new AND (SELECT count(*) FROM eureka.bgc_entry x WHERE x.bgc_id = b.id AND x.kind = r.kind) >= 50 THEN
    RAISE EXCEPTION 'too_many_entries' USING ERRCODE = 'check_violation';
  END IF;

  -- Blank text clears a field; months are stored as their first day.
  IF p_fields ? 'employer' THEN r.employer := nullif(pg_catalog.btrim(p_fields ->> 'employer'), ''); END IF;
  IF p_fields ? 'title' THEN r.title := nullif(pg_catalog.btrim(p_fields ->> 'title'), ''); END IF;
  IF p_fields ? 'street' THEN r.street := nullif(pg_catalog.btrim(p_fields ->> 'street'), ''); END IF;
  IF p_fields ? 'city' THEN r.city := nullif(pg_catalog.btrim(p_fields ->> 'city'), ''); END IF;
  IF p_fields ? 'region' THEN r.region := nullif(pg_catalog.btrim(p_fields ->> 'region'), ''); END IF;
  IF p_fields ? 'postalCode' THEN r.postal_code := nullif(pg_catalog.btrim(p_fields ->> 'postalCode'), ''); END IF;
  IF p_fields ? 'country' THEN r.country := nullif(pg_catalog.btrim(p_fields ->> 'country'), ''); END IF;
  IF p_fields ? 'notes' THEN r.notes := nullif(pg_catalog.btrim(p_fields ->> 'notes'), ''); END IF;
  IF p_fields ? 'verification' THEN r.verification := p_fields ->> 'verification'; END IF;
  IF p_fields ? 'startMonth' THEN r.start_month := ((p_fields ->> 'startMonth') || '-01')::date; END IF;
  IF p_fields ? 'endMonth' THEN r.end_month := ((p_fields ->> 'endMonth') || '-01')::date; END IF;

  BEGIN
    IF is_new THEN
      INSERT INTO eureka.bgc_entry (bgc_id, placement_id, candidate_id, recruiter_id, kind, employer, title, street, city, region,
                                    postal_code, country, start_month, end_month, verification, notes)
      VALUES (b.id, b.placement_id, b.candidate_id, b.recruiter_id, r.kind, r.employer, r.title, r.street, r.city, r.region,
              r.postal_code, r.country, r.start_month, r.end_month, r.verification, r.notes)
      RETURNING * INTO r;
      ch := ARRAY['created']::text[];
    ELSE
      IF r.employer IS DISTINCT FROM e.employer THEN ch := ch || 'employer'::text; END IF;
      IF r.title IS DISTINCT FROM e.title THEN ch := ch || 'title'::text; END IF;
      IF r.street IS DISTINCT FROM e.street THEN ch := ch || 'street'::text; END IF;
      IF r.city IS DISTINCT FROM e.city THEN ch := ch || 'city'::text; END IF;
      IF r.region IS DISTINCT FROM e.region THEN ch := ch || 'region'::text; END IF;
      IF r.postal_code IS DISTINCT FROM e.postal_code THEN ch := ch || 'postal_code'::text; END IF;
      IF r.country IS DISTINCT FROM e.country THEN ch := ch || 'country'::text; END IF;
      IF r.start_month IS DISTINCT FROM e.start_month THEN ch := ch || 'start_month'::text; END IF;
      IF r.end_month IS DISTINCT FROM e.end_month THEN ch := ch || 'end_month'::text; END IF;
      IF r.verification IS DISTINCT FROM e.verification THEN ch := ch || 'verification'::text; END IF;
      IF r.notes IS DISTINCT FROM e.notes THEN ch := ch || 'notes'::text; END IF;
      IF pg_catalog.cardinality(ch) > 0 THEN
        UPDATE eureka.bgc_entry x
           SET employer = r.employer, title = r.title, street = r.street, city = r.city, region = r.region,
               postal_code = r.postal_code, country = r.country, start_month = r.start_month, end_month = r.end_month,
               verification = r.verification, notes = r.notes
         WHERE x.id = e.id
        RETURNING * INTO r;
      END IF;
    END IF;
  EXCEPTION WHEN check_violation OR not_null_violation THEN
    RAISE EXCEPTION 'invalid_change' USING ERRCODE = 'check_violation';
  END;

  IF pg_catalog.cardinality(ch) > 0 THEN
    INSERT INTO eureka.bgc_event (bgc_id, placement_id, changed)
    VALUES (r.bgc_id, r.placement_id, ARRAY[r.kind || '_history']);
  END IF;

  RETURN QUERY SELECT r.id, r.kind, r.version, is_new, ch;
END $function$;

CREATE FUNCTION authz.delete_bgc_entry(p_placement uuid, p_entry uuid, p_expected_version integer)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  actor uuid := authz.current_user_id();
  pl record; e record;
BEGIN
  SELECT * INTO pl FROM eureka.placement p WHERE p.id = p_placement;
  IF NOT FOUND OR actor IS NULL OR NOT coalesce(authz.placement_covered(p_placement, 'document:read'), false) THEN
    RAISE EXCEPTION 'placement_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT coalesce(authz.placement_covered(p_placement, 'bgc:update'), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF coalesce(pl.status = 'backout', true) THEN
    RAISE EXCEPTION 'placement_closed' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO e FROM eureka.bgc_entry x WHERE x.id = p_entry AND x.placement_id = p_placement FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'entry_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF p_expected_version IS NOT NULL AND p_expected_version IS DISTINCT FROM e.version THEN
    RAISE EXCEPTION 'version_mismatch' USING ERRCODE = 'serialization_failure';
  END IF;
  DELETE FROM eureka.bgc_entry x WHERE x.id = e.id;
  INSERT INTO eureka.bgc_event (bgc_id, placement_id, changed) VALUES (e.bgc_id, e.placement_id, ARRAY[e.kind || '_history']);
  RETURN e.kind;
END $function$;

REVOKE ALL ON FUNCTION authz.save_bgc_entry(uuid, uuid, text, jsonb, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.delete_bgc_entry(uuid, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.save_bgc_entry(uuid, uuid, text, jsonb, integer) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.delete_bgc_entry(uuid, uuid, integer) TO eureka_app;

RESET ROLE;
