-- 0270: import the company Hot List sheet (docs/import.md "Hot List sheet").
--
-- The sheet names recruiters and leads, not emails, and carries the team
-- (Lead), who markets the candidate (Marketing Teams), the guest house (GH),
-- the marketed visa and the in-person flag. Staging (apps/api/src/import/
-- analyze.ts) resolves those; this migration lets the database re-check and
-- load them:
--   1. eureka_import reads staff display names and teams (to resolve names).
--   2. authz.import_owner_for / authz.import_team_for: the same resolution
--      rules as staging, used by verification.
--   3. authz.import_verify_batch also checks the team and the visibility /
--      shared teams derived from the Marketing Teams cell.
--   4. authz.import_load_person puts the candidate in the row's team (the
--      owner's team when the sheet has none), shares it with the selected
--      team, and writes visa, guest house and in-person.
--   5. authz.import_reason_approvable: visa, guestHouse and inPerson values
--      may be dropped on approval, like priority.

-- ---------- 1. reference data for staging ----------
GRANT SELECT (display_name) ON eureka.app_user TO eureka_import;
GRANT SELECT (id, name, lead_id, location_id) ON eureka.team TO eureka_import;
GRANT UPDATE (visa_category, gh_location_id, gh_remote, in_person_ok) ON eureka.candidate TO authz_definer;

SET ROLE authz_definer;

-- ---------- 2. name resolution (mirrors RowNormalizer.owner / .team) ----------
-- Owner cell: an "owners" alias (-> email), an email, or the display name of
-- exactly one user. Only an active user counts.
CREATE FUNCTION authz.import_owner_for(p_map jsonb, p_cell text) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  cell constant text := pg_catalog.btrim(coalesce(p_cell, ''));
  alias text; ids uuid[]; act boolean;
BEGIN
  IF cell = '' THEN RETURN NULL; END IF;
  alias := authz.import_map_entry(p_map -> 'owners', authz.import_label(cell)) #>> '{}';
  IF alias IS NOT NULL OR pg_catalog.strpos(cell, '@') > 0 THEN
    RETURN (SELECT u.id FROM eureka.app_user u
             WHERE pg_catalog.lower(u.email::text) = pg_catalog.lower(coalesce(alias, cell)) AND u.status = 'active');
  END IF;
  SELECT pg_catalog.array_agg(u.id), pg_catalog.bool_and(u.status = 'active') INTO ids, act
    FROM eureka.app_user u WHERE authz.import_label(u.display_name) = authz.import_label(cell);
  RETURN CASE WHEN coalesce(pg_catalog.cardinality(ids), 0) = 1 AND coalesce(act, false) THEN ids[1] END;
END $$;

-- Team cell: a "teams" alias (-> team name), a team name, or the display name
-- of its lead; the first rule with a match decides, and it must be one team.
CREATE FUNCTION authz.import_team_for(p_map jsonb, p_cell text) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  k constant text := authz.import_label(p_cell);
  alias text; ids uuid[];
BEGIN
  IF k = '' THEN RETURN NULL; END IF;
  alias := authz.import_map_entry(p_map -> 'teams', k) #>> '{}';
  IF alias IS NOT NULL THEN
    SELECT pg_catalog.array_agg(t.id) INTO ids FROM eureka.team t WHERE authz.import_label(t.name) = authz.import_label(alias);
  ELSE
    SELECT pg_catalog.array_agg(t.id) INTO ids FROM eureka.team t WHERE authz.import_label(t.name) = k;
    IF ids IS NULL THEN
      SELECT pg_catalog.array_agg(t.id) INTO ids FROM eureka.team t JOIN eureka.app_user u ON u.id = t.lead_id
       WHERE authz.import_label(u.display_name) = k;
    END IF;
  END IF;
  RETURN CASE WHEN coalesce(pg_catalog.cardinality(ids), 0) = 1 THEN ids[1] END;
END $$;

-- ---------- 3. verification ----------
-- What the database can check about a batch's rows, from the stored cells
-- and the batch's own mapping. Empty means verified. 0270: owners by alias or
-- name, the team column, and visibility from the Marketing Teams column.
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
    SELECT r.id, authz.import_owner_for(m, r.owner_cell) AS cell_owner
      FROM r WHERE coalesce(r.owner_cell, '') <> ''),
  sales_map AS (
    SELECT r.id,
           coalesce(
             authz.import_map_entry(m -> 'statuses' -> 'sales',
               authz.import_label(authz.import_cell(r.raw, m -> 'sheets' -> 'sales' -> 'columns' ->> 'status'))),
             CASE WHEN authz.import_label(authz.import_cell(r.raw, m -> 'sheets' -> 'sales' -> 'columns' ->> 'status')) = ''
                  THEN authz.import_map_entry(m -> 'rowColors' -> 'sales',
                         authz.import_color(authz.import_cell(r.raw, m -> 'sheets' -> 'sales' -> 'columns' ->> 'rowColor'))) END) AS entry,
           authz.import_team_for(m, authz.import_cell(r.raw, m -> 'sheets' -> 'sales' -> 'columns' ->> 'team')) AS team,
           authz.import_cell(r.raw, m -> 'sheets' -> 'sales' -> 'columns' ->> 'sharedWith') AS shared_cell
      FROM r WHERE r.sheet = 'sales' AND r.state = 'clean'),
  -- Visibility and shares the row must carry: from the Marketing Teams cell
  -- ("All" labels, the own team, or one other team), else from the status entry.
  sharing AS (
    SELECT s.id, s.team,
           CASE WHEN authz.import_label(s.shared_cell) = '' THEN coalesce(s.entry ->> 'visibility', 'team')
                WHEN authz.import_label(s.shared_cell) IN (
                       SELECT authz.import_label(a) FROM pg_catalog.jsonb_array_elements_text(coalesce(m -> 'sharedWithAll', '[]')) a)
                  THEN 'all_teams'
                WHEN s.st IS NOT NULL AND s.st = s.team THEN 'team'
                WHEN s.st IS NOT NULL AND s.team IS NOT NULL THEN 'selected_teams' END AS visibility,
           CASE WHEN authz.import_label(s.shared_cell) <> '' AND s.st IS NOT NULL AND s.team IS NOT NULL AND s.st <> s.team
                  AND authz.import_label(s.shared_cell) NOT IN (
                       SELECT authz.import_label(a) FROM pg_catalog.jsonb_array_elements_text(coalesce(m -> 'sharedWithAll', '[]')) a)
                THEN pg_catalog.jsonb_build_array(s.st::text) ELSE '[]'::jsonb END AS shares
      FROM (SELECT sm.*, authz.import_team_for(m, sm.shared_cell) AS st FROM sales_map sm) s),
  problems AS (
    SELECT r.sheet, r.row_no, 'clean_with_reasons' AS problem FROM r
     WHERE r.state = 'clean' AND pg_catalog.cardinality(r.reasons) > 0
    UNION ALL
    SELECT r.sheet, r.row_no, 'state_without_reasons' FROM r
     WHERE r.state <> 'clean' AND pg_catalog.cardinality(r.reasons) = 0
    UNION ALL
    -- sales rows: owner, team, status, visibility, person and live duplicates
    SELECT r.sheet, r.row_no, 'owner_mismatch' FROM r LEFT JOIN owners o ON o.id = r.id
     WHERE r.sheet = 'sales' AND r.state = 'clean' AND (r.norm ->> 'ownerId') IS DISTINCT FROM o.cell_owner::text
    UNION ALL
    SELECT r.sheet, r.row_no, 'team_mismatch' FROM r JOIN sharing s ON s.id = r.id
     WHERE (r.norm ->> 'teamId') IS DISTINCT FROM s.team::text
    UNION ALL
    SELECT r.sheet, r.row_no, 'status_mismatch' FROM r JOIN sales_map s ON s.id = r.id
     WHERE (r.norm ->> 'status') IS DISTINCT FROM (s.entry ->> 'status')
    UNION ALL
    SELECT r.sheet, r.row_no, 'visibility_mismatch' FROM r JOIN sharing s ON s.id = r.id
     WHERE coalesce(r.norm ->> 'visibility', 'team') IS DISTINCT FROM s.visibility
        OR coalesce(r.norm -> 'shareTeamIds', '[]'::jsonb) IS DISTINCT FROM s.shares
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

-- ---------- 5. droppable field reasons (must match DROPPABLE_FIELDS in analyze.ts) ----------
CREATE OR REPLACE FUNCTION authz.import_reason_approvable(p_reason text) RETURNS boolean
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce(p_reason IN ('probable_duplicate', 'possible_duplicate_name', 'matches_existing_candidate',
                               'name_only_match', 'name_dob_match', 'matches_imported_person')
      OR pg_catalog.split_part(p_reason, ':', 2) IN ('phone', 'personalEmail', 'marketingEmail', 'email', 'dob',
           'priority', 'marketingStartDate', 'vendor', 'implementationPartner', 'rate', 'projectCity',
           'projectState', 'statusReason', 'visa', 'guestHouse', 'inPerson'), false)
$$;

-- ---------- 4. loading ----------
-- 0270: the row's team, Marketing Teams shares, visa, guest house and in-person.
CREATE OR REPLACE FUNCTION authz.import_load_person(p_batch uuid, p_row uuid, p_dry_run boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  dry constant boolean := coalesce(p_dry_run, true);
  ppath constant text[] := ARRAY['confirmed','paperwork','bgc','ready','joined'];
  b record; anchor record; r record; g record; ex record; p record; tr record;
  s jsonb; n jsonb; pkey text; owner uuid; cand uuid; team uuid; person uuid; vis text; tgt text; cur text;
  sub_id uuid; sub_owner uuid; nk text; iv uuid; starts timestamptz; ends timestamptz; pl uuid; pst text;
  steps text[]; reason text; h text; ids uuid[]; nshares integer;
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
    -- 0270: the sheet's team (verified against the team cell), else the owner's.
    -- The candidate insert policy still requires the owner may create there.
    team := coalesce((s ->> 'teamId')::uuid, authz.actor_team());
    IF team IS NULL THEN RAISE EXCEPTION 'owner_has_no_team' USING ERRCODE = 'check_violation'; END IF;
    vis := CASE WHEN s ->> 'visibility' IN ('all_teams', 'selected_teams') THEN s ->> 'visibility' ELSE 'team' END;
    person := pg_catalog.gen_random_uuid();
    INSERT INTO eureka.person (id, first_name, last_name, phone_e164, personal_email)
    VALUES (person, s ->> 'firstName', s ->> 'lastName', nullif(s ->> 'phone', ''), nullif(s ->> 'personalEmail', ''));
    INSERT INTO eureka.candidate (person_id, technology_id, team_id, recruiter_id, location_id, visibility)
    VALUES (person, (s ->> 'technologyId')::uuid, team,
            CASE WHEN EXISTS (SELECT 1 FROM eureka.user_role ur WHERE ur.user_id = owner AND ur.role_key = 'recruiter'
                              AND ur.valid @> pg_catalog.now()) THEN owner END,
            (s ->> 'locationId')::uuid, vis)
    RETURNING id INTO cand;
    -- Visibility and shared teams are part of the approved batch (the sheet's
    -- "Active/All Teams" status, or its Marketing Teams column; 0270).
    nshares := 0;
    IF vis = 'selected_teams' THEN
      INSERT INTO eureka.candidate_team_share (candidate_id, team_id)
      SELECT DISTINCT cand, x::uuid FROM pg_catalog.jsonb_array_elements_text(coalesce(s -> 'shareTeamIds', '[]')) x
       WHERE x::uuid IS DISTINCT FROM team;
      GET DIAGNOSTICS nshares = ROW_COUNT;
      IF coalesce(nshares, 0) = 0 THEN RAISE EXCEPTION 'teams_required' USING ERRCODE = 'check_violation'; END IF;
    END IF;
    PERFORM authz.import_audit('candidate.created', 'candidate', cand,
      pg_catalog.jsonb_build_object('visibility', vis, 'sharedTeams', nshares), p_batch, b.operator_id);
    IF coalesce(s ->> 'priority', s ->> 'marketingEmail', s ->> 'marketingStartDate', s ->> 'visaCategory',
                s ->> 'ghLocationId', s ->> 'inPersonOk') IS NOT NULL OR coalesce((s ->> 'ghRemote')::boolean, false) THEN
      UPDATE eureka.candidate SET priority = coalesce(s ->> 'priority', priority),
             marketing_email = coalesce(s ->> 'marketingEmail', marketing_email::text),
             marketing_start_date = coalesce((s ->> 'marketingStartDate')::date, marketing_start_date),
             visa_category = coalesce(s ->> 'visaCategory', visa_category),
             gh_location_id = coalesce((s ->> 'ghLocationId')::uuid, gh_location_id),
             gh_remote = coalesce((s ->> 'ghRemote')::boolean, false) OR gh_remote,
             in_person_ok = coalesce((s ->> 'inPersonOk')::boolean, in_person_ok)
       WHERE id = cand;
      -- Field names only (rule 5).
      PERFORM authz.import_audit('candidate.updated', 'candidate', cand, pg_catalog.jsonb_build_object('fields',
        (SELECT pg_catalog.jsonb_agg(f) FROM pg_catalog.unnest(ARRAY['priority','marketingEmail','marketingStartDate',
           'visaCategory','ghLocationId','ghRemote','inPersonOk']) f
          WHERE CASE WHEN f = 'ghRemote' THEN coalesce((s ->> f)::boolean, false) ELSE s ->> f IS NOT NULL END)), p_batch, b.operator_id);
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

-- ---------- privileges ----------
REVOKE ALL ON FUNCTION authz.import_owner_for(jsonb, text), authz.import_team_for(jsonb, text) FROM PUBLIC;
