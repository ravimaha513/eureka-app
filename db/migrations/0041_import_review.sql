-- Sheet import, second review (docs/import.md). Builds on 0033.
--
--  1. The database checks what an approver signs: authz.import_verify_batch
--     re-derives what it can from the stored sheet cells and the batch's own
--     mapping (state against reasons, the owner from the owner column, the
--     target status and visibility from the status/row-colour mapping, the
--     person link, live duplicates against approved decisions, placements
--     only when the batch loads them) and approval is refused while any
--     problem remains. authz.import_load_preview shows the approver, per row,
--     what will load (person, owner, visibility, target status) with counts
--     per owner and the digest; approval must quote that digest.
--     placements_commit is a batch column fixed at staging and part of the digest.
--  2. The digest also covers sheet, row number, row key, person key, status
--     key and placements_commit; row writes take the batch row FOR SHARE so
--     they serialize with approval (FOR UPDATE).
--  4. The loader also requires the approver and the operator to still be
--     active org admins.
--  5. "An import call is running" is a row in eureka.import_session keyed by
--     the current transaction and backend, written only by authz_definer
--     (authz.import_begin/import_end). current_user_id() and the loader's
--     policies check it instead of a client-settable setting.
--  6. Rows from before 0033 are backfilled and its constraints validated.
-- Rules 1-7 of docs/HANDOFF.md apply.
SET search_path = eureka, public;

-- ---------- marker of a running import call ----------
SET ROLE eureka_owner;
CREATE TABLE eureka.import_session (
  xact           xid8 NOT NULL,
  pid            integer NOT NULL,
  verified_batch uuid,
  PRIMARY KEY (xact, pid)
);
ALTER TABLE eureka.import_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE eureka.import_session FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.import_batch ADD COLUMN placements_commit boolean NOT NULL DEFAULT false;
RESET ROLE;
CREATE POLICY definer_all ON eureka.import_session FOR ALL TO authz_definer USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON eureka.import_session TO authz_definer;

SET ROLE authz_definer;

CREATE FUNCTION authz.import_active() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM eureka.import_session s
                 WHERE s.xact = pg_catalog.pg_current_xact_id_if_assigned() AND s.pid = pg_catalog.pg_backend_pid())
$$;

CREATE OR REPLACE FUNCTION authz.current_user_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE
    WHEN session_user::text IS DISTINCT FROM 'eureka_import' OR authz.import_active()
      THEN nullif(pg_catalog.current_setting('eureka.user_id', true), '')::uuid
  END
$$;

CREATE OR REPLACE FUNCTION authz.import_begin() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  INSERT INTO eureka.import_session (xact, pid) VALUES (pg_catalog.pg_current_xact_id(), pg_catalog.pg_backend_pid())
  ON CONFLICT (xact, pid) DO UPDATE SET verified_batch = NULL;
  PERFORM pg_catalog.set_config('eureka.user_id', '', true);
END $$;

CREATE OR REPLACE FUNCTION authz.import_end() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  DELETE FROM eureka.import_session WHERE xact = pg_catalog.pg_current_xact_id_if_assigned() AND pid = pg_catalog.pg_backend_pid();
  PERFORM pg_catalog.set_config('eureka.user_id', '', true);
END $$;

-- An active org admin (access:manage at org scope), checked from the tables.
CREATE FUNCTION authz.import_is_admin(p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT p_user IS NOT NULL AND EXISTS (
    SELECT 1 FROM eureka.app_user u JOIN eureka.user_role ur ON ur.user_id = u.id
      JOIN eureka.role_permission rp ON rp.role_key = ur.role_key
     WHERE u.id = p_user AND u.status = 'active' AND ur.valid @> pg_catalog.now()
       AND rp.permission = 'access:manage' AND rp.scope = 'org')
$$;

-- Approval digest: batch setting plus every row's identity, state (loaded
-- counts as clean), keys, normalized values and reasons.
CREATE OR REPLACE FUNCTION authz.import_batch_digest(p_batch uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    coalesce((SELECT b.placements_commit::text FROM eureka.import_batch b WHERE b.id = p_batch), '') || E'\n' ||
    coalesce((SELECT pg_catalog.string_agg(
      r.id::text || '|' || r.sheet || '|' || r.row_no::text || '|' || r.row_key || '|' || coalesce(r.person_key, '') || '|'
        || coalesce(r.status_key, '') || '|' || CASE WHEN r.state = 'committed' THEN 'clean' ELSE r.state END || '|'
        || coalesce(r.norm::text, '') || '|' || pg_catalog.array_to_string(r.reasons, ','),
      E'\n' ORDER BY r.id) FROM eureka.import_row r WHERE r.batch_id = p_batch), ''), 'UTF8')), 'hex')
$$;

-- A cell by its header (case-insensitive), and a label as the mapping keys it.
CREATE FUNCTION authz.import_cell(p_raw jsonb, p_header text) RETURNS text
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT pg_catalog.btrim(e.value) FROM pg_catalog.jsonb_each_text(coalesce(p_raw, '{}')) e
   WHERE p_header IS NOT NULL AND pg_catalog.lower(pg_catalog.btrim(e.key)) = pg_catalog.lower(pg_catalog.btrim(p_header)) LIMIT 1
$$;
CREATE FUNCTION authz.import_label(p_text text) RETURNS text
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT pg_catalog.regexp_replace(pg_catalog.regexp_replace(pg_catalog.lower(pg_catalog.btrim(
    pg_catalog.regexp_replace(coalesce(p_text, ''), '[[:cntrl:][:space:]]+', ' ', 'g'))), '\s*([/-])\s*', '\1', 'g'), '\s+', ' ', 'g')
$$;
CREATE FUNCTION authz.import_color(p_text text) RETURNS text
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE
    WHEN c ~ '^#?[0-9a-f]{6}$' THEN '#' || pg_catalog.right(c, 6)
    WHEN c ~ '^#?[0-9a-f]{3}$' THEN '#' || pg_catalog.regexp_replace(pg_catalog.right(c, 3), '(.)', '\1\1', 'g')
    ELSE c END
  FROM (SELECT pg_catalog.lower(pg_catalog.btrim(coalesce(p_text, ''))) AS c) x
$$;
-- The mapping entry for a label (keys starting with "_" are comments).
CREATE FUNCTION authz.import_map_entry(p_map jsonb, p_key text) RETURNS jsonb
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT e.value FROM pg_catalog.jsonb_each(coalesce(p_map, '{}')) e
   WHERE e.key NOT LIKE '\_%' AND authz.import_label(e.key) = p_key LIMIT 1
$$;

-- Live duplicate check on normalized values (shared by staging and verification).
CREATE FUNCTION authz.import_live_match_norm(p_norm jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH r AS (SELECT nullif(pg_catalog.lower(p_norm ->> 'marketingEmail'), '') AS e1,
                    nullif(pg_catalog.lower(p_norm ->> 'personalEmail'), '') AS e2,
                    nullif(p_norm ->> 'phone', '') AS ph)
  SELECT EXISTS (
    SELECT 1 FROM r, eureka.candidate c JOIN eureka.person p ON p.id = c.person_id
    WHERE (pg_catalog.lower(p.personal_email::text) IN (r.e1, r.e2)
           OR pg_catalog.lower(c.marketing_email::text) IN (r.e1, r.e2)
           OR p.phone_e164 = r.ph)
      AND NOT EXISTS (SELECT 1 FROM eureka.import_identity i WHERE i.candidate_id = c.id))
$$;

-- What the database can check about a batch's rows, from the stored cells
-- and the batch's own mapping. Empty means verified.
CREATE FUNCTION authz.import_verify_batch(p_batch uuid) RETURNS TABLE (sheet text, row_no integer, problem text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE m jsonb; pc boolean;
BEGIN
  SELECT b.files -> 'mapping', b.placements_commit INTO m, pc FROM eureka.import_batch b WHERE b.id = p_batch;
  RETURN QUERY
  WITH r AS (
    SELECT x.*,
           authz.import_cell(x.raw, m -> 'sheets' -> x.sheet -> 'columns' ->> 'owner') AS owner_cell
      FROM eureka.import_row x
     WHERE x.batch_id = p_batch AND x.state <> 'committed' AND x.norm IS NOT NULL),
  owners AS (
    SELECT r.id, (SELECT u.id FROM eureka.app_user u WHERE pg_catalog.lower(u.email::text) = pg_catalog.lower(r.owner_cell)
                   AND u.status = 'active') AS cell_owner
      FROM r WHERE coalesce(r.owner_cell, '') <> ''),
  sales_map AS (
    SELECT r.id,
           coalesce(
             authz.import_map_entry(m -> 'statuses' -> 'sales',
               authz.import_label(authz.import_cell(r.raw, m -> 'sheets' -> 'sales' -> 'columns' ->> 'status'))),
             CASE WHEN authz.import_label(authz.import_cell(r.raw, m -> 'sheets' -> 'sales' -> 'columns' ->> 'status')) = ''
                  THEN authz.import_map_entry(m -> 'rowColors' -> 'sales',
                         authz.import_color(authz.import_cell(r.raw, m -> 'sheets' -> 'sales' -> 'columns' ->> 'rowColor'))) END) AS entry
      FROM r WHERE r.sheet = 'sales' AND r.state = 'clean'),
  problems AS (
    SELECT r.sheet, r.row_no, 'clean_with_reasons' AS problem FROM r
     WHERE r.state = 'clean' AND pg_catalog.cardinality(r.reasons) > 0
    UNION ALL
    SELECT r.sheet, r.row_no, 'state_without_reasons' FROM r
     WHERE r.state <> 'clean' AND pg_catalog.cardinality(r.reasons) = 0
    UNION ALL
    -- sales rows: owner, status, visibility, person and live duplicates
    SELECT r.sheet, r.row_no, 'owner_mismatch' FROM r LEFT JOIN owners o ON o.id = r.id
     WHERE r.sheet = 'sales' AND r.state = 'clean' AND (r.norm ->> 'ownerId') IS DISTINCT FROM o.cell_owner::text
    UNION ALL
    SELECT r.sheet, r.row_no, 'status_mismatch' FROM r JOIN sales_map s ON s.id = r.id
     WHERE (r.norm ->> 'status') IS DISTINCT FROM (s.entry ->> 'status')
    UNION ALL
    SELECT r.sheet, r.row_no, 'visibility_mismatch' FROM r JOIN sales_map s ON s.id = r.id
     WHERE coalesce(r.norm ->> 'visibility', 'team') IS DISTINCT FROM coalesce(s.entry ->> 'visibility', 'team')
    UNION ALL
    SELECT r.sheet, r.row_no, 'person_mismatch' FROM r
     WHERE r.sheet = 'sales' AND r.state = 'clean' AND r.person_key IS DISTINCT FROM r.row_key
    UNION ALL
    SELECT r.sheet, r.row_no, 'unapproved_live_match' FROM r
     WHERE r.sheet = 'sales' AND r.state = 'clean' AND authz.import_live_match_norm(r.norm)
       AND NOT EXISTS (SELECT 1 FROM eureka.import_decision d WHERE d.sheet = 'sales' AND d.row_key = r.row_key
                       AND d.action = 'approve' AND 'matches_existing_candidate' = ANY (d.approved_reasons))
    UNION ALL
    -- interview and placement rows: person and owner
    SELECT r.sheet, r.row_no, 'person_mismatch' FROM r
     WHERE r.sheet <> 'sales' AND r.state = 'clean' AND NOT coalesce(
       CASE WHEN r.person_key LIKE 'ledger:%'
            THEN EXISTS (SELECT 1 FROM eureka.import_identity i WHERE i.candidate_id::text = pg_catalog.substr(r.person_key, 8))
            ELSE EXISTS (SELECT 1 FROM eureka.import_row s WHERE s.batch_id = p_batch AND s.sheet = 'sales'
                         AND s.state IN ('clean', 'committed') AND s.row_key = r.person_key) END, false)
    UNION ALL
    SELECT r.sheet, r.row_no, 'owner_mismatch' FROM r LEFT JOIN owners o ON o.id = r.id
     WHERE r.sheet <> 'sales' AND r.state = 'clean'
       AND (r.norm ->> 'ownerId') IS DISTINCT FROM coalesce(o.cell_owner::text, CASE
             WHEN r.person_key LIKE 'ledger:%' THEN (SELECT i.owner_id::text FROM eureka.import_identity i
                   WHERE i.candidate_id::text = pg_catalog.substr(r.person_key, 8) ORDER BY i.created_at LIMIT 1)
             ELSE (SELECT s.norm ->> 'ownerId' FROM eureka.import_row s WHERE s.batch_id = p_batch AND s.sheet = 'sales'
                   AND s.row_key = r.person_key LIMIT 1) END)
    UNION ALL
    SELECT r.sheet, r.row_no, 'placements_disabled' FROM r
     WHERE r.sheet = 'placements' AND r.state = 'clean' AND NOT coalesce(pc, false))
  SELECT p.sheet, p.row_no, p.problem FROM problems p ORDER BY 1, 2, 3;
END $$;

-- API: what approval would load, for the approving org admin: per clean row
-- the person, owner, visibility and target status; counts per owner; the
-- verification problems; and the digest the approval must quote.
CREATE FUNCTION authz.import_load_preview(p_batch uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE pc boolean;
BEGIN
  PERFORM authz.import_require_admin();
  SELECT b.placements_commit INTO pc FROM eureka.import_batch b WHERE b.id = p_batch;
  IF NOT FOUND THEN RAISE EXCEPTION 'batch_not_found' USING ERRCODE = 'no_data_found'; END IF;
  RETURN pg_catalog.jsonb_build_object(
    'digest', authz.import_batch_digest(p_batch),
    'placementsCommit', pc,
    'rows', coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'sheet', r.sheet, 'rowNo', r.row_no,
        'person', CASE WHEN r.sheet = 'sales' THEN (r.norm ->> 'firstName') || ' ' || (r.norm ->> 'lastName')
                       ELSE coalesce((r.norm ->> 'firstName') || ' ' || (r.norm ->> 'lastName'), '') END,
        'personRow', (SELECT s.row_no FROM eureka.import_row s WHERE s.batch_id = p_batch AND s.sheet = 'sales'
                      AND s.row_key = r.person_key AND s.id <> r.id LIMIT 1),
        'existingCandidate', CASE WHEN r.person_key LIKE 'ledger:%' THEN pg_catalog.substr(r.person_key, 8) END,
        'owner', (SELECT u.email::text FROM eureka.app_user u WHERE u.id::text = r.norm ->> 'ownerId'),
        'visibility', CASE WHEN r.sheet = 'sales' THEN coalesce(r.norm ->> 'visibility', 'team') END,
        'targetStatus', coalesce(r.norm ->> 'status', r.norm ->> 'callStatus'))
      ORDER BY pg_catalog.array_position(ARRAY['sales','interviews','placements'], r.sheet), r.row_no)
      FROM eureka.import_row r WHERE r.batch_id = p_batch AND r.state = 'clean'), '[]'),
    'perOwner', coalesce((SELECT pg_catalog.jsonb_agg(x ORDER BY x ->> 'owner') FROM (
        SELECT pg_catalog.jsonb_build_object('owner', u.email::text,
                 'candidates', count(*) FILTER (WHERE r.sheet = 'sales'),
                 'interviews', count(*) FILTER (WHERE r.sheet = 'interviews'),
                 'placements', count(*) FILTER (WHERE r.sheet = 'placements'),
                 'allTeams', count(*) FILTER (WHERE r.sheet = 'sales' AND r.norm ->> 'visibility' = 'all_teams')) AS x
          FROM eureka.import_row r LEFT JOIN eureka.app_user u ON u.id::text = r.norm ->> 'ownerId'
         WHERE r.batch_id = p_batch AND r.state = 'clean' GROUP BY u.email) o), '[]'),
    'problems', coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('sheet', v.sheet, 'rowNo', v.row_no, 'problem', v.problem))
      FROM authz.import_verify_batch(p_batch) v), '[]'));
END $$;

-- API: sign-off quotes the digest of the preview it approves.
DROP FUNCTION authz.import_approve_batch(uuid);
CREATE FUNCTION authz.import_approve_batch(p_batch uuid, p_digest text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE actor uuid := authz.import_require_admin(); b record; d text;
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
  IF EXISTS (SELECT 1 FROM eureka.import_decision dd JOIN eureka.import_row r ON r.sheet = dd.sheet AND r.row_key = dd.row_key
             WHERE r.batch_id = p_batch AND dd.decided_at > b.analysed_at) THEN
    RAISE EXCEPTION 'needs_analysis' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM authz.import_verify_batch(p_batch)) THEN
    RAISE EXCEPTION 'verification_failed' USING ERRCODE = 'check_violation';
  END IF;
  d := authz.import_batch_digest(p_batch);
  IF p_digest IS NULL OR p_digest IS DISTINCT FROM d THEN
    RAISE EXCEPTION 'batch_changed' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE eureka.import_batch SET status = 'approved', approved_by = actor, approved_digest = d WHERE id = p_batch;
  RETURN 'approved';
END $$;

-- CLI: opens a batch with a ticket; placements_commit is fixed here.
DROP FUNCTION authz.import_open_batch(text, text, jsonb);
CREATE FUNCTION authz.import_open_batch(p_ticket text, p_digest text, p_files jsonb, p_placements_commit boolean) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE t record; new_id uuid;
BEGIN
  PERFORM authz.import_begin();
  SELECT * INTO t FROM eureka.import_ticket
   WHERE token_hash = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(coalesce(p_ticket, ''), 'UTF8')), 'hex')
   FOR UPDATE;
  IF NOT FOUND OR t.used_at IS NOT NULL OR NOT coalesce(t.expires_at > pg_catalog.now(), false)
     OR NOT authz.import_is_admin(t.created_by) THEN
    RAISE EXCEPTION 'invalid_ticket' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO eureka.import_batch (source_digest, files, operator_id, placements_commit)
  VALUES (p_digest, p_files, t.created_by, coalesce(p_placements_commit, false))
  RETURNING id INTO new_id;
  UPDATE eureka.import_ticket SET used_at = pg_catalog.now(), batch_id = new_id WHERE id = t.id;
  PERFORM authz.import_end();
  RETURN new_id;
END $$;

-- CLI: live duplicate for a staged sales row (yes/no).
CREATE OR REPLACE FUNCTION authz.import_live_match(p_row uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce((SELECT authz.import_live_match_norm(x.norm) FROM eureka.import_row x
                    JOIN eureka.import_batch b ON b.id = x.batch_id
                   WHERE x.id = p_row AND x.sheet = 'sales' AND b.status = 'staged'), false)
$$;

RESET ROLE;

-- ---------- guards ----------
SET ROLE eureka_owner;

-- placements_commit is fixed when the batch opens.
CREATE OR REPLACE FUNCTION eureka.import_batch_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
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

  IF (NEW.id, NEW.source_digest, NEW.files, NEW.operator_id, NEW.created_at, NEW.placements_commit)
     IS DISTINCT FROM (OLD.id, OLD.source_digest, OLD.files, OLD.operator_id, OLD.created_at, OLD.placements_commit) THEN
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

-- Row writes take the batch row FOR SHARE: they wait for an approval in
-- progress (FOR UPDATE) and then see its outcome. Otherwise as in 0033.
CREATE OR REPLACE FUNCTION eureka.import_row_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE b text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'import rows are not deleted; purge clears their data' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT ib.status INTO b FROM eureka.import_batch ib WHERE ib.id = NEW.batch_id FOR SHARE;
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
  IF NEW.raw IS NULL AND NEW.norm IS NULL
     AND (NEW.status_key, NEW.person_key, NEW.state, NEW.reasons, NEW.commit_error, NEW.committed_entity)
         IS NOT DISTINCT FROM (OLD.status_key, OLD.person_key, OLD.state, OLD.reasons, OLD.commit_error, OLD.committed_entity) THEN
    RETURN NEW;
  END IF;
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

-- Ledger writes: the digest is verified once per running import call (the
-- marker row, which only authz_definer writes), otherwise each time.
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
  IF NOT EXISTS (SELECT 1 FROM eureka.import_session s WHERE s.xact = pg_catalog.pg_current_xact_id_if_assigned()
                 AND s.pid = pg_catalog.pg_backend_pid() AND s.verified_batch = NEW.batch_id) THEN
    IF authz.import_batch_digest(NEW.batch_id) IS DISTINCT FROM b.approved_digest THEN
      RAISE EXCEPTION 'batch_changed' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'import_link' THEN
    NEW.committed_at := pg_catalog.now();
  ELSE
    NEW.created_at := pg_catalog.now();
  END IF;
  RETURN NEW;
END $$;
RESET ROLE;
GRANT UPDATE (purged_at, analysed_at) ON eureka.import_batch TO eureka_import; -- FOR SHARE in the row guard

-- ---------- loader policies: the marker, not a setting ----------
DROP POLICY import_load_insert ON eureka.person;
DROP POLICY import_load_insert ON eureka.candidate;
DROP POLICY import_load_insert ON eureka.submission;
DROP POLICY import_load_insert ON eureka.interview;
DROP POLICY import_load_update ON eureka.interview;
DROP POLICY import_load_audit ON eureka.audit_event;
CREATE POLICY import_load_insert ON eureka.person FOR INSERT TO authz_definer WITH CHECK (
  (SELECT authz.import_active()) AND (SELECT authz.has_perm('candidate:create')));
CREATE POLICY import_load_insert ON eureka.candidate FOR INSERT TO authz_definer WITH CHECK (
  (SELECT authz.import_active())
  AND ((SELECT authz.has_org('candidate:create'))
       OR team_id = ANY ((SELECT authz.team_ids('candidate:create'))::uuid[])
       OR (recruiter_id = ANY ((SELECT authz.recruiter_ids('candidate:create'))::uuid[])
           AND team_id = (SELECT authz.actor_team()))));
CREATE POLICY import_load_insert ON eureka.submission FOR INSERT TO authz_definer WITH CHECK (
  (SELECT authz.import_active())
  AND recruiter_id = (SELECT authz.current_user_id())
  AND authz.candidate_visible(candidate_id, 'submission:create'));
CREATE POLICY import_load_insert ON eureka.interview FOR INSERT TO authz_definer WITH CHECK (
  (SELECT authz.import_active())
  AND (SELECT authz.has_perm('interview:create'))
  AND EXISTS (SELECT 1 FROM eureka.submission s WHERE s.id = submission_id
              AND authz.owns('submission:update', s.recruiter_id, s.team_id, s.location_id)));
CREATE POLICY import_load_update ON eureka.interview FOR UPDATE TO authz_definer
  USING ((SELECT authz.import_active()) AND authz.owns('interview:update', recruiter_id, team_id, location_id))
  WITH CHECK (authz.owns('interview:update', recruiter_id, team_id, location_id));
CREATE POLICY import_load_audit ON eureka.audit_event FOR INSERT TO authz_definer WITH CHECK (
  (SELECT authz.import_active()) AND changes ->> 'source' = 'import');

-- The loader of 0033 with: approver and operator re-checked, the verified
-- digest recorded on the marker row, and placements only when the batch loads them.
SET ROLE authz_definer;
-- CLI (eureka_import): loads one person - a clean sales row, or new activity
-- for a person loaded earlier (p_row is then one of its rows) - with all its
-- clean rows. p_dry_run does the same work and always rolls back (raises
-- 'import_dry_run' with the counts as DETAIL).
CREATE OR REPLACE FUNCTION authz.import_load_person(p_batch uuid, p_row uuid, p_dry_run boolean) RETURNS jsonb
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
    -- 0041: the approver and the operator must still be active org admins.
    IF NOT authz.import_is_admin(b.approved_by) OR NOT authz.import_is_admin(b.operator_id) THEN
      RAISE EXCEPTION 'approval_not_valid' USING ERRCODE = 'insufficient_privilege';
    END IF;
    UPDATE eureka.import_session SET verified_batch = p_batch
     WHERE xact = pg_catalog.pg_current_xact_id() AND pid = pg_catalog.pg_backend_pid();
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
  IF NOT b.placements_commit AND EXISTS (SELECT 1 FROM eureka.import_row x WHERE x.id = ANY (ids) AND x.sheet = 'placements') THEN
    RAISE EXCEPTION 'placements_disabled' USING ERRCODE = 'check_violation';
  END IF;
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
RESET ROLE;

-- ---------- 6. rows from before 0033: backfill, then validate its constraints ----------
SET ROLE eureka_owner;
ALTER TABLE eureka.import_batch DISABLE TRIGGER import_batch_guard;
ALTER TABLE eureka.import_decision DISABLE TRIGGER import_decision_guard;
RESET ROLE;
SET ROLE authz_definer;
-- An approval without a digest was given under 0028's rules: withdraw it.
UPDATE eureka.import_batch SET status = 'staged', approved_by = NULL, approved_at = NULL
 WHERE status = 'approved' AND approved_digest IS NULL;
UPDATE eureka.import_batch SET approved_digest = authz.import_batch_digest(id)
 WHERE status = 'committed' AND approved_digest IS NULL;
-- An old approval accepted no recorded reasons: it clears nothing.
UPDATE eureka.import_decision SET approved_reasons = '{}' WHERE action = 'approve' AND approved_reasons IS NULL;
RESET ROLE;
SET ROLE eureka_owner;
ALTER TABLE eureka.import_batch ENABLE TRIGGER import_batch_guard;
ALTER TABLE eureka.import_decision ENABLE TRIGGER import_decision_guard;
ALTER TABLE eureka.import_batch VALIDATE CONSTRAINT import_batch_digest;
ALTER TABLE eureka.import_decision VALIDATE CONSTRAINT import_decision_reasons;
RESET ROLE;

-- ---------- privileges ----------
DO $$
DECLARE f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'authz' AND (p.proname LIKE 'import\_%' OR p.proname = 'current_user_id')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION authz.import_approve_batch(uuid, text), authz.import_load_preview(uuid) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.import_open_batch(text, text, jsonb, boolean) TO eureka_import;
