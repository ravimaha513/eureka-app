-- Review follow-up for 0044 (paperwork/BGC review finding 1).
-- authz.update_bgc with failPlacement passed the BGC failure reason (free text,
-- readable only under document:read per B4.4) to authz.transition_placement,
-- which stored it in placement.status_reason, a column every placement:read
-- holder can select. The placement now gets a fixed, non-sensitive reason; the
-- real reason stays on the BGC record and its history. The function is 0044's
-- with that one line changed; CREATE OR REPLACE as authz_definer keeps its
-- owner, signature, search_path and grants (restated below).
SET search_path = eureka, public;

SET ROLE authz_definer;

CREATE OR REPLACE FUNCTION authz.update_bgc(p_placement uuid, p_changes jsonb, p_expected_version integer)
RETURNS TABLE (from_status text, to_status text, new_version integer, changed text[],
               placement_from text, placement_to text, candidate_from text, candidate_to text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  actor uuid := authz.current_user_id();
  pl record; b record;
  pl_from text; pl_to text; c_from text; c_to text;
  to_st text; reason text;
  v_company text; v_init date; v_done date; v_helper uuid; v_edu text; v_emp smallint; v_addr smallint; v_notes text;
  ch text[] := ARRAY[]::text[];
  fail_pl boolean := false;
BEGIN
  SELECT * INTO pl FROM eureka.placement p WHERE p.id = p_placement;
  IF NOT FOUND OR actor IS NULL OR NOT coalesce(authz.placement_covered(p_placement, 'document:read'), false) THEN
    RAISE EXCEPTION 'placement_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT coalesce(authz.placement_covered(p_placement, 'bgc:update'), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF pg_catalog.jsonb_typeof(p_changes) IS DISTINCT FROM 'object'
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.jsonb_object_keys(p_changes))
     OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_object_keys(p_changes) k
                WHERE k NOT IN ('status', 'reason', 'bgcCompany', 'initiatedOn', 'completedOn', 'helpedBy',
                                'educationLevel', 'employmentYears', 'addressYears', 'notes', 'failPlacement'))
     OR coalesce(p_changes ? 'reason' AND NOT p_changes ? 'status', false) THEN
    RAISE EXCEPTION 'invalid_change' USING ERRCODE = 'check_violation';
  END IF;
  IF coalesce(pl.status = 'backout', true) THEN
    RAISE EXCEPTION 'placement_closed' USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO eureka.bgc (placement_id) VALUES (p_placement) ON CONFLICT (placement_id) DO NOTHING;
  SELECT * INTO b FROM eureka.bgc x WHERE x.placement_id = p_placement FOR UPDATE;
  IF p_expected_version IS NOT NULL AND p_expected_version IS DISTINCT FROM b.version THEN
    RAISE EXCEPTION 'version_mismatch' USING ERRCODE = 'serialization_failure';
  END IF;

  to_st := b.status;
  IF p_changes ? 'status' THEN
    IF pg_catalog.jsonb_typeof(p_changes -> 'status') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'invalid_change' USING ERRCODE = 'check_violation';
    END IF;
    to_st := p_changes ->> 'status';
    -- PW-7: forward steps; cleared -> failed after the fact (FR-PLC-06); failed is final.
    IF NOT coalesce((b.status, to_st) IN (
         ('not_started', 'initiated'),
         ('initiated', 'in_progress'), ('initiated', 'cleared'), ('initiated', 'failed'),
         ('in_progress', 'cleared'), ('in_progress', 'failed'),
         ('cleared', 'failed')), false) THEN
      RAISE EXCEPTION 'invalid_transition' USING ERRCODE = 'check_violation';
    END IF;
    IF coalesce(p_changes ? 'reason' AND pg_catalog.jsonb_typeof(p_changes -> 'reason') NOT IN ('string', 'null'), false) THEN
      RAISE EXCEPTION 'invalid_change' USING ERRCODE = 'check_violation';
    END IF;
    reason := nullif(pg_catalog.btrim(p_changes ->> 'reason'), '');
    IF coalesce(pg_catalog.char_length(reason) > 500, false) THEN
      RAISE EXCEPTION 'invalid_change' USING ERRCODE = 'check_violation';
    END IF;
    IF reason IS NULL AND coalesce(to_st = 'failed', true) THEN
      RAISE EXCEPTION 'reason_required' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- JSON types: strings for text/dates/ids, numbers for years, boolean flag.
  IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_each(p_changes) e
             WHERE (e.key IN ('bgcCompany', 'initiatedOn', 'completedOn', 'helpedBy', 'educationLevel', 'notes')
                    AND pg_catalog.jsonb_typeof(e.value) NOT IN ('string', 'null'))
                OR (e.key IN ('employmentYears', 'addressYears') AND pg_catalog.jsonb_typeof(e.value) NOT IN ('number', 'null'))
                OR (e.key = 'failPlacement' AND pg_catalog.jsonb_typeof(e.value) IS DISTINCT FROM 'boolean')) THEN
    RAISE EXCEPTION 'invalid_change' USING ERRCODE = 'check_violation';
  END IF;
  BEGIN
    v_company := CASE WHEN p_changes ? 'bgcCompany' THEN nullif(pg_catalog.btrim(p_changes ->> 'bgcCompany'), '') ELSE b.bgc_company END;
    v_init := CASE WHEN p_changes ? 'initiatedOn' THEN (p_changes ->> 'initiatedOn')::date ELSE b.initiated_on END;
    v_done := CASE WHEN p_changes ? 'completedOn' THEN (p_changes ->> 'completedOn')::date ELSE b.completed_on END;
    v_helper := CASE WHEN p_changes ? 'helpedBy' THEN (p_changes ->> 'helpedBy')::uuid ELSE b.helped_by END;
    v_edu := CASE WHEN p_changes ? 'educationLevel' THEN nullif(pg_catalog.btrim(p_changes ->> 'educationLevel'), '') ELSE b.education_level END;
    v_emp := CASE WHEN p_changes ? 'employmentYears' THEN (p_changes ->> 'employmentYears')::smallint ELSE b.employment_years END;
    v_addr := CASE WHEN p_changes ? 'addressYears' THEN (p_changes ->> 'addressYears')::smallint ELSE b.address_years END;
    v_notes := CASE WHEN p_changes ? 'notes' THEN nullif(pg_catalog.btrim(p_changes ->> 'notes'), '') ELSE b.notes END;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'invalid_change' USING ERRCODE = 'check_violation';
  END;
  IF v_helper IS NOT NULL AND v_helper IS DISTINCT FROM b.helped_by
     AND NOT EXISTS (SELECT 1 FROM eureka.app_user u WHERE u.id = v_helper AND u.status = 'active') THEN
    RAISE EXCEPTION 'invalid_helper' USING ERRCODE = 'check_violation';
  END IF;
  -- Server defaults for the dates a status change implies, unless given.
  IF to_st IS DISTINCT FROM b.status THEN
    IF coalesce(to_st = 'initiated', false) AND v_init IS NULL THEN v_init := CURRENT_DATE; END IF;
    IF coalesce(to_st IN ('cleared', 'failed'), false) AND v_done IS NULL THEN v_done := CURRENT_DATE; END IF;
  END IF;

  fail_pl := coalesce((p_changes -> 'failPlacement')::text = 'true', false);
  IF fail_pl AND to_st IS DISTINCT FROM 'failed' THEN
    RAISE EXCEPTION 'invalid_change' USING ERRCODE = 'check_violation';
  END IF;

  BEGIN
    UPDATE eureka.bgc x
       SET status = to_st,
           status_reason = CASE WHEN to_st IS DISTINCT FROM b.status THEN reason ELSE x.status_reason END,
           bgc_company = v_company, initiated_on = v_init, completed_on = v_done, helped_by = v_helper,
           education_level = v_edu, employment_years = v_emp, address_years = v_addr, notes = v_notes
     WHERE x.id = b.id;
  EXCEPTION WHEN check_violation THEN
    RAISE EXCEPTION 'invalid_change' USING ERRCODE = 'check_violation';
  END;

  IF to_st IS DISTINCT FROM b.status THEN ch := ch || 'status'::text; END IF;
  IF v_company IS DISTINCT FROM b.bgc_company THEN ch := ch || 'bgc_company'::text; END IF;
  IF v_init IS DISTINCT FROM b.initiated_on THEN ch := ch || 'initiated_on'::text; END IF;
  IF v_done IS DISTINCT FROM b.completed_on THEN ch := ch || 'completed_on'::text; END IF;
  IF v_helper IS DISTINCT FROM b.helped_by THEN ch := ch || 'helped_by'::text; END IF;
  IF v_edu IS DISTINCT FROM b.education_level THEN ch := ch || 'education_level'::text; END IF;
  IF v_emp IS DISTINCT FROM b.employment_years THEN ch := ch || 'employment_years'::text; END IF;
  IF v_addr IS DISTINCT FROM b.address_years THEN ch := ch || 'address_years'::text; END IF;
  IF v_notes IS DISTINCT FROM b.notes THEN ch := ch || 'notes'::text; END IF;

  -- FR-PLC-06 through the one placement state machine (no duplicated rules).
  IF fail_pl THEN
    SELECT t.from_status, t.to_status, t.candidate_from, t.candidate_to INTO pl_from, pl_to, c_from, c_to
      FROM authz.transition_placement(p_placement, 'bgc_failed',
             'Background check failed (see the BGC record)') t;
  END IF;

  RETURN QUERY SELECT b.status::text, to_st,
    (SELECT x.version FROM eureka.bgc x WHERE x.id = b.id), ch, pl_from, pl_to, c_from, c_to;
END $$;

RESET ROLE;

REVOKE ALL ON FUNCTION authz.update_bgc(uuid, jsonb, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.update_bgc(uuid, jsonb, integer) TO eureka_app;
