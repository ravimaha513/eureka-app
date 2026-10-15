-- Contracts (interview-alerts package; contract docs/alerts-calendar-birthdays.md CT-1..CT-6).
--   1. authz.document_type gains msa, purchase_order and sow (internal): the
--      closure documents, filed on the placement through the 0043 pipeline
--      (unchanged), readable and uploadable under the placement document rules.
--   2. eureka.contract: the commercial record of a closure on a placement
--      (kind, title, reference, dates, notes). Written only by
--      authz.create_contract: the placement must be visible under the
--      placement read rule (else 404) and the caller must hold placement:update
--      over its actor snapshot or invoice:update at org scope (Accounts), else
--      403. Readable wherever the placement is (EXISTS by primary key under
--      the caller's placement policy, rule 3). Notes are free text and never
--      reach audit or outbox rows (rule 5). Rows are append-only in this version.
--   3. authz.create_contract records `contract.created` in the outbox (ids,
--      the kind code and a count only); recipients HR, Associate HR and
--      Accounts (resolver replaced in 0089).
-- Every IF is NULL-safe (rule 1); functions pin search_path and are not
-- executable by PUBLIC (rule 2).
SET search_path = eureka, public;

-- ---------- 1. document types ----------
SET ROLE authz_definer;
INSERT INTO authz.document_type (key, label, classification) VALUES
  ('msa', 'Master services agreement (MSA)', 'internal'),
  ('purchase_order', 'Purchase order (PO)', 'internal'),
  ('sow', 'Statement of work (SOW)', 'internal');
RESET ROLE;

-- ---------- 2. contract ----------
SET ROLE eureka_owner;
CREATE TABLE eureka.contract (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  placement_id uuid NOT NULL REFERENCES eureka.placement(id),
  client_id    uuid NOT NULL REFERENCES eureka.client(id),       -- snapshot from the placement
  kind         text NOT NULL CHECK (kind IN ('msa', 'po', 'sow', 'other')),
  title        text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120 AND title !~ '[[:cntrl:]]'),
  reference    text CHECK (char_length(reference) BETWEEN 1 AND 80 AND reference !~ '[[:cntrl:]]'),
  starts_on    date,
  ends_on      date,
  notes        text CHECK (char_length(notes) BETWEEN 1 AND 2000 AND notes !~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]'),
  created_by   uuid NOT NULL REFERENCES eureka.app_user(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contract_dates CHECK (starts_on IS NULL OR ends_on IS NULL OR ends_on >= starts_on)
);
CREATE INDEX contract_placement ON eureka.contract (placement_id, created_at, id);

-- Rows are written only inside authz.create_contract (owner authz_definer);
-- created_by / created_at are server-set; nothing changes or goes afterwards.
CREATE FUNCTION eureka.contract_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' AND current_user = 'authz_definer' THEN
    NEW.created_by := authz.current_user_id();
    NEW.created_at := pg_catalog.now();
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'contracts are written only through authz.create_contract'
    USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER contract_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.contract
  FOR EACH ROW EXECUTE FUNCTION eureka.contract_guard();
CREATE TRIGGER contract_no_truncate BEFORE TRUNCATE ON eureka.contract
  FOR EACH STATEMENT EXECUTE FUNCTION eureka.contract_guard();

ALTER TABLE eureka.contract ENABLE ROW LEVEL SECURITY;
ALTER TABLE eureka.contract FORCE ROW LEVEL SECURITY;
RESET ROLE;

REVOKE ALL ON FUNCTION eureka.contract_guard() FROM PUBLIC;
REVOKE ALL ON eureka.contract FROM PUBLIC;

-- App: read wherever the placement is readable (the sub-select runs under the caller's placement policy).
GRANT SELECT ON eureka.contract TO eureka_app;
CREATE POLICY contract_read ON eureka.contract FOR SELECT TO eureka_app
  USING (EXISTS (SELECT 1 FROM eureka.placement p WHERE p.id = contract.placement_id));
-- Definer: writes inside authz.create_contract only.
GRANT SELECT, INSERT (placement_id, client_id, kind, title, reference, starts_on, ends_on, notes, created_by) ON eureka.contract TO authz_definer;
CREATE POLICY definer_read   ON eureka.contract FOR SELECT TO authz_definer USING (true);
CREATE POLICY definer_insert ON eureka.contract FOR INSERT TO authz_definer WITH CHECK (true);

-- ---------- 3. create_contract ----------
SET ROLE authz_definer;
CREATE FUNCTION authz.create_contract(
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
  IF coalesce(p.status, '') IN ('backout', 'bgc_failed') THEN
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
