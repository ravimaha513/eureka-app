-- Hot List extras (FR-HOT, HANDOFF task 2): saved views and a capped, masked export.
-- Bulk actions need no schema: they reuse the per-record write paths (the
-- candidate column guard and authz.transition_candidate), one record at a time.
SET search_path = eureka, public;

-- 1. Saved views: a user's own named Hot List filter sets. Private to the owner;
--    nobody else (org_admin included) can read or change them.
SET ROLE eureka_owner;

CREATE TABLE eureka.hotlist_view (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id   uuid NOT NULL DEFAULT authz.current_user_id() REFERENCES eureka.app_user(id),
  name       text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80 AND name = btrim(name)),
  filters    jsonb NOT NULL DEFAULT '{}'::jsonb
             CHECK (jsonb_typeof(filters) = 'object' AND pg_column_size(filters) <= 2048),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX hotlist_view_owner_name ON eureka.hotlist_view (owner_id, lower(name));

-- Server-managed columns (rule 4): the owner is always the caller, timestamps
-- come from the server, and a user keeps at most 50 views.
CREATE FUNCTION eureka.hotlist_view_insert_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE me uuid := authz.current_user_id();
BEGIN
  IF me IS NULL OR NEW.owner_id IS DISTINCT FROM me THEN
    RAISE EXCEPTION 'server_managed_field' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.created_at := pg_catalog.now();
  NEW.updated_at := pg_catalog.now();
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('hotlist_view:' || me::text));
  IF coalesce((SELECT count(*) FROM eureka.hotlist_view v WHERE v.owner_id = me), 0) >= 50 THEN
    RAISE EXCEPTION 'too_many_views' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hotlist_view_insert_guard BEFORE INSERT ON eureka.hotlist_view
  FOR EACH ROW EXECUTE FUNCTION eureka.hotlist_view_insert_guard();

CREATE FUNCTION eureka.hotlist_view_update_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'server_managed_field' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END $$;
CREATE TRIGGER hotlist_view_update_guard BEFORE UPDATE ON eureka.hotlist_view
  FOR EACH ROW EXECUTE FUNCTION eureka.hotlist_view_update_guard();

REVOKE ALL ON FUNCTION eureka.hotlist_view_insert_guard(), eureka.hotlist_view_update_guard() FROM PUBLIC;

ALTER TABLE eureka.hotlist_view ENABLE ROW LEVEL SECURITY;
ALTER TABLE eureka.hotlist_view FORCE ROW LEVEL SECURITY;
-- InitPlan, not a per-row function call (rule 3).
CREATE POLICY hotlist_view_owner ON eureka.hotlist_view TO eureka_app
  USING (owner_id = (SELECT authz.current_user_id()))
  WITH CHECK (owner_id = (SELECT authz.current_user_id()));

GRANT SELECT, DELETE ON eureka.hotlist_view TO eureka_app;
GRANT INSERT (name, filters), UPDATE (name, filters) ON eureka.hotlist_view TO eureka_app;

RESET ROLE;

-- 2. Export: the Hot List view as rows for a CSV, limited to the caller's
--    report:export scope (design A6.5 "scope-limited"), capped at 50,000 rows
--    (the function returns at most cap + 1 so the API can report truncation),
--    phone ALWAYS masked (design B4.6 "masked ... in exports"), DOB and emails
--    never returned, technical rating only where the caller can read the
--    candidate (as on screen). Scope is resolved once per call (rule 3 spirit,
--    see 0015). The API audits every export in the same transaction.
SET ROLE authz_definer;

CREATE FUNCTION authz.hotlist_export(
  p_status text, p_technology text, p_visibility text, p_search text, p_limit int)
RETURNS TABLE (
  id uuid, first_name text, last_name text, technology text,
  team_name text, recruiter_name text, location_name text, visibility text, marketing_status text,
  priority text, marketing_start_date text, technical_rating smallint, phone text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH s AS MATERIALIZED (
    SELECT authz.has_perm('hotlist:read') AS hl,
           authz.has_org('report:export') AS eo, authz.recruiter_ids('report:export') AS er,
           authz.team_ids('report:export') AS et, authz.location_ids('report:export') AS el,
           authz.has_org('candidate:read') AS ro, authz.recruiter_ids('candidate:read') AS rr,
           authz.team_ids('candidate:read') AS rt, authz.location_ids('candidate:read') AS rl,
           authz.all_teams('candidate:read') AS rat
  ),
  picked AS (
    SELECT c.*, p.first_name, p.last_name, p.phone_e164, t.name AS technology_name,
      coalesce(s.ro OR c.recruiter_id = ANY (s.rr) OR c.team_id = ANY (s.rt) OR c.location_id = ANY (s.rl)
               OR (s.rat AND c.visibility = 'all_teams' AND c.marketing_status IN ('active', 'full_of_interviews')), false) AS can_read
    FROM eureka.candidate c
    JOIN eureka.person p ON p.id = c.person_id
    JOIN eureka.technology t ON t.id = c.technology_id
    CROSS JOIN s
    WHERE coalesce(s.hl, false)
      AND coalesce(s.eo OR c.recruiter_id = ANY (s.er) OR c.team_id = ANY (s.et) OR c.location_id = ANY (s.el), false)
      AND c.marketing_status IN ('active', 'on_hold', 'full_of_interviews', 'confirmation', 'bench', 'stopped')
      AND (p_status IS NULL OR c.marketing_status = p_status)
      AND (p_technology IS NULL OR t.name = p_technology)
      AND (p_visibility IS NULL OR c.visibility = p_visibility)
      AND (p_search IS NULL OR (p.first_name || ' ' || p.last_name) ILIKE p_search ESCAPE '\')
    ORDER BY c.id
    LIMIT least(greatest(coalesce(p_limit, 50000), 1), 50001)
  )
  SELECT h.id, h.first_name, h.last_name, h.technology_name,
         tm.name, u.display_name, l.name, h.visibility, h.marketing_status, h.priority,
         h.marketing_start_date::text,
         CASE WHEN h.can_read THEN h.technical_rating END,
         CASE WHEN h.phone_e164 IS NULL THEN NULL
              ELSE '•••-•••-' || lpad(right(regexp_replace(h.phone_e164, '\D', '', 'g'), 2), 2, '•') END
  FROM picked h
  JOIN eureka.team tm ON tm.id = h.team_id
  JOIN eureka.location l ON l.id = h.location_id
  LEFT JOIN eureka.app_user u ON u.id = h.recruiter_id
  ORDER BY h.id
$$;
REVOKE ALL ON FUNCTION authz.hotlist_export(text, text, text, text, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.hotlist_export(text, text, text, text, int) TO eureka_app;

RESET ROLE;
