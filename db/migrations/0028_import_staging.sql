-- Sheet migration: import staging, review queue and commit ledger (design B9,
-- docs/import.md).
--
-- Nothing here writes live tables. The import CLI connects as eureka_import,
-- which can only touch these staging tables and read reference lists. To load
-- a row it switches (SET LOCAL ROLE) to eureka_app and sets eureka.user_id to
-- the sheet row's owner, so every live write passes exactly the API's RLS
-- policies, BEFORE INSERT guards and definer functions (rules 4 and 6). It
-- never runs as a definer and never gets BYPASSRLS.
--
-- Least privilege (rule 7):
--   * eureka_import is NOLOGIN; operations enable LOGIN only for the
--     migration window (docs/import.md) and disable it afterwards.
--   * eureka_app and eureka_worker have no access to staging data.
--   * A batch is loaded only after sign-off by a second person: an active
--     user holding access:manage (org_admin) who did not stage it, recorded by
--     authz.import_approve_batch. The commit ledger refuses rows of a batch
--     that is not approved, and any review decision withdraws the approval.
-- Every IF is NULL-safe (rule 1); every function pins search_path and is
-- executable only by the role that needs it (rule 2).
SET search_path = eureka, public;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eureka_import') THEN
    CREATE ROLE eureka_import NOLOGIN;
  END IF;
END $$;
-- Acts for a row's owner through the API role's policies; gains none of its
-- privileges by default (same shape as the worker grant in 0001).
GRANT eureka_app TO eureka_import WITH INHERIT FALSE, SET TRUE;
GRANT USAGE ON SCHEMA eureka, authz TO eureka_import;

SET ROLE eureka_owner;

CREATE TABLE eureka.import_batch (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- SHA-256 of the input files and mapping: re-staging the same input reuses the batch.
  source_digest   text NOT NULL UNIQUE CHECK (source_digest ~ '^[0-9a-f]{64}$'),
  files           jsonb NOT NULL CHECK (jsonb_typeof(files) = 'object'),
  operator_id     uuid NOT NULL REFERENCES eureka.app_user(id),
  status          text NOT NULL DEFAULT 'staged' CHECK (status IN ('staged', 'approved', 'committed')),
  approved_by     uuid REFERENCES eureka.app_user(id),
  approved_at     timestamptz,
  committed_at    timestamptz,
  purged_at       timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT import_batch_approval CHECK ((status = 'staged') = (approved_by IS NULL AND approved_at IS NULL)),
  CONSTRAINT import_batch_second_person CHECK (approved_by IS NULL OR approved_by <> operator_id)
);

CREATE TABLE eureka.import_row (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id         uuid NOT NULL REFERENCES eureka.import_batch(id),
  sheet            text NOT NULL CHECK (sheet IN ('sales', 'interviews', 'placements')),
  row_no           integer NOT NULL CHECK (row_no >= 1),
  -- SHA-256 of the sheet name and the raw cells: stable across re-exports.
  row_key          text NOT NULL CHECK (row_key ~ '^[0-9a-f]{64}$'),
  raw              jsonb,          -- NULL after purge
  norm             jsonb,          -- NULL after purge
  status_key       text,           -- mapped status (for the reconciliation report)
  person_key       text,           -- row_key of the sales row this row belongs to
  state            text NOT NULL CHECK (state IN ('clean', 'review', 'rejected', 'skipped', 'held', 'committed')),
  reasons          text[] NOT NULL DEFAULT '{}',
  commit_error     text CHECK (char_length(commit_error) <= 200),
  committed_entity uuid,
  UNIQUE (batch_id, sheet, row_no),
  CONSTRAINT import_row_committed CHECK ((state = 'committed') = (committed_entity IS NOT NULL))
);
CREATE INDEX import_row_key ON eureka.import_row (sheet, row_key);

-- Reviewer decisions, keyed by the source row so they survive re-staging.
CREATE TABLE eureka.import_decision (
  sheet           text NOT NULL CHECK (sheet IN ('sales', 'interviews', 'placements')),
  row_key         text NOT NULL CHECK (row_key ~ '^[0-9a-f]{64}$'),
  action          text NOT NULL CHECK (action IN ('approve', 'reject', 'link')),
  link_row_key    text CHECK (link_row_key ~ '^[0-9a-f]{64}$'),
  decided_by      uuid NOT NULL REFERENCES eureka.app_user(id),
  decided_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sheet, row_key),
  CONSTRAINT import_decision_link CHECK ((action = 'link') = (link_row_key IS NOT NULL))
);

-- Commit ledger: one row per loaded source row (or synthesized submission),
-- so a re-run never loads the same row twice.
CREATE TABLE eureka.import_link (
  sheet        text NOT NULL CHECK (sheet IN ('sales', 'interviews', 'placements', 'submission')),
  row_key      text NOT NULL CHECK (row_key ~ '^[0-9a-f]{64}$'),
  entity_type  text NOT NULL CHECK (entity_type IN ('candidate', 'interview', 'placement', 'submission')),
  entity_id    uuid NOT NULL,
  -- The user the load acted as (later activity on a submission acts as its submitter).
  owner_id     uuid NOT NULL REFERENCES eureka.app_user(id),
  batch_id     uuid NOT NULL REFERENCES eureka.import_batch(id),
  committed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sheet, row_key)
);

-- Identity ledger for cross-batch matching. Keys are SHA-256 hashes of the
-- normalized email, phone or name + DOB, never the values themselves.
CREATE TABLE eureka.import_identity (
  identity_hash text PRIMARY KEY CHECK (identity_hash ~ '^[0-9a-f]{64}$'),
  candidate_id  uuid NOT NULL REFERENCES eureka.candidate(id),
  owner_id      uuid NOT NULL REFERENCES eureka.app_user(id),
  batch_id      uuid NOT NULL REFERENCES eureka.import_batch(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX import_identity_candidate ON eureka.import_identity (candidate_id);

-- ---------- guards (rule 4: server-managed columns) ----------
CREATE FUNCTION eureka.import_batch_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'staged' OR NEW.approved_by IS NOT NULL OR NEW.approved_at IS NOT NULL
       OR NEW.committed_at IS NOT NULL OR NEW.purged_at IS NOT NULL THEN
      RAISE EXCEPTION 'server_managed_field' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM eureka.app_user u WHERE u.id = NEW.operator_id AND u.status = 'active') THEN
      RAISE EXCEPTION 'operator_not_active' USING ERRCODE = 'check_violation';
    END IF;
    NEW.created_at := pg_catalog.now();
    RETURN NEW;
  END IF;

  IF (NEW.id, NEW.source_digest, NEW.files, NEW.operator_id, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.source_digest, OLD.files, OLD.operator_id, OLD.created_at) THEN
    RAISE EXCEPTION 'column is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.purged_at IS DISTINCT FROM OLD.purged_at THEN
    IF OLD.purged_at IS NOT NULL OR NEW.purged_at IS NULL THEN
      RAISE EXCEPTION 'column is immutable' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.purged_at := pg_catalog.now();
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status IS NOT DISTINCT FROM 'approved' AND OLD.status = 'staged' THEN
      -- Only authz.import_approve_batch (owned by authz_definer) signs off.
      IF current_user IS DISTINCT FROM 'authz_definer' THEN
        RAISE EXCEPTION 'server_managed_field' USING ERRCODE = 'insufficient_privilege';
      END IF;
      NEW.approved_at := pg_catalog.now();
    ELSIF NEW.status = 'committed' AND OLD.status = 'approved' THEN
      NEW.committed_at := pg_catalog.now();
    ELSIF NEW.status = 'staged' THEN
      -- Withdrawing an approval (a review decision changed the batch).
      NEW.approved_by := NULL;
      NEW.approved_at := NULL;
    ELSE
      RAISE EXCEPTION 'invalid_transition' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF (NEW.approved_by, NEW.approved_at, NEW.committed_at)
        IS DISTINCT FROM (OLD.approved_by, OLD.approved_at, OLD.committed_at) THEN
    RAISE EXCEPTION 'server_managed_field' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER import_batch_guard BEFORE INSERT OR UPDATE ON eureka.import_batch
  FOR EACH ROW EXECUTE FUNCTION eureka.import_batch_guard();

-- While a batch is approved, its rows may only be marked loaded (or carry a
-- commit error); anything else must withdraw the approval first.
CREATE FUNCTION eureka.import_row_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE b text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'import rows are not deleted; purge clears their data' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT ib.status INTO b FROM eureka.import_batch ib WHERE ib.id = NEW.batch_id;
  IF TG_OP = 'INSERT' THEN
    IF b IS DISTINCT FROM 'staged' OR NEW.state IS NOT DISTINCT FROM 'committed' OR NEW.committed_entity IS NOT NULL
       OR NEW.commit_error IS NOT NULL THEN
      RAISE EXCEPTION 'server_managed_field' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.batch_id, NEW.sheet, NEW.row_no, NEW.row_key)
     IS DISTINCT FROM (OLD.id, OLD.batch_id, OLD.sheet, OLD.row_no, OLD.row_key) THEN
    RAISE EXCEPTION 'column is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.state IS NOT DISTINCT FROM 'committed' AND (NEW.state, NEW.committed_entity) IS DISTINCT FROM (OLD.state, OLD.committed_entity) THEN
    RAISE EXCEPTION 'row already committed' USING ERRCODE = 'check_violation';
  END IF;
  -- Purge: raw and norm cleared, nothing else changes.
  IF NEW.raw IS NULL AND NEW.norm IS NULL
     AND (NEW.status_key, NEW.person_key, NEW.state, NEW.reasons, NEW.commit_error, NEW.committed_entity)
         IS NOT DISTINCT FROM (OLD.status_key, OLD.person_key, OLD.state, OLD.reasons, OLD.commit_error, OLD.committed_entity) THEN
    RETURN NEW;
  END IF;
  IF b IS NOT DISTINCT FROM 'approved' THEN
    IF (NEW.raw, NEW.norm, NEW.status_key, NEW.person_key, NEW.reasons)
       IS DISTINCT FROM (OLD.raw, OLD.norm, OLD.status_key, OLD.person_key, OLD.reasons)
       OR NOT coalesce((NEW.state IS NOT DISTINCT FROM OLD.state
                        AND NEW.committed_entity IS NOT DISTINCT FROM OLD.committed_entity)
                       OR (OLD.state = 'clean' AND NEW.state IS NOT DISTINCT FROM 'committed'), false) THEN
      RAISE EXCEPTION 'batch_approved' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.state IS NOT DISTINCT FROM 'committed' OR NEW.committed_entity IS DISTINCT FROM OLD.committed_entity THEN
    RAISE EXCEPTION 'batch_not_approved' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER import_row_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.import_row
  FOR EACH ROW EXECUTE FUNCTION eureka.import_row_guard();

CREATE FUNCTION eureka.import_decision_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM eureka.app_user u WHERE u.id = NEW.decided_by AND u.status = 'active') THEN
    RAISE EXCEPTION 'reviewer_not_active' USING ERRCODE = 'check_violation';
  END IF;
  NEW.decided_at := pg_catalog.now();
  -- A decision changes what a batch would load: withdraw approvals of every
  -- batch holding this source row.
  UPDATE eureka.import_batch ib SET status = 'staged'
   WHERE ib.status IN ('approved', 'committed')
     AND EXISTS (SELECT 1 FROM eureka.import_row r
                 WHERE r.batch_id = ib.id AND r.sheet = NEW.sheet AND r.row_key = NEW.row_key);
  RETURN NEW;
END $$;
CREATE TRIGGER import_decision_guard BEFORE INSERT OR UPDATE ON eureka.import_decision
  FOR EACH ROW EXECUTE FUNCTION eureka.import_decision_guard();

-- The ledger is written in the same transaction as the live rows; it refuses
-- any batch without sign-off, so nothing is loaded unapproved.
CREATE FUNCTION eureka.import_ledger_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'the import ledger is append-only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM eureka.import_batch ib WHERE ib.id = NEW.batch_id AND ib.status = 'approved') THEN
    RAISE EXCEPTION 'batch_not_approved' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_TABLE_NAME = 'import_link' THEN
    NEW.committed_at := pg_catalog.now();
  ELSE
    NEW.created_at := pg_catalog.now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER import_link_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.import_link
  FOR EACH ROW EXECUTE FUNCTION eureka.import_ledger_guard();
CREATE TRIGGER import_identity_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.import_identity
  FOR EACH ROW EXECUTE FUNCTION eureka.import_ledger_guard();

RESET ROLE;

-- ---------- RLS: staging data is visible to the import role only ----------
ALTER TABLE eureka.import_batch    ENABLE ROW LEVEL SECURITY; ALTER TABLE eureka.import_batch    FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.import_row      ENABLE ROW LEVEL SECURITY; ALTER TABLE eureka.import_row      FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.import_decision ENABLE ROW LEVEL SECURITY; ALTER TABLE eureka.import_decision FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.import_link     ENABLE ROW LEVEL SECURITY; ALTER TABLE eureka.import_link     FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.import_identity ENABLE ROW LEVEL SECURITY; ALTER TABLE eureka.import_identity FORCE ROW LEVEL SECURITY;

CREATE POLICY import_all ON eureka.import_batch    TO eureka_import USING (true) WITH CHECK (true);
CREATE POLICY import_all ON eureka.import_row      TO eureka_import USING (true) WITH CHECK (true);
CREATE POLICY import_all ON eureka.import_decision TO eureka_import USING (true) WITH CHECK (true);
CREATE POLICY import_all ON eureka.import_link     TO eureka_import USING (true) WITH CHECK (true);
CREATE POLICY import_all ON eureka.import_identity TO eureka_import USING (true) WITH CHECK (true);
-- authz.import_approve_batch and authz.import_live_match.
CREATE POLICY definer_read ON eureka.import_batch FOR SELECT TO authz_definer USING (true);
CREATE POLICY definer_approve ON eureka.import_batch FOR UPDATE TO authz_definer
  USING (status = 'staged') WITH CHECK (status = 'approved');
CREATE POLICY definer_read ON eureka.import_identity FOR SELECT TO authz_definer USING (true);

GRANT SELECT, INSERT (source_digest, files, operator_id) ON eureka.import_batch TO eureka_import;
GRANT UPDATE (status, purged_at) ON eureka.import_batch TO eureka_import;
GRANT SELECT, INSERT (batch_id, sheet, row_no, row_key, raw, norm, status_key, person_key, state, reasons)
  ON eureka.import_row TO eureka_import;
GRANT UPDATE (raw, norm, status_key, person_key, state, reasons, commit_error, committed_entity)
  ON eureka.import_row TO eureka_import;
GRANT SELECT, INSERT (sheet, row_key, action, link_row_key, decided_by) ON eureka.import_decision TO eureka_import;
GRANT UPDATE (action, link_row_key, decided_by) ON eureka.import_decision TO eureka_import;
GRANT SELECT, INSERT (sheet, row_key, entity_type, entity_id, owner_id, batch_id) ON eureka.import_link TO eureka_import;
GRANT SELECT, INSERT (identity_hash, candidate_id, owner_id, batch_id) ON eureka.import_identity TO eureka_import;
GRANT SELECT (id, status, operator_id) ON eureka.import_batch TO authz_definer;
GRANT UPDATE (status, approved_by, approved_at) ON eureka.import_batch TO authz_definer;
GRANT SELECT (candidate_id) ON eureka.import_identity TO authz_definer;

-- Reference lists resolved while staging, and staff emails to resolve row owners.
GRANT SELECT (id, name) ON eureka.technology, eureka.location, eureka.client, eureka.vendor,
  eureka.implementation_partner TO eureka_import;
GRANT SELECT (id, email, status) ON eureka.app_user TO eureka_import;

-- ---------- definer functions ----------
SET ROLE authz_definer;

-- Sign-off (design B9 step 4). Called as eureka_app with eureka.user_id set to
-- the approver: an active access:manage holder who did not stage the batch.
CREATE FUNCTION authz.import_approve_batch(p_batch uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  actor uuid := authz.current_user_id();
  b record;
BEGIN
  IF actor IS NULL OR NOT coalesce(authz.has_org('access:manage'), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT ib.id, ib.status, ib.operator_id INTO b FROM eureka.import_batch ib WHERE ib.id = p_batch FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'batch_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF b.operator_id IS NULL OR b.operator_id = actor THEN
    RAISE EXCEPTION 'second_person_required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF b.status IS DISTINCT FROM 'staged' THEN
    RAISE EXCEPTION 'invalid_transition' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE eureka.import_batch SET status = 'approved', approved_by = actor WHERE id = p_batch;
  RETURN 'approved';
END $$;

-- Does a live candidate (not created by this import) already use this email
-- or phone? Returns only a boolean (design B3 duplicate checks).
CREATE FUNCTION authz.import_live_match(p_email text, p_phone text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM eureka.candidate c JOIN eureka.person p ON p.id = c.person_id
    WHERE ((p_email IS NOT NULL AND (pg_catalog.lower(p.personal_email::text) = pg_catalog.lower(p_email)
                                     OR pg_catalog.lower(c.marketing_email::text) = pg_catalog.lower(p_email)))
           OR (p_phone IS NOT NULL AND p.phone_e164 = p_phone))
      AND NOT EXISTS (SELECT 1 FROM eureka.import_identity i WHERE i.candidate_id = c.id))
$$;

RESET ROLE;

REVOKE ALL ON FUNCTION eureka.import_batch_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION eureka.import_row_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION eureka.import_decision_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION eureka.import_ledger_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.import_approve_batch(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.import_live_match(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.import_approve_batch(uuid) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.import_live_match(text, text) TO eureka_import;
-- has_org / current_user_id are already executable by eureka_app (0004).

-- ---------- no candidate feedback emails for imported (historical) interviews ----------
-- eureka.feedback_due (0021) selects every past interview without a delivery;
-- interviews loaded from the sheets are history, not new calls. Same body as
-- 0021 plus the ledger check.
CREATE POLICY owner_feedback_skip ON eureka.import_link FOR SELECT TO eureka_owner USING (sheet = 'interviews');
SET ROLE eureka_owner;
CREATE OR REPLACE FUNCTION eureka.feedback_due() RETURNS TABLE(id uuid) LANGUAGE sql SECURITY DEFINER
SET search_path=pg_catalog,pg_temp AS $$
 SELECT i.id FROM eureka.interview i JOIN eureka.candidate c ON c.id=i.candidate_id JOIN eureka.person p ON p.id=c.person_id
 WHERE i.ends_at <= now()-interval '60 minutes'
 AND i.call_status NOT IN ('cancelled','rescheduled','no_invite') AND p.personal_email IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM eureka.feedback_delivery d WHERE d.interview_id=i.id AND d.starts_at=i.starts_at AND d.ends_at=i.ends_at AND (d.sent_at IS NOT NULL OR d.used_at IS NOT NULL))
 AND NOT EXISTS(SELECT 1 FROM eureka.import_link l WHERE l.sheet='interviews' AND l.entity_id=i.id)
 ORDER BY i.ends_at LIMIT 100
$$;
RESET ROLE;
REVOKE ALL ON FUNCTION eureka.feedback_due() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eureka.feedback_due() TO eureka_worker;
