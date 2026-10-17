-- Preferred vendor details (gap list "Preferred vendor details"; contract
-- docs/pipeline-vendors-api.md PV-9..PV-12). The catalog permissions already
-- exist (packages/shared/src/authz/catalog.ts): vendor.preferred:create
-- (recruiter own, lead own) and vendor.preferred:read (lead team, manager and
-- associate director hierarchy, CEO org).
--
--   1. eureka.preferred_vendor: a vendor a recruiter prefers to work with,
--      entered by that recruiter: vendor name (optionally linked to the vendor
--      list), the vendor's contact person, email and phone, technology,
--      clients they work with, notes. The owner is the creating user (server-set).
--   2. Visibility (RLS, "only to themselves and their superiors"): the owner,
--      plus holders of vendor.preferred:read over the owner:
--        org            every entry;
--        team           entries of the current members of the teams they lead or belong to;
--        hierarchy      entries of users below them in the reporting line and of
--                       the current members of the teams in their subtree.
--      authz.preferred_vendor_owner_ids() computes the owner set once per
--      statement (InitPlan, rule 3). Peers never see each other's entries
--      (recruiters hold no vendor.preferred:read).
--   3. Writes only through authz.preferred_vendor_create / _update / _archive
--      (definer): create needs vendor.preferred:create; update and archive
--      only by the owner, still holding vendor.preferred:create (superiors
--      read only). 404 `vendor_not_found` unless the entry is visible, 403
--      `not_permitted` otherwise, `stale` on a row-version mismatch.
-- Contact details and notes never reach audit_event or outbox_event (rule 5):
-- the API audits ids and changed field names only.
-- Every IF is NULL-safe (rule 1).
SET search_path = eureka, public;

SET ROLE eureka_owner;

CREATE TABLE eureka.preferred_vendor (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      uuid NOT NULL REFERENCES eureka.app_user(id),
  vendor_name   text NOT NULL CHECK (char_length(btrim(vendor_name)) BETWEEN 1 AND 200 AND vendor_name !~ '[[:cntrl:]]'),
  vendor_id     uuid REFERENCES eureka.vendor(id),
  contact_name  text CHECK (contact_name IS NULL OR (char_length(btrim(contact_name)) BETWEEN 1 AND 120 AND contact_name !~ '[[:cntrl:]]')),
  contact_email text CHECK (contact_email IS NULL OR (char_length(contact_email) <= 254
                            AND contact_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')),
  contact_phone text CHECK (contact_phone IS NULL OR contact_phone ~ '^\+[1-9][0-9]{7,14}$'),
  technology_id uuid REFERENCES eureka.technology(id),
  clients       text CHECK (clients IS NULL OR (char_length(clients) <= 500 AND clients !~ '[[:cntrl:]]')),
  notes         text CHECK (notes IS NULL OR (char_length(notes) <= 2000 AND notes !~ '[\x01-\x09\x0b-\x1f\x7f]')),
  archived      boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  row_version   integer NOT NULL DEFAULT 1
);
CREATE INDEX preferred_vendor_owner ON eureka.preferred_vendor (owner_id, archived);
-- One active entry per owner and vendor name.
CREATE UNIQUE INDEX preferred_vendor_owner_name ON eureka.preferred_vendor (owner_id, lower(btrim(vendor_name))) WHERE NOT archived;

CREATE FUNCTION eureka.preferred_vendor_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'preferred vendors are never truncated' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF current_user IS DISTINCT FROM 'authz_definer' THEN
    RAISE EXCEPTION 'preferred vendors are written only by the preferred vendor functions' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'preferred vendors are archived, not deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.archived := false;
    NEW.created_at := pg_catalog.now();
    NEW.updated_at := NEW.created_at;
    NEW.row_version := 1;
  ELSE
    IF NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'immutable preferred vendor field' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.updated_at := pg_catalog.now();
    NEW.row_version := OLD.row_version + 1;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER preferred_vendor_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.preferred_vendor
  FOR EACH ROW EXECUTE FUNCTION eureka.preferred_vendor_guard();
CREATE TRIGGER preferred_vendor_no_truncate BEFORE TRUNCATE ON eureka.preferred_vendor
  FOR EACH STATEMENT EXECUTE FUNCTION eureka.preferred_vendor_guard();

RESET ROLE;

-- ---------- scope helper ----------
SET ROLE authz_definer;

-- Owners whose entries the current user may read: themself (when they may
-- create entries or read others'), their reporting subtree (hierarchy), and
-- the current members of the teams vendor.preferred:read covers (team and
-- hierarchy; never coached teams). Org holders are handled by has_org in the
-- policy. Empty for anyone without either permission.
CREATE FUNCTION authz.preferred_vendor_owner_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH me AS (SELECT authz.current_user_id() AS id),
  teams AS (SELECT pg_catalog.unnest(authz.owned_team_ids('vendor.preferred:read')) AS team_id)
  SELECT coalesce(pg_catalog.array_agg(DISTINCT x), '{}') FROM (
    SELECT me.id AS x FROM me
     WHERE me.id IS NOT NULL
       AND (authz.has_perm('vendor.preferred:create') OR authz.has_perm('vendor.preferred:read'))
    UNION ALL
    SELECT pg_catalog.unnest(authz.recruiter_ids('vendor.preferred:read'))
    UNION ALL
    SELECT tm.user_id FROM eureka.team_member tm JOIN teams t ON t.team_id = tm.team_id
     WHERE tm.valid @> pg_catalog.now()
    UNION ALL
    SELECT tt.lead_id FROM eureka.team tt JOIN teams t ON t.team_id = tt.id WHERE tt.lead_id IS NOT NULL
  ) s WHERE x IS NOT NULL
$$;

RESET ROLE;

SET ROLE eureka_owner;
ALTER TABLE eureka.preferred_vendor ENABLE ROW LEVEL SECURITY;
ALTER TABLE eureka.preferred_vendor FORCE ROW LEVEL SECURITY;
CREATE POLICY preferred_vendor_read ON eureka.preferred_vendor FOR SELECT TO eureka_app USING (
  (SELECT authz.has_org('vendor.preferred:read'))
  OR owner_id = ANY ((SELECT authz.preferred_vendor_owner_ids())::uuid[]));
CREATE POLICY definer_read   ON eureka.preferred_vendor FOR SELECT TO authz_definer USING (true);
CREATE POLICY definer_insert ON eureka.preferred_vendor FOR INSERT TO authz_definer WITH CHECK (true);
CREATE POLICY definer_update ON eureka.preferred_vendor FOR UPDATE TO authz_definer USING (true) WITH CHECK (true);
RESET ROLE;

REVOKE ALL ON eureka.preferred_vendor FROM PUBLIC;
GRANT SELECT ON eureka.preferred_vendor TO eureka_app;
GRANT SELECT, INSERT, UPDATE ON eureka.preferred_vendor TO authz_definer;
REVOKE ALL ON FUNCTION eureka.preferred_vendor_guard() FROM PUBLIC;

-- ---------- definer functions ----------
SET ROLE authz_definer;

CREATE FUNCTION authz.preferred_vendor_check(
  p_name text, p_vendor uuid, p_contact_name text, p_email text, p_phone text, p_technology uuid,
  p_clients text, p_notes text)
RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_name IS NULL OR char_length(btrim(p_name)) NOT BETWEEN 1 AND 200 OR p_name ~ '[[:cntrl:]]'
     OR (p_contact_name IS NOT NULL AND (char_length(btrim(p_contact_name)) NOT BETWEEN 1 AND 120 OR p_contact_name ~ '[[:cntrl:]]'))
     OR (p_email IS NOT NULL AND (char_length(p_email) > 254 OR p_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'))
     OR (p_phone IS NOT NULL AND p_phone !~ '^\+[1-9][0-9]{7,14}$')
     OR (p_clients IS NOT NULL AND (char_length(p_clients) > 500 OR p_clients ~ '[[:cntrl:]]'))
     OR (p_notes IS NOT NULL AND (char_length(p_notes) > 2000 OR p_notes ~ '[\x01-\x09\x0b-\x1f\x7f]')) THEN
    RAISE EXCEPTION 'invalid_vendor' USING ERRCODE = 'check_violation';
  END IF;
  IF p_vendor IS NOT NULL AND NOT EXISTS (SELECT 1 FROM eureka.vendor v WHERE v.id = p_vendor) THEN
    RAISE EXCEPTION 'unknown_vendor' USING ERRCODE = 'check_violation';
  END IF;
  IF p_technology IS NOT NULL AND NOT EXISTS (SELECT 1 FROM eureka.technology t WHERE t.id = p_technology) THEN
    RAISE EXCEPTION 'unknown_technology' USING ERRCODE = 'check_violation';
  END IF;
END $$;

CREATE FUNCTION authz.preferred_vendor_create(
  p_name text, p_vendor uuid, p_contact_name text, p_email text, p_phone text, p_technology uuid,
  p_clients text, p_notes text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  IF authz.current_user_id() IS NULL OR NOT authz.has_perm('vendor.preferred:create') THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM authz.preferred_vendor_check(p_name, p_vendor, p_contact_name, p_email, p_phone, p_technology, p_clients, p_notes);
  IF (SELECT count(*) FROM eureka.preferred_vendor pv WHERE pv.owner_id = authz.current_user_id() AND NOT pv.archived) >= 500 THEN
    RAISE EXCEPTION 'limit_reached' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO eureka.preferred_vendor (owner_id, vendor_name, vendor_id, contact_name, contact_email, contact_phone,
                                       technology_id, clients, notes)
  VALUES (authz.current_user_id(), btrim(p_name), p_vendor, nullif(btrim(p_contact_name), ''), p_email, p_phone,
          p_technology, p_clients, p_notes)
  RETURNING id INTO v_id;
  RETURN v_id;
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'vendor_exists' USING ERRCODE = 'unique_violation';
END $$;

-- Read-before-write for update/archive: visible (404) and owned (403).
CREATE FUNCTION authz.preferred_vendor_for_update(p_id uuid) RETURNS eureka.preferred_vendor
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE r eureka.preferred_vendor;
BEGIN
  SELECT * INTO r FROM eureka.preferred_vendor WHERE id = p_id FOR UPDATE;
  IF r.id IS NULL OR authz.current_user_id() IS NULL
     OR NOT (authz.has_org('vendor.preferred:read') OR r.owner_id = ANY (authz.preferred_vendor_owner_ids())) THEN
    RAISE EXCEPTION 'vendor_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF r.owner_id IS DISTINCT FROM authz.current_user_id() OR NOT authz.has_perm('vendor.preferred:create') THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN r;
END $$;

CREATE FUNCTION authz.preferred_vendor_update(
  p_id uuid, p_row_version integer, p_name text, p_vendor uuid, p_contact_name text, p_email text, p_phone text,
  p_technology uuid, p_clients text, p_notes text)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE r eureka.preferred_vendor; v integer;
BEGIN
  r := authz.preferred_vendor_for_update(p_id);
  IF r.archived THEN
    RAISE EXCEPTION 'vendor_archived' USING ERRCODE = 'check_violation';
  END IF;
  IF p_row_version IS NULL OR p_row_version IS DISTINCT FROM r.row_version THEN
    RAISE EXCEPTION 'stale' USING ERRCODE = 'serialization_failure';
  END IF;
  PERFORM authz.preferred_vendor_check(p_name, p_vendor, p_contact_name, p_email, p_phone, p_technology, p_clients, p_notes);
  UPDATE eureka.preferred_vendor
     SET vendor_name = btrim(p_name), vendor_id = p_vendor, contact_name = nullif(btrim(p_contact_name), ''),
         contact_email = p_email, contact_phone = p_phone, technology_id = p_technology, clients = p_clients, notes = p_notes
   WHERE id = p_id
  RETURNING row_version INTO v;
  RETURN v;
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'vendor_exists' USING ERRCODE = 'unique_violation';
END $$;

CREATE FUNCTION authz.preferred_vendor_archive(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE r eureka.preferred_vendor;
BEGIN
  r := authz.preferred_vendor_for_update(p_id);
  IF NOT r.archived THEN
    UPDATE eureka.preferred_vendor SET archived = true WHERE id = p_id;
  END IF;
END $$;

RESET ROLE;

REVOKE ALL ON FUNCTION authz.preferred_vendor_owner_ids() FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.preferred_vendor_check(text, uuid, text, text, text, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.preferred_vendor_create(text, uuid, text, text, text, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.preferred_vendor_for_update(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.preferred_vendor_update(uuid, integer, text, uuid, text, text, text, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.preferred_vendor_archive(uuid) FROM PUBLIC;
-- The read policy evaluates the owner set as the querying role.
GRANT EXECUTE ON FUNCTION authz.preferred_vendor_owner_ids() TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.preferred_vendor_create(text, uuid, text, text, text, uuid, text, text) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.preferred_vendor_update(uuid, integer, text, uuid, text, text, text, uuid, text, text) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.preferred_vendor_archive(uuid) TO eureka_app;
