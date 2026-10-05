-- CrewNex consolidation C1a.3 (docs/crewnex-consolidation.md section 6, 4.6):
-- where a batch comes from and whether it replays history. Builds on 0041.
--
--  1. eureka.import_batch.source ('sheets' | 'crewnex') and .historical are
--     fixed when the batch opens (authz.import_open_batch, from the CLI's
--     stage flags) and immutable afterwards (import_batch_guard), exactly like
--     placements_commit. No role holds a column privilege on them; the guard
--     refuses even the table owner.
--  2. Both are part of authz.import_batch_digest and shown in the preview, so
--     an approver signs them. The digest formula changes for every batch, so
--     every approval given before this migration no longer matches what the
--     loader recomputes: it is withdrawn here (back to staged, as the guard's
--     approved -> staged edge does) rather than left to fail as batch_changed
--     with no way back to approval. Committed batches keep their recorded
--     digest; nothing re-checks it.
--  3. eureka.import_session.active_batch: set by authz.import_load_person at
--     the start of every call, dry run or not (verified_batch is written only
--     on the commit path). authz.import_historical() reads the batch's flag
--     through it, so a dry run of a historical batch takes the same path as
--     its commit. The loader reports the mode it ran in ('historical').
--     Nothing reads import_historical() yet: C1e.1 adds the side-effect rules.
-- Rules 1-7 of docs/HANDOFF.md apply.
SET search_path = eureka, public;

-- ---------- columns ----------
SET ROLE eureka_owner;
ALTER TABLE eureka.import_batch
  ADD COLUMN source text NOT NULL DEFAULT 'sheets',
  ADD COLUMN historical boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT import_batch_source CHECK (source IN ('sheets', 'crewnex'));
ALTER TABLE eureka.import_session ADD COLUMN active_batch uuid;

-- source and historical are fixed when the batch opens, like placements_commit.
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

  IF (NEW.id, NEW.source_digest, NEW.files, NEW.operator_id, NEW.created_at, NEW.placements_commit, NEW.source, NEW.historical)
     IS DISTINCT FROM (OLD.id, OLD.source_digest, OLD.files, OLD.operator_id, OLD.created_at, OLD.placements_commit,
                       OLD.source, OLD.historical) THEN
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
RESET ROLE;

SET ROLE authz_definer;

CREATE OR REPLACE FUNCTION authz.import_begin() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  INSERT INTO eureka.import_session (xact, pid) VALUES (pg_catalog.pg_current_xact_id(), pg_catalog.pg_backend_pid())
  ON CONFLICT (xact, pid) DO UPDATE SET verified_batch = NULL, active_batch = NULL;
  PERFORM pg_catalog.set_config('eureka.user_id', '', true);
END $$;

-- Historical mode: inside a running import call for a batch marked historical.
CREATE FUNCTION authz.import_historical() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce((SELECT b.historical FROM eureka.import_session s JOIN eureka.import_batch b ON b.id = s.active_batch
                    WHERE s.xact = pg_catalog.pg_current_xact_id_if_assigned() AND s.pid = pg_catalog.pg_backend_pid()), false)
$$;

-- Approval digest: batch settings (placements_commit, source, historical) plus
-- every row's identity, state (loaded counts as clean), keys, normalized values and reasons.
CREATE OR REPLACE FUNCTION authz.import_batch_digest(p_batch uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    coalesce((SELECT b.placements_commit::text || '|' || b.source || '|' || b.historical::text
                FROM eureka.import_batch b WHERE b.id = p_batch), '') || E'\n' ||
    coalesce((SELECT pg_catalog.string_agg(
      r.id::text || '|' || r.sheet || '|' || r.row_no::text || '|' || r.row_key || '|' || coalesce(r.person_key, '') || '|'
        || coalesce(r.status_key, '') || '|' || CASE WHEN r.state = 'committed' THEN 'clean' ELSE r.state END || '|'
        || coalesce(r.norm::text, '') || '|' || pg_catalog.array_to_string(r.reasons, ','),
      E'\n' ORDER BY r.id) FROM eureka.import_row r WHERE r.batch_id = p_batch), ''), 'UTF8')), 'hex')
$$;

-- API: the preview also shows the batch's source and historical flag.
CREATE OR REPLACE FUNCTION authz.import_load_preview(p_batch uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE pc boolean; src text; hist boolean;
BEGIN
  PERFORM authz.import_require_admin();
  SELECT b.placements_commit, b.source, b.historical INTO pc, src, hist FROM eureka.import_batch b WHERE b.id = p_batch;
  IF NOT FOUND THEN RAISE EXCEPTION 'batch_not_found' USING ERRCODE = 'no_data_found'; END IF;
  RETURN pg_catalog.jsonb_build_object(
    'digest', authz.import_batch_digest(p_batch),
    'placementsCommit', pc,
    'source', src,
    'historical', hist,
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

-- CLI: opens a batch with a ticket; placements_commit, source and historical are fixed here.
DROP FUNCTION authz.import_open_batch(text, text, jsonb, boolean);
CREATE FUNCTION authz.import_open_batch(p_ticket text, p_digest text, p_files jsonb, p_placements_commit boolean,
                                        p_source text, p_historical boolean) RETURNS uuid
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
  INSERT INTO eureka.import_batch (source_digest, files, operator_id, placements_commit, source, historical)
  VALUES (p_digest, p_files, t.created_by, coalesce(p_placements_commit, false), coalesce(p_source, 'sheets'),
          coalesce(p_historical, false))
  RETURNING id INTO new_id;
  UPDATE eureka.import_ticket SET used_at = pg_catalog.now(), batch_id = new_id WHERE id = t.id;
  PERFORM authz.import_end();
  RETURN new_id;
END $$;

-- The loader of 0041 with active_batch set on every call and the mode reported.
CREATE OR REPLACE FUNCTION authz.import_load_person(p_batch uuid, p_row uuid, p_dry_run boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  dry constant boolean := coalesce(p_dry_run, true);
  ppath constant text[] := ARRAY['confirmed','paperwork','bgc','ready','joined'];
  b record; anchor record; r record; g record; ex record; p record; tr record;
  s jsonb; n jsonb; pkey text; owner uuid; cand uuid; team uuid; person uuid; vis text; tgt text; cur text;
  sub_id uuid; sub_owner uuid; nk text; iv uuid; starts timestamptz; ends timestamptz; pl uuid; pst text;
  steps text[]; reason text; h text; ids uuid[]; hist boolean;
  counts jsonb := '{"candidates":0,"submissions":0,"interviews":0,"placements":0,"updated":0}';
  skipped jsonb := '[]';
BEGIN
  PERFORM authz.import_begin();
  SELECT * INTO b FROM eureka.import_batch WHERE id = p_batch FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'batch_not_found' USING ERRCODE = 'no_data_found'; END IF;
  IF b.purged_at IS NOT NULL THEN RAISE EXCEPTION 'batch_purged' USING ERRCODE = 'check_violation'; END IF;
  -- 0054: the batch this call runs for, on every call, dry or not, so that
  -- authz.import_historical() answers the same in a dry run as in the commit.
  UPDATE eureka.import_session SET active_batch = p_batch
   WHERE xact = pg_catalog.pg_current_xact_id() AND pid = pg_catalog.pg_backend_pid();
  hist := authz.import_historical();
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
    RETURN pg_catalog.jsonb_build_object('counts', counts, 'skipped', skipped, 'historical', hist);
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
      DETAIL = pg_catalog.jsonb_build_object('counts', counts, 'skipped', skipped, 'historical', hist)::text;
  END IF;
  PERFORM authz.import_end();
  RETURN pg_catalog.jsonb_build_object('counts', counts, 'skipped', skipped, 'historical', hist);
END $$;

-- ---------- approvals given under the old digest formula: withdraw ----------
-- As authz_definer, through the guard's approved -> staged edge (clears the
-- approver, time and digest). A partly loaded batch keeps its committed rows;
-- the rest load after a fresh approval.
UPDATE eureka.import_batch SET status = 'staged' WHERE status = 'approved';
RESET ROLE;

-- ---------- privileges ----------
REVOKE ALL ON FUNCTION eureka.import_batch_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.import_begin(), authz.import_historical(), authz.import_batch_digest(uuid),
  authz.import_load_preview(uuid), authz.import_open_batch(text, text, jsonb, boolean, text, boolean),
  authz.import_load_person(uuid, uuid, boolean) FROM PUBLIC;
-- authz.import_historical() is for the definer's own functions (owner): no role gets EXECUTE.
GRANT EXECUTE ON FUNCTION authz.import_open_batch(text, text, jsonb, boolean, text, boolean) TO eureka_import;
