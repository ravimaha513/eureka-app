-- Sheet import hardening (review of 0028, docs/import.md).
--
--  1. eureka_import no longer becomes eureka_app. Each person loads through
--     authz.import_load_person (SECURITY DEFINER, executable by eureka_import
--     only). It reads the normalized rows of an approved, unchanged batch,
--     checks the owner is active and holds a Sales role, sets the acting user
--     only for its own duration (cleared on entry and on return), and runs the same RLS
--     checks (policies below mirror the API's), guards, transition functions
--     and audit events as the API, tagged source:'import' with the operator.
--  2. Who stages and who approves are authenticated: a batch is opened only
--     with a one-time ticket created by a signed-in access:manage user
--     (authz.import_create_ticket via the API), and review decisions and
--     approval are API calls (authz.import_decide, authz.import_approve_batch).
--     Approval stores a digest of the rows; loading and the ledger re-verify
--     it; approvals expire (import_config.approval_days).
--  3. Decisions newer than the approval, rejections and unapplied links are
--     never loaded; approval needs a re-analysis after the last decision; the
--     ledger locks the batch row FOR SHARE.
--  4. An approval records the reasons it accepted; analysis clears only those.
--  5. Natural keys (interview: candidate, client, job title, round, start
--     date; placement: submission, tentative start) make an edited sheet row
--     update the existing record instead of creating a second one.
--  6. Decisions never reopen a committed batch; any batch can be purged, and
--     batches older than import_config.purge_days are purged by `purge --expired`.
--  7. feedback_due skips only interviews that had already ended when imported.
-- Rules 1-7 of docs/HANDOFF.md apply: NULL-safe IFs, pinned search_path,
-- EXECUTE to exactly one role, no PII in audit.
SET search_path = eureka, public;

-- ---------- 1. no acting as the API role ----------
-- Every grant of the membership, whoever granted it (PostgreSQL 16 keeps one
-- per grantor). On RDS the migration user granted the only one.
DO $$
DECLARE g record;
BEGIN
  FOR g IN SELECT gr.rolname AS grantor FROM pg_auth_members m
             JOIN pg_roles r ON r.oid = m.member JOIN pg_roles a ON a.oid = m.roleid JOIN pg_roles gr ON gr.oid = m.grantor
            WHERE r.rolname = 'eureka_import' AND a.rolname = 'eureka_app' LOOP
    IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) OR pg_has_role(current_user, g.grantor, 'USAGE') THEN
      EXECUTE format('REVOKE eureka_app FROM eureka_import GRANTED BY %I CASCADE', g.grantor);
    ELSE
      RAISE WARNING 'eureka_import is still a member of eureka_app (granted by %); revoke it as that role', g.grantor;
    END IF;
  END LOOP;
END $$;

-- The acting user can come from an import session only inside
-- authz.import_load_person (which sets both values for its own duration).
SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.current_user_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE
    WHEN session_user::text = 'eureka_import'
         AND pg_catalog.current_setting('eureka.import_load', true) IS DISTINCT FROM 'on' THEN NULL
    ELSE nullif(pg_catalog.current_setting('eureka.user_id', true), '')::uuid
  END
$$;
RESET ROLE;

-- ---------- configuration, tickets, natural keys ----------
SET ROLE eureka_owner;

CREATE TABLE eureka.import_config (
  id             boolean PRIMARY KEY DEFAULT true CHECK (id),
  approval_days  integer NOT NULL DEFAULT 7 CHECK (approval_days BETWEEN 1 AND 30),
  purge_days     integer NOT NULL DEFAULT 30 CHECK (purge_days BETWEEN 1 AND 365),
  ticket_hours   integer NOT NULL DEFAULT 24 CHECK (ticket_hours BETWEEN 1 AND 168)
);
INSERT INTO eureka.import_config DEFAULT VALUES;

CREATE TABLE eureka.import_ticket (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash  text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_by  uuid NOT NULL REFERENCES eureka.app_user(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  batch_id    uuid REFERENCES eureka.import_batch(id),
  CHECK ((used_at IS NULL) = (batch_id IS NULL))
);

CREATE TABLE eureka.import_natural_key (
  kind       text NOT NULL CHECK (kind IN ('interview', 'placement')),
  key_hash   text NOT NULL CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  entity_id  uuid NOT NULL,
  batch_id   uuid NOT NULL REFERENCES eureka.import_batch(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, key_hash)
);

ALTER TABLE eureka.import_batch
  ADD COLUMN approved_digest text CHECK (approved_digest ~ '^[0-9a-f]{64}$'),
  ADD COLUMN analysed_at timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT import_batch_digest CHECK ((status = 'staged') = (approved_digest IS NULL));
-- A committed batch is final; the same files can open a new batch (the ledger skips loaded rows).
ALTER TABLE eureka.import_batch DROP CONSTRAINT import_batch_source_digest_key;
CREATE UNIQUE INDEX import_batch_open_digest ON eureka.import_batch (source_digest) WHERE status <> 'committed';

ALTER TABLE eureka.import_decision
  ADD COLUMN approved_reasons text[],
  ADD CONSTRAINT import_decision_reasons CHECK ((action = 'approve') = (approved_reasons IS NOT NULL));

CREATE INDEX import_row_batch_state ON eureka.import_row (batch_id, state);
CREATE INDEX import_row_batch_person ON eureka.import_row (batch_id, person_key);
CREATE INDEX import_link_entity ON eureka.import_link (entity_id);
CREATE INDEX import_batch_created ON eureka.import_batch (created_at);

-- ---------- guards ----------
CREATE OR REPLACE FUNCTION eureka.import_batch_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Only authz.import_open_batch opens a batch (its operator comes from a ticket).
    IF current_user IS DISTINCT FROM 'authz_definer' OR NEW.status IS DISTINCT FROM 'staged'
       OR NEW.approved_by IS NOT NULL OR NEW.approved_at IS NOT NULL OR NEW.approved_digest IS NOT NULL
       OR NEW.committed_at IS NOT NULL OR NEW.purged_at IS NOT NULL THEN
      RAISE EXCEPTION 'server_managed_field' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM eureka.app_user u WHERE u.id = NEW.operator_id AND u.status = 'active') THEN
      RAISE EXCEPTION 'operator_not_active' USING ERRCODE = 'check_violation';
    END IF;
    NEW.created_at := pg_catalog.now();
    NEW.analysed_at := pg_catalog.now();
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
  IF NEW.analysed_at IS DISTINCT FROM OLD.analysed_at THEN
    IF OLD.status IS DISTINCT FROM 'staged' THEN
      RAISE EXCEPTION 'batch_not_staged' USING ERRCODE = 'check_violation';
    END IF;
    NEW.analysed_at := pg_catalog.clock_timestamp();
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF current_user IS DISTINCT FROM 'authz_definer' THEN
      RAISE EXCEPTION 'server_managed_field' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.status IS NOT DISTINCT FROM 'approved' AND OLD.status = 'staged' THEN
      NEW.approved_at := pg_catalog.now();
    ELSIF NEW.status IS NOT DISTINCT FROM 'committed' AND OLD.status = 'approved' THEN
      NEW.committed_at := pg_catalog.now();
    ELSIF NEW.status IS NOT DISTINCT FROM 'staged' AND OLD.status = 'approved' THEN
      NEW.approved_by := NULL;
      NEW.approved_at := NULL;
      NEW.approved_digest := NULL;
    ELSE
      RAISE EXCEPTION 'invalid_transition' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF (NEW.approved_by, NEW.approved_at, NEW.approved_digest, NEW.committed_at)
        IS DISTINCT FROM (OLD.approved_by, OLD.approved_at, OLD.approved_digest, OLD.committed_at) THEN
    RAISE EXCEPTION 'server_managed_field' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

-- The import role writes rows only while a batch is staged (the analysis
-- path); only authz.import_load_person marks rows loaded. A commit error may
-- be noted at any time, and purge (raw and norm cleared) is always allowed.
CREATE OR REPLACE FUNCTION eureka.import_row_guard() RETURNS trigger
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
  -- Purge: raw and norm cleared, nothing else changes.
  IF NEW.raw IS NULL AND NEW.norm IS NULL
     AND (NEW.status_key, NEW.person_key, NEW.state, NEW.reasons, NEW.commit_error, NEW.committed_entity)
         IS NOT DISTINCT FROM (OLD.status_key, OLD.person_key, OLD.state, OLD.reasons, OLD.commit_error, OLD.committed_entity) THEN
    RETURN NEW;
  END IF;
  -- A commit error note only.
  IF (NEW.raw, NEW.norm, NEW.status_key, NEW.person_key, NEW.state, NEW.reasons, NEW.committed_entity)
     IS NOT DISTINCT FROM (OLD.raw, OLD.norm, OLD.status_key, OLD.person_key, OLD.state, OLD.reasons, OLD.committed_entity) THEN
    RETURN NEW;
  END IF;
  IF OLD.state IS NOT DISTINCT FROM 'committed' THEN
    RAISE EXCEPTION 'row already committed' USING ERRCODE = 'check_violation';
  END IF;
  IF current_user = 'authz_definer' THEN
    IF (NEW.raw, NEW.norm, NEW.status_key, NEW.person_key, NEW.reasons)
       IS DISTINCT FROM (OLD.raw, OLD.norm, OLD.status_key, OLD.person_key, OLD.reasons)
       OR NOT coalesce(OLD.state = 'clean' AND NEW.state = 'committed' AND NEW.committed_entity IS NOT NULL, false)
       OR b IS DISTINCT FROM 'approved' THEN
      RAISE EXCEPTION 'server_managed_field' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.state IS NOT DISTINCT FROM 'committed' OR NEW.committed_entity IS DISTINCT FROM OLD.committed_entity THEN
    RAISE EXCEPTION 'server_managed_field' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF b IS DISTINCT FROM 'staged' THEN
    RAISE EXCEPTION 'batch_not_staged' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- Decisions come only from authz.import_decide (an API call). They withdraw
-- the approval of an approved batch holding the row; a committed batch stays
-- committed (its open rows load through a new batch).
CREATE OR REPLACE FUNCTION eureka.import_decision_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF current_user IS DISTINCT FROM 'authz_definer' THEN
    RAISE EXCEPTION 'server_managed_field' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM eureka.app_user u WHERE u.id = NEW.decided_by AND u.status = 'active') THEN
    RAISE EXCEPTION 'reviewer_not_active' USING ERRCODE = 'check_violation';
  END IF;
  NEW.decided_at := pg_catalog.clock_timestamp();
  UPDATE eureka.import_batch ib SET status = 'staged'
   WHERE ib.status = 'approved'
     AND EXISTS (SELECT 1 FROM eureka.import_row r
                 WHERE r.batch_id = ib.id AND r.sheet = NEW.sheet AND r.row_key = NEW.row_key);
  RETURN NEW;
END $$;

-- Ledger writes: batch approved, approval not expired, rows unchanged since
-- approval; the batch row is locked FOR SHARE so it cannot change underneath.
CREATE OR REPLACE FUNCTION eureka.import_ledger_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE b record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'the import ledger is append-only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT ib.status, ib.approved_at, ib.approved_digest INTO b
    FROM eureka.import_batch ib WHERE ib.id = NEW.batch_id FOR SHARE;
  IF NOT FOUND OR b.status IS DISTINCT FROM 'approved'
     OR NOT coalesce(b.approved_at + pg_catalog.make_interval(days => (SELECT c.approval_days FROM eureka.import_config c)) > pg_catalog.now(), false) THEN
    RAISE EXCEPTION 'batch_not_approved' USING ERRCODE = 'check_violation';
  END IF;
  -- The digest is verified once per transaction and batch.
  IF pg_catalog.current_setting('eureka.import_verified', true)
     IS DISTINCT FROM NEW.batch_id::text || ':' || pg_catalog.txid_current()::text THEN
    IF authz.import_batch_digest(NEW.batch_id) IS DISTINCT FROM b.approved_digest THEN
      RAISE EXCEPTION 'batch_changed' USING ERRCODE = 'check_violation';
    END IF;
    PERFORM pg_catalog.set_config('eureka.import_verified', NEW.batch_id::text || ':' || pg_catalog.txid_current()::text, true);
  END IF;
  IF TG_TABLE_NAME = 'import_link' THEN
    NEW.committed_at := pg_catalog.now();
  ELSE
    NEW.created_at := pg_catalog.now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER import_natural_key_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.import_natural_key
  FOR EACH ROW EXECUTE FUNCTION eureka.import_ledger_guard();

CREATE FUNCTION eureka.import_ticket_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF current_user IS DISTINCT FROM 'authz_definer' OR TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'server_managed_field' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := pg_catalog.now();
    NEW.expires_at := pg_catalog.now() + pg_catalog.make_interval(hours => (SELECT c.ticket_hours FROM eureka.import_config c));
    IF NEW.used_at IS NOT NULL OR NEW.batch_id IS NOT NULL THEN
      RAISE EXCEPTION 'server_managed_field' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.token_hash, NEW.created_by, NEW.created_at, NEW.expires_at)
     IS DISTINCT FROM (OLD.id, OLD.token_hash, OLD.created_by, OLD.created_at, OLD.expires_at)
     OR OLD.used_at IS NOT NULL THEN
    RAISE EXCEPTION 'column is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.used_at := pg_catalog.now();
  RETURN NEW;
END $$;
CREATE TRIGGER import_ticket_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.import_ticket
  FOR EACH ROW EXECUTE FUNCTION eureka.import_ticket_guard();

-- 7. Imported interviews that had already ended are history: no feedback email.
CREATE OR REPLACE FUNCTION eureka.feedback_due() RETURNS TABLE(id uuid) LANGUAGE sql SECURITY DEFINER
SET search_path=pg_catalog,pg_temp AS $$
 SELECT i.id FROM eureka.interview i JOIN eureka.candidate c ON c.id=i.candidate_id JOIN eureka.person p ON p.id=c.person_id
 WHERE i.ends_at <= now()-interval '60 minutes'
 AND i.call_status NOT IN ('cancelled','rescheduled','no_invite') AND p.personal_email IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM eureka.feedback_delivery d WHERE d.interview_id=i.id AND d.starts_at=i.starts_at AND d.ends_at=i.ends_at AND (d.sent_at IS NOT NULL OR d.used_at IS NOT NULL))
 AND NOT EXISTS(SELECT 1 FROM eureka.import_link l WHERE l.sheet='interviews' AND l.entity_id=i.id AND i.ends_at <= l.committed_at)
 ORDER BY i.ends_at LIMIT 100
$$;

RESET ROLE;

-- ---------- RLS and privileges ----------
ALTER TABLE eureka.import_config      ENABLE ROW LEVEL SECURITY; ALTER TABLE eureka.import_config      FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.import_ticket      ENABLE ROW LEVEL SECURITY; ALTER TABLE eureka.import_ticket      FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.import_natural_key ENABLE ROW LEVEL SECURITY; ALTER TABLE eureka.import_natural_key FORCE ROW LEVEL SECURITY;

-- The import role: analysis path only.
REVOKE INSERT, UPDATE ON eureka.import_batch FROM eureka_import;
GRANT UPDATE (purged_at, analysed_at) ON eureka.import_batch TO eureka_import;
REVOKE UPDATE ON eureka.import_row FROM eureka_import;
GRANT UPDATE (raw, norm, status_key, person_key, state, reasons, commit_error) ON eureka.import_row TO eureka_import;
REVOKE INSERT, UPDATE ON eureka.import_decision FROM eureka_import;
REVOKE INSERT ON eureka.import_link, eureka.import_identity FROM eureka_import;
GRANT SELECT ON eureka.import_config, eureka.import_natural_key TO eureka_import;
CREATE POLICY import_read ON eureka.import_config      FOR SELECT TO eureka_import USING (true);
CREATE POLICY import_read ON eureka.import_natural_key FOR SELECT TO eureka_import USING (true);

-- authz_definer: the import functions below. Semantic rules live in the guards.
DROP POLICY definer_approve ON eureka.import_batch;
CREATE POLICY definer_write  ON eureka.import_batch    FOR ALL TO authz_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_all    ON eureka.import_row      FOR ALL TO authz_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_all    ON eureka.import_decision FOR ALL TO authz_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_all    ON eureka.import_link     FOR ALL TO authz_definer USING (true) WITH CHECK (true);
DROP POLICY definer_read ON eureka.import_identity;
CREATE POLICY definer_all    ON eureka.import_identity FOR ALL TO authz_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_all    ON eureka.import_natural_key FOR ALL TO authz_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_all    ON eureka.import_ticket   FOR ALL TO authz_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_read   ON eureka.import_config   FOR SELECT TO authz_definer USING (true);
-- The batch guard's owner reads the config for the ledger guard via the caller.
GRANT SELECT ON eureka.import_batch, eureka.import_row, eureka.import_decision, eureka.import_link,
  eureka.import_identity, eureka.import_natural_key, eureka.import_ticket, eureka.import_config TO authz_definer;
GRANT INSERT ON eureka.import_batch, eureka.import_decision, eureka.import_link, eureka.import_identity,
  eureka.import_natural_key, eureka.import_ticket TO authz_definer;
GRANT UPDATE (status, approved_by, approved_at, approved_digest) ON eureka.import_batch TO authz_definer;
GRANT UPDATE (state, committed_entity) ON eureka.import_row TO authz_definer;
GRANT UPDATE (action, link_row_key, approved_reasons, decided_by) ON eureka.import_decision TO authz_definer;
GRANT UPDATE (used_at, batch_id) ON eureka.import_ticket TO authz_definer;

-- Live writes by authz.import_load_person: the same checks as the API role's
-- policies (0005, 0017, 0019), for the acting owner, and only while it runs.
GRANT INSERT (id, first_name, last_name, phone_e164, personal_email) ON eureka.person TO authz_definer;
GRANT INSERT (person_id, technology_id, team_id, recruiter_id, location_id, visibility) ON eureka.candidate TO authz_definer;
GRANT UPDATE (priority, marketing_email, marketing_start_date) ON eureka.candidate TO authz_definer;
GRANT INSERT (candidate_id, job_title, client_id, vendor_id) ON eureka.submission TO authz_definer;
GRANT INSERT (submission_id, round, starts_at, ends_at) ON eureka.interview TO authz_definer;
GRANT UPDATE (starts_at, ends_at, call_status) ON eureka.interview TO authz_definer;
GRANT INSERT (actor_id, action, entity_type, entity_id, changes) ON eureka.audit_event TO authz_definer;
GRANT USAGE ON SEQUENCE eureka.audit_event_seq_seq TO authz_definer;

CREATE POLICY import_load_insert ON eureka.person FOR INSERT TO authz_definer WITH CHECK (
  pg_catalog.current_setting('eureka.import_load', true) = 'on'
  AND (SELECT authz.has_perm('candidate:create')));
CREATE POLICY import_load_insert ON eureka.candidate FOR INSERT TO authz_definer WITH CHECK (
  pg_catalog.current_setting('eureka.import_load', true) = 'on'
  AND ((SELECT authz.has_org('candidate:create'))
       OR team_id = ANY ((SELECT authz.team_ids('candidate:create'))::uuid[])
       OR (recruiter_id = ANY ((SELECT authz.recruiter_ids('candidate:create'))::uuid[])
           AND team_id = (SELECT authz.actor_team()))));
CREATE POLICY import_load_insert ON eureka.submission FOR INSERT TO authz_definer WITH CHECK (
  pg_catalog.current_setting('eureka.import_load', true) = 'on'
  AND recruiter_id = (SELECT authz.current_user_id())
  AND authz.candidate_visible(candidate_id, 'submission:create'));
CREATE POLICY import_load_insert ON eureka.interview FOR INSERT TO authz_definer WITH CHECK (
  pg_catalog.current_setting('eureka.import_load', true) = 'on'
  AND (SELECT authz.has_perm('interview:create'))
  AND EXISTS (SELECT 1 FROM eureka.submission s WHERE s.id = submission_id
              AND authz.owns('submission:update', s.recruiter_id, s.team_id, s.location_id)));
CREATE POLICY import_load_update ON eureka.interview FOR UPDATE TO authz_definer
  USING (pg_catalog.current_setting('eureka.import_load', true) = 'on'
         AND authz.owns('interview:update', recruiter_id, team_id, location_id))
  WITH CHECK (authz.owns('interview:update', recruiter_id, team_id, location_id));
CREATE POLICY import_load_audit ON eureka.audit_event FOR INSERT TO authz_definer WITH CHECK (
  pg_catalog.current_setting('eureka.import_load', true) = 'on' AND changes ->> 'source' = 'import');

-- ---------- functions ----------
SET ROLE authz_definer;

-- Approval digest: every row's id, state (loaded counts as clean), normalized
-- values and reasons. Commit-error notes and purge are not part of it.
CREATE FUNCTION authz.import_batch_digest(p_batch uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(coalesce(pg_catalog.string_agg(
    r.id::text || '|' || CASE WHEN r.state = 'committed' THEN 'clean' ELSE r.state END || '|'
      || coalesce(r.norm::text, '') || '|' || pg_catalog.array_to_string(r.reasons, ','),
    E'\n' ORDER BY r.id), ''), 'UTF8')), 'hex')
  FROM eureka.import_row r WHERE r.batch_id = p_batch
$$;

-- Must match approvable() in apps/api/src/import/analyze.ts.
CREATE FUNCTION authz.import_reason_approvable(p_reason text) RETURNS boolean
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce(p_reason IN ('probable_duplicate', 'possible_duplicate_name', 'matches_existing_candidate',
                               'name_only_match', 'name_dob_match', 'matches_imported_person')
      OR pg_catalog.split_part(p_reason, ':', 2) IN ('phone', 'personalEmail', 'marketingEmail', 'email', 'dob',
           'priority', 'marketingStartDate', 'vendor', 'implementationPartner', 'rate', 'projectCity',
           'projectState', 'statusReason'), false)
$$;

CREATE FUNCTION authz.import_require_admin() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE actor uuid := authz.current_user_id();
BEGIN
  IF actor IS NULL OR NOT coalesce(authz.has_org('access:manage'), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN actor;
END $$;

-- API: a signed-in access:manage user creates a one-time staging ticket. The
-- API generates the token and passes only its SHA-256.
CREATE FUNCTION authz.import_create_ticket(p_token_hash text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE actor uuid := authz.import_require_admin(); exp timestamptz;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_ticket' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO eureka.import_ticket (token_hash, created_by, expires_at) VALUES (p_token_hash, actor, pg_catalog.now())
  RETURNING expires_at INTO exp;
  RETURN exp;
END $$;

-- The acting user of an import call exists only while the call runs: the
-- functions below clear both settings on entry and on return (an error
-- rolls them back with the transaction). Function-level SET clauses cannot
-- be used for custom settings by a non-superuser owner.
CREATE FUNCTION authz.import_begin() RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT pg_catalog.set_config('eureka.user_id', '', true), pg_catalog.set_config('eureka.import_load', 'on', true);
$$;
CREATE FUNCTION authz.import_end() RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT pg_catalog.set_config('eureka.user_id', '', true), pg_catalog.set_config('eureka.import_load', '', true);
$$;

-- CLI (eureka_import): opens a batch with an unused, unexpired ticket. The
-- operator is the ticket's creator, still active and still an org admin.
CREATE FUNCTION authz.import_open_batch(p_ticket text, p_digest text, p_files jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE t record; new_id uuid;
BEGIN
  PERFORM authz.import_begin();
  SELECT * INTO t FROM eureka.import_ticket
   WHERE token_hash = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(coalesce(p_ticket, ''), 'UTF8')), 'hex')
   FOR UPDATE;
  IF NOT FOUND OR t.used_at IS NOT NULL OR NOT coalesce(t.expires_at > pg_catalog.now(), false) THEN
    RAISE EXCEPTION 'invalid_ticket' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM pg_catalog.set_config('eureka.user_id', t.created_by::text, true);
  IF NOT coalesce(authz.has_org('access:manage'), false) THEN
    RAISE EXCEPTION 'invalid_ticket' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO eureka.import_batch (source_digest, files, operator_id) VALUES (p_digest, p_files, t.created_by)
  RETURNING id INTO new_id;
  UPDATE eureka.import_ticket SET used_at = pg_catalog.now(), batch_id = new_id WHERE id = t.id;
  PERFORM authz.import_end();
  RETURN new_id;
END $$;

-- CLI: does a live candidate not created by an import use this sales row's
-- email or phone? Reads the staged row itself; returns a yes/no only.
DROP FUNCTION authz.import_live_match(text, text);
CREATE FUNCTION authz.import_live_match(p_row uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH r AS (
    SELECT nullif(pg_catalog.lower(x.norm ->> 'marketingEmail'), '') AS e1,
           nullif(pg_catalog.lower(x.norm ->> 'personalEmail'), '') AS e2,
           nullif(x.norm ->> 'phone', '') AS ph
    FROM eureka.import_row x JOIN eureka.import_batch b ON b.id = x.batch_id
    WHERE x.id = p_row AND x.sheet = 'sales' AND b.status = 'staged')
  SELECT EXISTS (
    SELECT 1 FROM r, eureka.candidate c JOIN eureka.person p ON p.id = c.person_id
    WHERE (pg_catalog.lower(p.personal_email::text) IN (r.e1, r.e2)
           OR pg_catalog.lower(c.marketing_email::text) IN (r.e1, r.e2)
           OR p.phone_e164 = r.ph)
      AND NOT EXISTS (SELECT 1 FROM eureka.import_identity i WHERE i.candidate_id = c.id))
$$;

-- API: a reviewer's decision on one row. approve needs every reason on the
-- row to be approvable and records them; link points at a sales row of the
-- same batch; reject drops the row. The CLI re-analyses afterwards.
CREATE FUNCTION authz.import_decide(p_batch uuid, p_sheet text, p_row_no integer, p_action text, p_link_row_no integer)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE actor uuid := authz.import_require_admin(); b record; r record; link text;
BEGIN
  SELECT ib.status, ib.purged_at INTO b FROM eureka.import_batch ib WHERE ib.id = p_batch FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'batch_not_found' USING ERRCODE = 'no_data_found'; END IF;
  IF b.status IS NOT DISTINCT FROM 'committed' OR b.purged_at IS NOT NULL THEN
    RAISE EXCEPTION 'batch_closed' USING ERRCODE = 'check_violation';
  END IF;
  SELECT x.row_key, x.state, x.reasons INTO r FROM eureka.import_row x
   WHERE x.batch_id = p_batch AND x.sheet = p_sheet AND x.row_no = p_row_no;
  IF NOT FOUND THEN RAISE EXCEPTION 'row_not_found' USING ERRCODE = 'no_data_found'; END IF;
  IF r.state IS NOT DISTINCT FROM 'committed' THEN
    RAISE EXCEPTION 'row_committed' USING ERRCODE = 'check_violation';
  END IF;
  IF p_action IS NOT DISTINCT FROM 'approve' THEN
    IF r.state IS DISTINCT FROM 'review' OR pg_catalog.cardinality(r.reasons) = 0
       OR EXISTS (SELECT 1 FROM pg_catalog.unnest(r.reasons) x WHERE NOT authz.import_reason_approvable(x)) THEN
      RAISE EXCEPTION 'not_approvable' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF p_action IS NOT DISTINCT FROM 'link' THEN
    SELECT x.row_key INTO link FROM eureka.import_row x
     WHERE x.batch_id = p_batch AND x.sheet = 'sales' AND x.row_no = p_link_row_no;
    IF link IS NULL OR (p_sheet = 'sales' AND p_link_row_no IS NOT DISTINCT FROM p_row_no) THEN
      RAISE EXCEPTION 'invalid_link' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF p_action IS DISTINCT FROM 'reject' THEN
    RAISE EXCEPTION 'invalid_action' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO eureka.import_decision (sheet, row_key, action, link_row_key, approved_reasons, decided_by)
  VALUES (p_sheet, r.row_key, p_action, link, CASE WHEN p_action = 'approve' THEN r.reasons END, actor)
  ON CONFLICT (sheet, row_key) DO UPDATE SET action = EXCLUDED.action, link_row_key = EXCLUDED.link_row_key,
    approved_reasons = EXCLUDED.approved_reasons, decided_by = EXCLUDED.decided_by;
  RETURN p_action;
END $$;

-- API: sign-off by an access:manage holder who did not stage the batch, after
-- the last decision has been analysed. Stores the digest of what was approved.
CREATE OR REPLACE FUNCTION authz.import_approve_batch(p_batch uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE actor uuid := authz.import_require_admin(); b record;
BEGIN
  SELECT ib.id, ib.status, ib.operator_id, ib.analysed_at, ib.purged_at INTO b
    FROM eureka.import_batch ib WHERE ib.id = p_batch FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'batch_not_found' USING ERRCODE = 'no_data_found'; END IF;
  IF b.operator_id IS NULL OR b.operator_id = actor THEN
    RAISE EXCEPTION 'second_person_required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF b.status IS DISTINCT FROM 'staged' OR b.purged_at IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_transition' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM eureka.import_decision d JOIN eureka.import_row r ON r.sheet = d.sheet AND r.row_key = d.row_key
             WHERE r.batch_id = p_batch AND d.decided_at > b.analysed_at) THEN
    RAISE EXCEPTION 'needs_analysis' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE eureka.import_batch SET status = 'approved', approved_by = actor, approved_digest = authz.import_batch_digest(p_batch)
   WHERE id = p_batch;
  RETURN 'approved';
END $$;

-- API: counts and review rows of a batch, without personal data.
CREATE FUNCTION authz.import_batch_summary(p_batch uuid)
RETURNS TABLE (status text, operator_id uuid, approved_by uuid, approved_at timestamptz, approval_expires_at timestamptz,
               analysed_at timestamptz, purged_at timestamptz, counts jsonb, pending_decisions integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
BEGIN
  PERFORM authz.import_require_admin();
  IF NOT EXISTS (SELECT 1 FROM eureka.import_batch ib WHERE ib.id = p_batch) THEN
    RAISE EXCEPTION 'batch_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  RETURN QUERY
  SELECT b.status, b.operator_id, b.approved_by, b.approved_at,
         b.approved_at + pg_catalog.make_interval(days => (SELECT c.approval_days FROM eureka.import_config c)),
         b.analysed_at, b.purged_at,
         coalesce((SELECT pg_catalog.jsonb_object_agg(s.sheet, s.n) FROM (
           SELECT x.sheet, pg_catalog.jsonb_object_agg(x.state, x.n) AS n FROM (
             SELECT r.sheet, r.state, count(*) AS n FROM eureka.import_row r WHERE r.batch_id = p_batch GROUP BY 1, 2) x
           GROUP BY x.sheet) s), '{}'::jsonb),
         (SELECT count(*)::integer FROM eureka.import_decision d JOIN eureka.import_row r ON r.sheet = d.sheet AND r.row_key = d.row_key
           WHERE r.batch_id = p_batch AND d.decided_at > b.analysed_at)
  FROM eureka.import_batch b WHERE b.id = p_batch;
END $$;

CREATE FUNCTION authz.import_review_rows(p_batch uuid)
RETURNS TABLE (sheet text, row_no integer, state text, reasons text[], sales_row integer, approvable boolean, commit_error text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
BEGIN
  PERFORM authz.import_require_admin();
  IF NOT EXISTS (SELECT 1 FROM eureka.import_batch ib WHERE ib.id = p_batch) THEN
    RAISE EXCEPTION 'batch_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  RETURN QUERY
  SELECT r.sheet, r.row_no, r.state, r.reasons,
         (SELECT s.row_no FROM eureka.import_row s WHERE s.batch_id = r.batch_id AND s.sheet = 'sales'
            AND s.row_key = r.person_key AND s.id <> r.id ORDER BY s.row_no LIMIT 1),
         r.state = 'review' AND pg_catalog.cardinality(r.reasons) > 0
           AND NOT EXISTS (SELECT 1 FROM pg_catalog.unnest(r.reasons) x WHERE NOT authz.import_reason_approvable(x)),
         r.commit_error
  FROM eureka.import_row r
  WHERE r.batch_id = p_batch AND (r.state IN ('review', 'held') OR r.commit_error IS NOT NULL)
  ORDER BY pg_catalog.array_position(ARRAY['sales','interviews','placements'], r.sheet), r.row_no;
END $$;

-- Internal helpers of import_load_person (not executable by any role).
CREATE FUNCTION authz.import_audit(p_action text, p_type text, p_id uuid, p_changes jsonb, p_batch uuid, p_operator uuid)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  INSERT INTO eureka.audit_event (actor_id, action, entity_type, entity_id, changes)
  VALUES (authz.current_user_id(), p_action, p_type, p_id,
          coalesce(p_changes, '{}'::jsonb) || pg_catalog.jsonb_build_object('source', 'import', 'batchId', p_batch, 'operator', p_operator))
$$;

CREATE FUNCTION authz.import_act_as(p_user uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_user IS NULL
     OR NOT EXISTS (SELECT 1 FROM eureka.app_user u WHERE u.id = p_user AND u.status = 'active')
     OR NOT EXISTS (SELECT 1 FROM eureka.user_role ur JOIN eureka.role ro ON ro.key = ur.role_key
                    WHERE ur.user_id = p_user AND ur.valid @> pg_catalog.now() AND ro.is_sales) THEN
    RAISE EXCEPTION 'owner_not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM pg_catalog.set_config('eureka.user_id', p_user::text, true);
END $$;

CREATE FUNCTION authz.import_walk_submission(p_sub uuid, p_target text, p_batch uuid, p_operator uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  path constant text[] := ARRAY['submitted','under_review','interview_requested','interview_scheduled','interview_completed','selected'];
  cur text; i integer; t integer := pg_catalog.array_position(path, p_target);
BEGIN
  SELECT s.status INTO cur FROM eureka.submission s WHERE s.id = p_sub;
  i := pg_catalog.array_position(path, cur);
  IF i IS NULL OR t IS NULL THEN
    RAISE EXCEPTION 'submission_closed' USING ERRCODE = 'check_violation';
  END IF;
  WHILE i < t LOOP
    PERFORM authz.transition_submission(p_sub, path[i + 1], NULL);
    PERFORM authz.import_audit('submission.status', 'submission', p_sub,
      pg_catalog.jsonb_build_object('from', path[i], 'to', path[i + 1]), p_batch, p_operator);
    i := i + 1;
  END LOOP;
END $$;

-- CLI (eureka_import): loads one person - a clean sales row, or new activity
-- for a person loaded earlier (p_row is then one of its rows) - with all its
-- clean rows. p_dry_run does the same work and always rolls back (raises
-- 'import_dry_run' with the counts as DETAIL).
CREATE FUNCTION authz.import_load_person(p_batch uuid, p_row uuid, p_dry_run boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  dry constant boolean := coalesce(p_dry_run, true);
  ppath constant text[] := ARRAY['confirmed','paperwork','bgc','ready','joined'];
  b record; anchor record; r record; g record; ex record; p record; tr record;
  s jsonb; n jsonb; pkey text; owner uuid; cand uuid; team uuid; person uuid; vis text; tgt text; cur text;
  sub_id uuid; sub_owner uuid; nk text; iv uuid; starts timestamptz; ends timestamptz; pl uuid; pst text;
  steps text[]; reason text; h text; ids uuid[];
  counts jsonb := '{"candidates":0,"submissions":0,"interviews":0,"placements":0,"updated":0}';
  skipped jsonb := '[]';
BEGIN
  PERFORM authz.import_begin();
  SELECT * INTO b FROM eureka.import_batch WHERE id = p_batch FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'batch_not_found' USING ERRCODE = 'no_data_found'; END IF;
  IF b.purged_at IS NOT NULL THEN RAISE EXCEPTION 'batch_purged' USING ERRCODE = 'check_violation'; END IF;
  IF NOT dry THEN
    IF b.status IS DISTINCT FROM 'approved' THEN
      RAISE EXCEPTION 'batch_not_approved' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT coalesce(b.approved_at + pg_catalog.make_interval(days => (SELECT c.approval_days FROM eureka.import_config c)) > pg_catalog.now(), false) THEN
      RAISE EXCEPTION 'approval_expired' USING ERRCODE = 'check_violation';
    END IF;
    IF authz.import_batch_digest(p_batch) IS DISTINCT FROM b.approved_digest THEN
      RAISE EXCEPTION 'batch_changed' USING ERRCODE = 'check_violation';
    END IF;
    PERFORM pg_catalog.set_config('eureka.import_verified', p_batch::text || ':' || pg_catalog.txid_current()::text, true);
  END IF;

  SELECT * INTO anchor FROM eureka.import_row x WHERE x.id = p_row AND x.batch_id = p_batch AND x.state = 'clean';
  IF NOT FOUND THEN RAISE EXCEPTION 'row_not_loadable' USING ERRCODE = 'check_violation'; END IF;
  pkey := CASE WHEN anchor.sheet = 'sales' THEN anchor.row_key ELSE anchor.person_key END;
  IF anchor.sheet <> 'sales' AND (pkey IS NULL OR pkey NOT LIKE 'ledger:%') THEN
    RAISE EXCEPTION 'row_not_loadable' USING ERRCODE = 'check_violation';
  END IF;

  -- Rows this call loads: clean rows of the person whose review decision (if
  -- any) is reflected in the approved analysis. (An id array, not a temporary
  -- table: a caller could plant objects in its session's temporary schema.)
  SELECT coalesce(pg_catalog.array_agg(x.id), '{}') INTO ids FROM eureka.import_row x
   WHERE x.batch_id = p_batch AND x.state = 'clean'
     AND ((x.sheet = 'sales' AND x.id = anchor.id) OR (x.sheet <> 'sales' AND x.person_key = pkey))
     AND NOT EXISTS (
       SELECT 1 FROM eureka.import_decision d
        WHERE d.sheet = x.sheet AND d.row_key = x.row_key
          AND (d.action = 'reject'
               OR (NOT dry AND d.decided_at > b.approved_at)
               OR (d.action = 'link' AND (x.sheet = 'sales' OR NOT EXISTS (
                     SELECT 1 FROM eureka.import_row t WHERE t.batch_id = p_batch AND t.sheet = 'sales'
                        AND t.row_key = d.link_row_key AND t.person_key = x.person_key)))));
  SELECT coalesce(pg_catalog.jsonb_agg(x.id), '[]') INTO skipped FROM eureka.import_row x
   WHERE x.batch_id = p_batch AND x.state = 'clean'
     AND ((x.sheet = 'sales' AND x.id = anchor.id) OR (x.sheet <> 'sales' AND x.person_key = pkey))
     AND NOT (x.id = ANY (ids));
  IF anchor.sheet = 'sales' AND NOT (anchor.id = ANY (ids)) THEN
    PERFORM authz.import_end();
    RETURN pg_catalog.jsonb_build_object('counts', counts, 'skipped', skipped);
  END IF;

  -- ---------- candidate (as POST /candidates, then profile and status) ----------
  IF anchor.sheet = 'sales' THEN
    s := anchor.norm;
    owner := (s ->> 'ownerId')::uuid;
    PERFORM authz.import_act_as(owner);
    team := authz.actor_team();
    IF team IS NULL THEN RAISE EXCEPTION 'owner_has_no_team' USING ERRCODE = 'check_violation'; END IF;
    vis := CASE WHEN s ->> 'visibility' = 'all_teams' THEN 'all_teams' ELSE 'team' END;
    person := pg_catalog.gen_random_uuid();
    INSERT INTO eureka.person (id, first_name, last_name, phone_e164, personal_email)
    VALUES (person, s ->> 'firstName', s ->> 'lastName', nullif(s ->> 'phone', ''), nullif(s ->> 'personalEmail', ''));
    INSERT INTO eureka.candidate (person_id, technology_id, team_id, recruiter_id, location_id, visibility)
    VALUES (person, (s ->> 'technologyId')::uuid, team,
            CASE WHEN EXISTS (SELECT 1 FROM eureka.user_role ur WHERE ur.user_id = owner AND ur.role_key = 'recruiter'
                              AND ur.valid @> pg_catalog.now()) THEN owner END,
            (s ->> 'locationId')::uuid, vis)
    RETURNING id INTO cand;
    -- Visibility is part of the approved batch (the sheet's "Active/All Teams").
    PERFORM authz.import_audit('candidate.created', 'candidate', cand, pg_catalog.jsonb_build_object('visibility', vis), p_batch, b.operator_id);
    IF coalesce(s ->> 'priority', s ->> 'marketingEmail', s ->> 'marketingStartDate') IS NOT NULL THEN
      UPDATE eureka.candidate SET priority = coalesce(s ->> 'priority', priority),
             marketing_email = coalesce(s ->> 'marketingEmail', marketing_email::text),
             marketing_start_date = coalesce((s ->> 'marketingStartDate')::date, marketing_start_date)
       WHERE id = cand;
      PERFORM authz.import_audit('candidate.updated', 'candidate', cand, pg_catalog.jsonb_build_object('fields',
        (SELECT pg_catalog.jsonb_agg(f) FROM pg_catalog.unnest(ARRAY['priority','marketingEmail','marketingStartDate']) f
          WHERE s ->> f IS NOT NULL)), p_batch, b.operator_id);
    END IF;
    tgt := s ->> 'status';
    IF tgt IS DISTINCT FROM 'in_training' THEN
      PERFORM authz.transition_candidate(cand, 'active');
      PERFORM authz.import_audit('candidate.transition', 'candidate', cand,
        pg_catalog.jsonb_build_object('from', 'in_training', 'to', 'active'), p_batch, b.operator_id);
    END IF;
    counts := pg_catalog.jsonb_set(counts, '{candidates}', pg_catalog.to_jsonb((counts ->> 'candidates')::int + 1));
    IF NOT dry THEN
      INSERT INTO eureka.import_link (sheet, row_key, entity_type, entity_id, owner_id, batch_id)
      VALUES ('sales', anchor.row_key, 'candidate', cand, owner, p_batch);
      INSERT INTO eureka.import_identity (identity_hash, candidate_id, owner_id, batch_id)
      SELECT DISTINCT x, cand, owner, p_batch FROM pg_catalog.jsonb_array_elements_text(coalesce(s -> 'identities', '[]')) x
      ON CONFLICT (identity_hash) DO NOTHING;
      UPDATE eureka.import_row SET state = 'committed', committed_entity = cand WHERE id = anchor.id;
    END IF;
  ELSE
    cand := pg_catalog.substr(pkey, 8)::uuid;
    SELECT i.owner_id INTO owner FROM eureka.import_identity i WHERE i.candidate_id = cand ORDER BY i.created_at LIMIT 1;
    IF owner IS NULL THEN RAISE EXCEPTION 'ledger_candidate_missing' USING ERRCODE = 'check_violation'; END IF;
  END IF;

  -- ---------- submissions, interviews, placements ----------
  FOR g IN SELECT (l.norm ->> 'clientId')::uuid AS client, pg_catalog.lower(l.norm ->> 'jobTitle') AS job, min(l.row_no) AS first_no
             FROM eureka.import_row l WHERE l.id = ANY (ids) AND l.sheet <> 'sales' GROUP BY 1, 2 ORDER BY 3 LOOP
    SELECT l.norm INTO n FROM eureka.import_row l WHERE l.id = ANY (ids) AND l.sheet <> 'sales' AND (l.norm ->> 'clientId')::uuid = g.client
       AND pg_catalog.lower(l.norm ->> 'jobTitle') = g.job ORDER BY l.row_no LIMIT 1;
    nk := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(cand::text || '|' || g.client::text || '|' || g.job, 'UTF8')), 'hex');
    SELECT k.entity_id, k.owner_id INTO sub_id, sub_owner FROM eureka.import_link k WHERE k.sheet = 'submission' AND k.row_key = nk;
    IF sub_id IS NULL THEN
      sub_owner := coalesce((n ->> 'ownerId')::uuid, owner);
      PERFORM authz.import_act_as(sub_owner);
      INSERT INTO eureka.submission (candidate_id, job_title, client_id, vendor_id)
      VALUES (cand, n ->> 'jobTitle', g.client, (n ->> 'vendorId')::uuid) RETURNING id INTO sub_id;
      PERFORM authz.import_audit('submission.created', 'submission', sub_id,
        pg_catalog.jsonb_build_object('candidateId', cand, 'clientId', g.client), p_batch, b.operator_id);
      counts := pg_catalog.jsonb_set(counts, '{submissions}', pg_catalog.to_jsonb((counts ->> 'submissions')::int + 1));
      IF NOT dry THEN
        INSERT INTO eureka.import_link (sheet, row_key, entity_type, entity_id, owner_id, batch_id)
        VALUES ('submission', nk, 'submission', sub_id, sub_owner, p_batch);
      END IF;
    ELSE
      -- Later activity on an imported submission acts as its submitter.
      PERFORM authz.import_act_as(sub_owner);
    END IF;

    -- Interviews, oldest first. A natural-key match updates the earlier one.
    IF EXISTS (SELECT 1 FROM eureka.import_row l WHERE l.id = ANY (ids) AND l.sheet = 'interviews' AND (l.norm ->> 'clientId')::uuid = g.client
               AND pg_catalog.lower(l.norm ->> 'jobTitle') = g.job) THEN
      PERFORM authz.import_walk_submission(sub_id, 'interview_scheduled', p_batch, b.operator_id);
    END IF;
    FOR r IN SELECT * FROM eureka.import_row l WHERE l.id = ANY (ids) AND l.sheet = 'interviews' AND (l.norm ->> 'clientId')::uuid = g.client
               AND pg_catalog.lower(l.norm ->> 'jobTitle') = g.job ORDER BY l.norm ->> 'startLocal', l.row_no LOOP
      starts := (r.norm ->> 'startLocal')::timestamp AT TIME ZONE (r.norm ->> 'timeZone');
      ends := starts + pg_catalog.make_interval(mins => (r.norm ->> 'minutes')::integer);
      nk := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('interview|' || cand::text || '|' || g.client::text || '|'
            || g.job || '|' || pg_catalog.lower(r.norm ->> 'round') || '|' || pg_catalog.substr(r.norm ->> 'startLocal', 1, 10), 'UTF8')), 'hex');
      iv := NULL;
      SELECT k.entity_id INTO iv FROM eureka.import_natural_key k WHERE k.kind = 'interview' AND k.key_hash = nk;
      IF iv IS NOT NULL THEN
        SELECT i.starts_at, i.ends_at, i.call_status INTO ex FROM eureka.interview i WHERE i.id = iv;
        IF (ex.starts_at, ex.ends_at, ex.call_status) IS DISTINCT FROM (starts, ends, coalesce(r.norm ->> 'callStatus', ex.call_status)) THEN
          UPDATE eureka.interview SET starts_at = starts, ends_at = ends,
                 call_status = coalesce(r.norm ->> 'callStatus', call_status) WHERE id = iv;
          IF NOT FOUND THEN RAISE EXCEPTION 'interview_not_updatable' USING ERRCODE = 'insufficient_privilege'; END IF;
          PERFORM authz.import_audit('interview.updated', 'interview', iv,
            pg_catalog.jsonb_build_object('startsAt', 'set', 'endsAt', 'set', 'callStatus', 'set'), p_batch, b.operator_id);
          counts := pg_catalog.jsonb_set(counts, '{updated}', pg_catalog.to_jsonb((counts ->> 'updated')::int + 1));
        END IF;
      ELSE
        INSERT INTO eureka.interview (submission_id, round, starts_at, ends_at)
        VALUES (sub_id, r.norm ->> 'round', starts, ends) RETURNING id INTO iv;
        PERFORM authz.import_audit('interview.created', 'interview', iv, pg_catalog.jsonb_build_object(
          'submissionId', sub_id, 'round', r.norm ->> 'round', 'startsAt', starts, 'endsAt', ends), p_batch, b.operator_id);
        IF coalesce(r.norm ->> 'callStatus', 'scheduled') <> 'scheduled' THEN
          UPDATE eureka.interview SET call_status = r.norm ->> 'callStatus' WHERE id = iv;
          IF NOT FOUND THEN RAISE EXCEPTION 'interview_not_updatable' USING ERRCODE = 'insufficient_privilege'; END IF;
          PERFORM authz.import_audit('interview.updated', 'interview', iv, '{"callStatus":"set"}', p_batch, b.operator_id);
        END IF;
        counts := pg_catalog.jsonb_set(counts, '{interviews}', pg_catalog.to_jsonb((counts ->> 'interviews')::int + 1));
        IF NOT dry THEN
          INSERT INTO eureka.import_natural_key (kind, key_hash, entity_id, batch_id) VALUES ('interview', nk, iv, p_batch);
        END IF;
      END IF;
      IF NOT dry THEN
        INSERT INTO eureka.import_link (sheet, row_key, entity_type, entity_id, owner_id, batch_id)
        VALUES ('interviews', r.row_key, 'interview', iv, sub_owner, p_batch);
        UPDATE eureka.import_row SET state = 'committed', committed_entity = iv WHERE id = r.id;
      END IF;
    END LOOP;

    IF EXISTS (SELECT 1 FROM eureka.import_row l WHERE l.id = ANY (ids) AND l.sheet = 'placements' AND (l.norm ->> 'clientId')::uuid = g.client
               AND pg_catalog.lower(l.norm ->> 'jobTitle') = g.job) THEN
      PERFORM authz.import_walk_submission(sub_id, 'selected', p_batch, b.operator_id);
    ELSIF EXISTS (SELECT 1 FROM eureka.import_row l WHERE l.id = ANY (ids) AND l.sheet = 'interviews' AND (l.norm ->> 'clientId')::uuid = g.client
                  AND pg_catalog.lower(l.norm ->> 'jobTitle') = g.job AND l.norm ->> 'callStatus' = 'completed') THEN
      PERFORM authz.import_walk_submission(sub_id, 'interview_completed', p_batch, b.operator_id);
    END IF;

    -- Placements: a backout first (it frees the submission), then the rest.
    FOR r IN SELECT * FROM eureka.import_row l WHERE l.id = ANY (ids) AND l.sheet = 'placements' AND (l.norm ->> 'clientId')::uuid = g.client
               AND pg_catalog.lower(l.norm ->> 'jobTitle') = g.job
             ORDER BY (l.norm ->> 'status' = 'backout') DESC, l.row_no LOOP
      tgt := r.norm ->> 'status';
      nk := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('placement|' || sub_id::text || '|' || (r.norm ->> 'tentativeStart'), 'UTF8')), 'hex');
      pl := NULL;
      SELECT k.entity_id INTO pl FROM eureka.import_natural_key k WHERE k.kind = 'placement' AND k.key_hash = nk;
      IF pl IS NULL THEN
        SELECT * INTO p FROM authz.create_placement(sub_id, r.norm ->> 'placementType', (r.norm ->> 'rate')::numeric,
          r.norm ->> 'workMode', r.norm ->> 'projectCity', r.norm ->> 'projectState', (r.norm ->> 'tentativeStart')::date,
          (r.norm ->> 'partnerId')::uuid, NULL);
        pl := p.placement_id;
        PERFORM authz.import_audit('placement.created', 'placement', pl, pg_catalog.jsonb_build_object(
          'submissionId', sub_id, 'candidateId', cand, 'placementType', r.norm ->> 'placementType', 'workMode', r.norm ->> 'workMode',
          'tentativeStart', r.norm ->> 'tentativeStart', 'isFirstPlacement', p.is_first_placement, 'contactCount', 0), p_batch, b.operator_id);
        IF p.candidate_to IS NOT NULL THEN
          PERFORM authz.import_audit('candidate.transition', 'candidate', cand, pg_catalog.jsonb_build_object(
            'from', p.candidate_from, 'to', p.candidate_to, 'via', 'placement'), p_batch, b.operator_id);
        END IF;
        counts := pg_catalog.jsonb_set(counts, '{placements}', pg_catalog.to_jsonb((counts ->> 'placements')::int + 1));
        IF NOT dry THEN
          INSERT INTO eureka.import_natural_key (kind, key_hash, entity_id, batch_id) VALUES ('placement', nk, pl, p_batch);
        END IF;
      ELSE
        counts := pg_catalog.jsonb_set(counts, '{updated}', pg_catalog.to_jsonb((counts ->> 'updated')::int + 1));
      END IF;
      SELECT x.status INTO pst FROM eureka.placement x WHERE x.id = pl;
      IF tgt = 'backout' THEN
        steps := CASE WHEN pst = 'backout' THEN ARRAY[]::text[] ELSE ARRAY['backout'] END;
      ELSIF pg_catalog.array_position(ppath, tgt) IS NOT NULL AND pg_catalog.array_position(ppath, pst) IS NOT NULL
            AND pg_catalog.array_position(ppath, tgt) >= pg_catalog.array_position(ppath, pst) THEN
        steps := ppath[pg_catalog.array_position(ppath, pst) + 1 : pg_catalog.array_position(ppath, tgt)];
      ELSE
        RAISE EXCEPTION 'placement_conflict' USING ERRCODE = 'check_violation';
      END IF;
      FOREACH h IN ARRAY steps LOOP
        reason := CASE WHEN h = 'backout' THEN coalesce(nullif(r.norm ->> 'statusReason', ''), 'Backout recorded in the placement sheet (import)') END;
        SELECT * INTO tr FROM authz.transition_placement(pl, h, reason);
        PERFORM authz.import_audit('placement.status', 'placement', pl, pg_catalog.jsonb_build_object(
          'from', tr.from_status, 'to', tr.to_status) || CASE WHEN reason IS NOT NULL THEN '{"reasonGiven":true}'::jsonb ELSE '{}' END,
          p_batch, b.operator_id);
        IF tr.candidate_to IS NOT NULL THEN
          PERFORM authz.import_audit('candidate.transition', 'candidate', cand, pg_catalog.jsonb_build_object(
            'from', tr.candidate_from, 'to', tr.candidate_to, 'via', 'placement'), p_batch, b.operator_id);
        END IF;
      END LOOP;
      IF NOT dry THEN
        INSERT INTO eureka.import_link (sheet, row_key, entity_type, entity_id, owner_id, batch_id)
        VALUES ('placements', r.row_key, 'placement', pl, sub_owner, p_batch)
        ON CONFLICT (sheet, row_key) DO NOTHING;
        UPDATE eureka.import_row SET state = 'committed', committed_entity = pl WHERE id = r.id;
      END IF;
    END LOOP;
    sub_id := NULL; sub_owner := NULL;
  END LOOP;

  -- ---------- final candidate status from the sales sheet ----------
  IF anchor.sheet = 'sales' THEN
    PERFORM authz.import_act_as(owner);
    tgt := s ->> 'status';
    SELECT c.marketing_status INTO cur FROM eureka.candidate c WHERE c.id = cand;
    IF cur IS DISTINCT FROM tgt THEN
      IF cur = 'active' AND tgt IN ('on_hold', 'stopped', 'full_of_interviews', 'terminated') THEN
        PERFORM authz.transition_candidate(cand, tgt);
        PERFORM authz.import_audit('candidate.transition', 'candidate', cand,
          pg_catalog.jsonb_build_object('from', cur, 'to', tgt), p_batch, b.operator_id);
      ELSE
        RAISE EXCEPTION 'status_unreachable' USING ERRCODE = 'check_violation', DETAIL = coalesce(cur, 'null') || ' -> ' || coalesce(tgt, 'null');
      END IF;
    END IF;
  END IF;

  IF dry THEN
    RAISE EXCEPTION 'import_dry_run' USING ERRCODE = 'P0001',
      DETAIL = pg_catalog.jsonb_build_object('counts', counts, 'skipped', skipped)::text;
  END IF;
  PERFORM authz.import_end();
  RETURN pg_catalog.jsonb_build_object('counts', counts, 'skipped', skipped);
END $$;

-- CLI: marks an approved batch committed once no clean rows are left.
CREATE FUNCTION authz.import_finish_batch(p_batch uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE st text;
BEGIN
  SELECT ib.status INTO st FROM eureka.import_batch ib WHERE ib.id = p_batch FOR UPDATE;
  IF st IS NOT DISTINCT FROM 'approved'
     AND NOT EXISTS (SELECT 1 FROM eureka.import_row r WHERE r.batch_id = p_batch AND r.state = 'clean') THEN
    UPDATE eureka.import_batch SET status = 'committed' WHERE id = p_batch;
    RETURN 'committed';
  END IF;
  RETURN st;
END $$;

RESET ROLE;

DO $$
DECLARE f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE (n.nspname = 'authz' AND p.proname LIKE 'import\_%')
              OR (n.nspname = 'eureka' AND p.proname IN ('import_batch_guard', 'import_row_guard', 'import_decision_guard',
                                                         'import_ledger_guard', 'import_ticket_guard'))
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION authz.current_user_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.import_create_ticket(text), authz.import_decide(uuid, text, integer, text, integer),
  authz.import_approve_batch(uuid), authz.import_batch_summary(uuid), authz.import_review_rows(uuid) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.import_open_batch(text, text, jsonb), authz.import_live_match(uuid),
  authz.import_load_person(uuid, uuid, boolean), authz.import_finish_batch(uuid) TO eureka_import;
