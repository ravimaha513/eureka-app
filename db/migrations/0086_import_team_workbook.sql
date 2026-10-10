-- Sheet import: team workbooks (docs/import.md "Team workbooks").
--
-- Recruiting teams log submissions, interviews and placements in Google Sheets
-- with recruiter names, no candidate emails and free-text clients/vendors.
--  1. A fourth sheet, `submissions`: one submission per row, with its own
--     date (submitted_at, noon of that day in the mapping's time zone) and rate.
--     Natural key: candidate, client, job title, vendor, date.
--  2. Interview and placement rows attach to the candidate's imported
--     submission for the same client and job title (same vendor first, then the
--     latest); otherwise a submission is created as before.
--  3. Owners: an email, else the mapping's `owners` list (name -> email), else
--     the display name of exactly one active user (authz.import_owner; the
--     analysis in apps/api/src/import/analyze.ts does the same).
--  4. Clients, vendors and implementation partners missing from the reference
--     lists are added by the loader when the batch's mapping allows it
--     (references.create); the preview lists every new name for the approver.
--     The definer may insert reference rows only while an import loads.
--  5. `inferred_client` (an interview whose client was inferred, not in the
--     sheet) is approvable.
-- Rules 1-7 of docs/HANDOFF.md apply.
SET search_path = eureka, public;

-- ---------- 1. sheet and key kinds ----------
SET ROLE eureka_owner;
ALTER TABLE eureka.import_row DROP CONSTRAINT import_row_sheet_check;
ALTER TABLE eureka.import_row ADD CONSTRAINT import_row_sheet_check
  CHECK (sheet IN ('sales', 'submissions', 'interviews', 'placements'));
ALTER TABLE eureka.import_decision DROP CONSTRAINT import_decision_sheet_check;
ALTER TABLE eureka.import_decision ADD CONSTRAINT import_decision_sheet_check
  CHECK (sheet IN ('sales', 'submissions', 'interviews', 'placements'));
ALTER TABLE eureka.import_link DROP CONSTRAINT import_link_sheet_check;
ALTER TABLE eureka.import_link ADD CONSTRAINT import_link_sheet_check
  CHECK (sheet IN ('sales', 'submissions', 'interviews', 'placements', 'submission'));
ALTER TABLE eureka.import_natural_key DROP CONSTRAINT import_natural_key_kind_check;
ALTER TABLE eureka.import_natural_key ADD CONSTRAINT import_natural_key_kind_check
  CHECK (kind IN ('interview', 'placement', 'submission'));

-- ---------- 4. reference lists: the definer adds names only during an import load ----------
CREATE FUNCTION eureka.reference_insert_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  -- authz_definer: only inside an import call (the 0041 session marker).
  IF current_user = 'authz_definer' THEN
    IF NOT coalesce(authz.import_active(), false) THEN
      RAISE EXCEPTION 'server_managed_field' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  IF NEW.name IS NULL OR pg_catalog.btrim(NEW.name) = '' OR pg_catalog.char_length(NEW.name) > 200 THEN
    RAISE EXCEPTION 'invalid_name' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION eureka.reference_insert_guard() FROM PUBLIC;
CREATE TRIGGER client_insert_guard BEFORE INSERT ON eureka.client
  FOR EACH ROW EXECUTE FUNCTION eureka.reference_insert_guard();
CREATE TRIGGER vendor_insert_guard BEFORE INSERT ON eureka.vendor
  FOR EACH ROW EXECUTE FUNCTION eureka.reference_insert_guard();
CREATE TRIGGER implementation_partner_insert_guard BEFORE INSERT ON eureka.implementation_partner
  FOR EACH ROW EXECUTE FUNCTION eureka.reference_insert_guard();
CREATE INDEX IF NOT EXISTS client_lower_name ON eureka.client (pg_catalog.lower(name));
CREATE INDEX IF NOT EXISTS vendor_lower_name ON eureka.vendor (pg_catalog.lower(name));
CREATE INDEX IF NOT EXISTS implementation_partner_lower_name ON eureka.implementation_partner (pg_catalog.lower(name));
RESET ROLE;

GRANT SELECT (id, name), INSERT (name) ON eureka.client, eureka.vendor, eureka.implementation_partner TO authz_definer;
GRANT INSERT (submitted_at, rate) ON eureka.submission TO authz_definer;
-- Owner cells holding names, and the owner's location for sheets without one.
GRANT SELECT (display_name, primary_location_id) ON eureka.app_user TO eureka_import;
GRANT SELECT (display_name) ON eureka.app_user TO authz_definer;

-- ---------- definer functions ----------
SET ROLE authz_definer;

-- 3. The owner a cell names (NULL when none or not exactly one active user).
CREATE FUNCTION authz.import_owner(p_cell text, p_mapping jsonb) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH c AS (SELECT pg_catalog.btrim(coalesce(p_cell, '')) AS v),
  e AS (
    SELECT CASE
      WHEN c.v = '' THEN NULL
      WHEN pg_catalog.strpos(c.v, '@') > 0 THEN pg_catalog.lower(c.v)
      ELSE pg_catalog.lower(authz.import_map_entry(p_mapping -> 'owners', authz.import_label(c.v)) #>> '{}') END AS email,
      c.v FROM c)
  SELECT CASE
    WHEN e.email IS NOT NULL THEN
      (SELECT u.id FROM eureka.app_user u WHERE pg_catalog.lower(u.email::text) = e.email AND u.status = 'active')
    WHEN e.v <> '' AND pg_catalog.strpos(e.v, '@') = 0 THEN
      (SELECT pg_catalog.min(u.id::text)::uuid FROM eureka.app_user u
        WHERE u.status = 'active' AND authz.import_label(u.display_name) = authz.import_label(e.v)
       HAVING count(*) = 1)
    END
  FROM e
$$;

-- Must match approvable() in apps/api/src/import/analyze.ts.
CREATE OR REPLACE FUNCTION authz.import_reason_approvable(p_reason text) RETURNS boolean
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce(p_reason IN ('probable_duplicate', 'possible_duplicate_name', 'matches_existing_candidate',
                               'name_only_match', 'name_dob_match', 'matches_imported_person', 'inferred_client')
      OR pg_catalog.split_part(p_reason, ':', 2) IN ('phone', 'personalEmail', 'marketingEmail', 'email', 'dob',
           'priority', 'marketingStartDate', 'vendor', 'implementationPartner', 'rate', 'projectCity',
           'projectState', 'statusReason'), false)
$$;

-- A reference row's group key in a person's rows: its id, or its new name.
CREATE FUNCTION authz.import_client_key(p_norm jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce(p_norm ->> 'clientId', 'name:' || pg_catalog.lower(p_norm ->> 'clientName'))
$$;

-- 4. Loader helper: the id of a reference row, adding a new name (the batch's
-- mapping must allow it; verified before approval). Case-insensitive.
CREATE FUNCTION authz.import_ref(p_kind text, p_id text, p_name text, p_batch uuid, p_operator uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE r uuid; nm text := pg_catalog.btrim(coalesce(p_name, ''));
BEGIN
  IF p_id IS NOT NULL THEN RETURN p_id::uuid; END IF;
  IF nm = '' THEN RETURN NULL; END IF;
  IF p_kind = 'client' THEN
    SELECT x.id INTO r FROM eureka.client x WHERE pg_catalog.lower(x.name) = pg_catalog.lower(nm) ORDER BY x.name LIMIT 1;
    IF r IS NOT NULL THEN RETURN r; END IF;
    INSERT INTO eureka.client (name) VALUES (nm) RETURNING id INTO r;
  ELSIF p_kind = 'vendor' THEN
    SELECT x.id INTO r FROM eureka.vendor x WHERE pg_catalog.lower(x.name) = pg_catalog.lower(nm) ORDER BY x.name LIMIT 1;
    IF r IS NOT NULL THEN RETURN r; END IF;
    INSERT INTO eureka.vendor (name) VALUES (nm) RETURNING id INTO r;
  ELSIF p_kind = 'partner' THEN
    SELECT x.id INTO r FROM eureka.implementation_partner x WHERE pg_catalog.lower(x.name) = pg_catalog.lower(nm) ORDER BY x.name LIMIT 1;
    IF r IS NOT NULL THEN RETURN r; END IF;
    INSERT INTO eureka.implementation_partner (name) VALUES (nm) RETURNING id INTO r;
  ELSE
    RAISE EXCEPTION 'invalid_reference_kind' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM authz.import_audit(p_kind || '.created', p_kind, r, '{}'::jsonb, p_batch, p_operator);
  RETURN r;
END $$;

-- What the database can check about a batch (0041), with owners resolved as
-- authz.import_owner, submission rows, and new reference names only where the
-- batch's mapping allows creating them.
CREATE OR REPLACE FUNCTION authz.import_verify_batch(p_batch uuid) RETURNS TABLE (sheet text, row_no integer, problem text)
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
    SELECT r.id, authz.import_owner(r.owner_cell, m) AS cell_owner
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
    -- submission, interview and placement rows: person and owner
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
     WHERE r.sheet = 'placements' AND r.state = 'clean' AND NOT coalesce(pc, false)
    UNION ALL
    -- new reference names only where the mapping allows creating them
    SELECT r.sheet, r.row_no, 'reference_not_allowed' FROM r
     WHERE r.state = 'clean' AND (
           (coalesce(r.norm ->> 'clientName', '') <> '' AND NOT coalesce((m #>> '{references,create,clients}')::boolean, false))
        OR (coalesce(r.norm ->> 'vendorName', '') <> '' AND NOT coalesce((m #>> '{references,create,vendors}')::boolean, false))
        OR (coalesce(r.norm ->> 'partnerName', '') <> '' AND NOT coalesce((m #>> '{references,create,partners}')::boolean, false))))
  SELECT p.sheet, p.row_no, p.problem FROM problems p ORDER BY 1, 2, 3;
END $$;

-- API preview (0041) with submissions and the new reference names.
CREATE OR REPLACE FUNCTION authz.import_load_preview(p_batch uuid) RETURNS jsonb
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
      ORDER BY pg_catalog.array_position(ARRAY['sales','submissions','interviews','placements'], r.sheet), r.row_no)
      FROM eureka.import_row r WHERE r.batch_id = p_batch AND r.state = 'clean'), '[]'),
    'perOwner', coalesce((SELECT pg_catalog.jsonb_agg(x ORDER BY x ->> 'owner') FROM (
        SELECT pg_catalog.jsonb_build_object('owner', u.email::text,
                 'candidates', count(*) FILTER (WHERE r.sheet = 'sales'),
                 'submissions', count(*) FILTER (WHERE r.sheet = 'submissions'),
                 'interviews', count(*) FILTER (WHERE r.sheet = 'interviews'),
                 'placements', count(*) FILTER (WHERE r.sheet = 'placements'),
                 'allTeams', count(*) FILTER (WHERE r.sheet = 'sales' AND r.norm ->> 'visibility' = 'all_teams')) AS x
          FROM eureka.import_row r LEFT JOIN eureka.app_user u ON u.id::text = r.norm ->> 'ownerId'
         WHERE r.batch_id = p_batch AND r.state = 'clean' GROUP BY u.email) o), '[]'),
    -- Names the loader would add to the reference lists, once per spelling ignoring case.
    'newReferences', pg_catalog.jsonb_build_object(
      'clients', coalesce((SELECT pg_catalog.jsonb_agg(n.v ORDER BY n.v) FROM (
          SELECT pg_catalog.min(r.norm ->> 'clientName') AS v FROM eureka.import_row r
           WHERE r.batch_id = p_batch AND r.state = 'clean' AND coalesce(r.norm ->> 'clientName', '') <> ''
           GROUP BY pg_catalog.lower(r.norm ->> 'clientName')) n
         WHERE NOT EXISTS (SELECT 1 FROM eureka.client c WHERE pg_catalog.lower(c.name) = pg_catalog.lower(n.v))), '[]'),
      'vendors', coalesce((SELECT pg_catalog.jsonb_agg(n.v ORDER BY n.v) FROM (
          SELECT pg_catalog.min(r.norm ->> 'vendorName') AS v FROM eureka.import_row r
           WHERE r.batch_id = p_batch AND r.state = 'clean' AND coalesce(r.norm ->> 'vendorName', '') <> ''
           GROUP BY pg_catalog.lower(r.norm ->> 'vendorName')) n
         WHERE NOT EXISTS (SELECT 1 FROM eureka.vendor c WHERE pg_catalog.lower(c.name) = pg_catalog.lower(n.v))), '[]'),
      'partners', coalesce((SELECT pg_catalog.jsonb_agg(n.v ORDER BY n.v) FROM (
          SELECT pg_catalog.min(r.norm ->> 'partnerName') AS v FROM eureka.import_row r
           WHERE r.batch_id = p_batch AND r.state = 'clean' AND coalesce(r.norm ->> 'partnerName', '') <> ''
           GROUP BY pg_catalog.lower(r.norm ->> 'partnerName')) n
         WHERE NOT EXISTS (SELECT 1 FROM eureka.implementation_partner c WHERE pg_catalog.lower(c.name) = pg_catalog.lower(n.v))), '[]')),
    'problems', coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('sheet', v.sheet, 'rowNo', v.row_no, 'problem', v.problem))
      FROM authz.import_verify_batch(p_batch) v), '[]'));
END $$;

CREATE OR REPLACE FUNCTION authz.import_review_rows(p_batch uuid)
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
  ORDER BY pg_catalog.array_position(ARRAY['sales','submissions','interviews','placements'], r.sheet), r.row_no;
END $$;

-- CLI (eureka_import): loads one person with all its clean rows (0033, 0041),
-- now with submission rows, activity attached to imported submissions, and
-- reference names added on demand.
CREATE OR REPLACE FUNCTION authz.import_load_person(p_batch uuid, p_row uuid, p_dry_run boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  dry constant boolean := coalesce(p_dry_run, true);
  ppath constant text[] := ARRAY['confirmed','paperwork','bgc','ready','joined'];
  b record; anchor record; r record; g record; ex record; p record; tr record;
  s jsonb; n jsonb; pkey text; owner uuid; cand uuid; team uuid; person uuid; vis text; tgt text; cur text;
  sub_id uuid; sub_owner uuid; nk text; iv uuid; starts timestamptz; ends timestamptz; pl uuid; pst text;
  steps text[]; reason text; h text; ids uuid[];
  cl uuid; vd uuid; pt uuid; sub_at timestamptz; made uuid[] := '{}';
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
  IF NOT b.placements_commit AND EXISTS (SELECT 1 FROM eureka.import_row x WHERE x.id = ANY (ids) AND x.sheet = 'placements') THEN
    RAISE EXCEPTION 'placements_disabled' USING ERRCODE = 'check_violation';
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

  -- ---------- submission rows: one submission each, oldest first ----------
  FOR r IN SELECT * FROM eureka.import_row l WHERE l.id = ANY (ids) AND l.sheet = 'submissions'
             ORDER BY l.norm ->> 'submittedOn', l.row_no LOOP
    cl := authz.import_ref('client', r.norm ->> 'clientId', r.norm ->> 'clientName', p_batch, b.operator_id);
    vd := authz.import_ref('vendor', r.norm ->> 'vendorId', r.norm ->> 'vendorName', p_batch, b.operator_id);
    sub_at := ((r.norm ->> 'submittedOn')::date + time '12:00') AT TIME ZONE coalesce(r.norm ->> 'timeZone', 'America/Chicago');
    IF sub_at IS NULL OR sub_at > pg_catalog.now() THEN
      RAISE EXCEPTION 'invalid_submission_date' USING ERRCODE = 'check_violation';
    END IF;
    nk := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('submission|' || cand::text || '|' || cl::text || '|'
          || pg_catalog.lower(r.norm ->> 'jobTitle') || '|' || coalesce(vd::text, '') || '|' || (r.norm ->> 'submittedOn'), 'UTF8')), 'hex');
    sub_id := NULL;
    SELECT k.entity_id INTO sub_id FROM eureka.import_natural_key k WHERE k.kind = 'submission' AND k.key_hash = nk;
    IF sub_id IS NULL THEN
      SELECT x.id INTO sub_id FROM eureka.submission x WHERE x.id = ANY (made) AND x.candidate_id = cand AND x.client_id = cl
         AND pg_catalog.lower(x.job_title) = pg_catalog.lower(r.norm ->> 'jobTitle') AND x.vendor_id IS NOT DISTINCT FROM vd
         AND x.submitted_at = sub_at LIMIT 1;
    END IF;
    IF sub_id IS NULL THEN
      sub_owner := coalesce((r.norm ->> 'ownerId')::uuid, owner);
      PERFORM authz.import_act_as(sub_owner);
      INSERT INTO eureka.submission (candidate_id, job_title, client_id, vendor_id, rate, submitted_at)
      VALUES (cand, r.norm ->> 'jobTitle', cl, vd, (r.norm ->> 'rate')::numeric, sub_at) RETURNING id INTO sub_id;
      made := made || sub_id;
      PERFORM authz.import_audit('submission.created', 'submission', sub_id,
        pg_catalog.jsonb_build_object('candidateId', cand, 'clientId', cl, 'submittedOn', r.norm ->> 'submittedOn'), p_batch, b.operator_id);
      counts := pg_catalog.jsonb_set(counts, '{submissions}', pg_catalog.to_jsonb((counts ->> 'submissions')::int + 1));
      IF NOT dry THEN
        INSERT INTO eureka.import_natural_key (kind, key_hash, entity_id, batch_id) VALUES ('submission', nk, sub_id, p_batch);
      END IF;
    END IF;
    IF NOT dry THEN
      INSERT INTO eureka.import_link (sheet, row_key, entity_type, entity_id, owner_id, batch_id)
      VALUES ('submissions', r.row_key, 'submission', sub_id, coalesce((r.norm ->> 'ownerId')::uuid, owner), p_batch);
      UPDATE eureka.import_row SET state = 'committed', committed_entity = sub_id WHERE id = r.id;
    END IF;
  END LOOP;

  -- ---------- interviews and placements, per client and job title ----------
  FOR g IN SELECT authz.import_client_key(l.norm) AS ckey, pg_catalog.lower(l.norm ->> 'jobTitle') AS job, min(l.row_no) AS first_no
             FROM eureka.import_row l WHERE l.id = ANY (ids) AND l.sheet IN ('interviews', 'placements') GROUP BY 1, 2 ORDER BY 3 LOOP
    SELECT l.norm INTO n FROM eureka.import_row l WHERE l.id = ANY (ids) AND l.sheet IN ('interviews', 'placements')
       AND authz.import_client_key(l.norm) = g.ckey AND pg_catalog.lower(l.norm ->> 'jobTitle') = g.job
     ORDER BY l.row_no LIMIT 1;
    cl := authz.import_ref('client', n ->> 'clientId', n ->> 'clientName', p_batch, b.operator_id);
    vd := authz.import_ref('vendor', n ->> 'vendorId', n ->> 'vendorName', p_batch, b.operator_id);
    -- An earlier import's submission for this client and job (0033), else one
    -- loaded from a submission row (this call or an earlier batch): same vendor
    -- first, then the latest.
    nk := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(cand::text || '|' || cl::text || '|' || g.job, 'UTF8')), 'hex');
    sub_id := NULL; sub_owner := NULL;
    SELECT k.entity_id, k.owner_id INTO sub_id, sub_owner FROM eureka.import_link k WHERE k.sheet = 'submission' AND k.row_key = nk;
    IF sub_id IS NULL THEN
      SELECT x.id, x.recruiter_id INTO sub_id, sub_owner FROM eureka.submission x
       WHERE x.candidate_id = cand AND x.client_id = cl AND pg_catalog.lower(x.job_title) = g.job
         AND x.status NOT IN ('rejected', 'withdrawn')
         AND (x.id = ANY (made) OR EXISTS (SELECT 1 FROM eureka.import_natural_key k WHERE k.kind = 'submission' AND k.entity_id = x.id))
       ORDER BY (x.vendor_id IS NOT DISTINCT FROM vd) DESC, x.submitted_at DESC LIMIT 1;
    END IF;
    IF sub_id IS NULL THEN
      sub_owner := coalesce((n ->> 'ownerId')::uuid, owner);
      PERFORM authz.import_act_as(sub_owner);
      INSERT INTO eureka.submission (candidate_id, job_title, client_id, vendor_id)
      VALUES (cand, n ->> 'jobTitle', cl, vd) RETURNING id INTO sub_id;
      made := made || sub_id;
      PERFORM authz.import_audit('submission.created', 'submission', sub_id,
        pg_catalog.jsonb_build_object('candidateId', cand, 'clientId', cl), p_batch, b.operator_id);
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
    IF EXISTS (SELECT 1 FROM eureka.import_row l WHERE l.id = ANY (ids) AND l.sheet = 'interviews'
               AND authz.import_client_key(l.norm) = g.ckey AND pg_catalog.lower(l.norm ->> 'jobTitle') = g.job) THEN
      PERFORM authz.import_walk_submission(sub_id, 'interview_scheduled', p_batch, b.operator_id);
    END IF;
    FOR r IN SELECT * FROM eureka.import_row l WHERE l.id = ANY (ids) AND l.sheet = 'interviews'
               AND authz.import_client_key(l.norm) = g.ckey AND pg_catalog.lower(l.norm ->> 'jobTitle') = g.job
             ORDER BY l.norm ->> 'startLocal', l.row_no LOOP
      starts := (r.norm ->> 'startLocal')::timestamp AT TIME ZONE (r.norm ->> 'timeZone');
      ends := starts + pg_catalog.make_interval(mins => (r.norm ->> 'minutes')::integer);
      nk := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('interview|' || cand::text || '|' || cl::text || '|'
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

    IF EXISTS (SELECT 1 FROM eureka.import_row l WHERE l.id = ANY (ids) AND l.sheet = 'placements'
               AND authz.import_client_key(l.norm) = g.ckey AND pg_catalog.lower(l.norm ->> 'jobTitle') = g.job) THEN
      PERFORM authz.import_walk_submission(sub_id, 'selected', p_batch, b.operator_id);
    ELSIF EXISTS (SELECT 1 FROM eureka.import_row l WHERE l.id = ANY (ids) AND l.sheet = 'interviews'
                  AND authz.import_client_key(l.norm) = g.ckey AND pg_catalog.lower(l.norm ->> 'jobTitle') = g.job
                  AND l.norm ->> 'callStatus' = 'completed') THEN
      PERFORM authz.import_walk_submission(sub_id, 'interview_completed', p_batch, b.operator_id);
    END IF;

    -- Placements: a backout first (it frees the submission), then the rest.
    FOR r IN SELECT * FROM eureka.import_row l WHERE l.id = ANY (ids) AND l.sheet = 'placements'
               AND authz.import_client_key(l.norm) = g.ckey AND pg_catalog.lower(l.norm ->> 'jobTitle') = g.job
             ORDER BY (l.norm ->> 'status' = 'backout') DESC, l.row_no LOOP
      tgt := r.norm ->> 'status';
      pt := authz.import_ref('partner', r.norm ->> 'partnerId', r.norm ->> 'partnerName', p_batch, b.operator_id);
      nk := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('placement|' || sub_id::text || '|' || (r.norm ->> 'tentativeStart'), 'UTF8')), 'hex');
      pl := NULL;
      SELECT k.entity_id INTO pl FROM eureka.import_natural_key k WHERE k.kind = 'placement' AND k.key_hash = nk;
      IF pl IS NULL THEN
        SELECT * INTO p FROM authz.create_placement(sub_id, r.norm ->> 'placementType', (r.norm ->> 'rate')::numeric,
          r.norm ->> 'workMode', r.norm ->> 'projectCity', r.norm ->> 'projectState', (r.norm ->> 'tentativeStart')::date,
          pt, NULL);
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

-- ---------- privileges ----------
DO $$
DECLARE f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'authz' AND p.proname LIKE 'import\_%'
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION authz.import_approve_batch(uuid, text), authz.import_load_preview(uuid),
  authz.import_review_rows(uuid) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.import_load_person(uuid, uuid, boolean) TO eureka_import;
