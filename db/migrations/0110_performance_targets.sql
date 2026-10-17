-- Recruiter performance (Eureka App 4 gap L2; docs/performance-api.md PF-1..PF-8).
--   1. authz.scope_user_ids(perm): the people (app users) the caller's grant for
--      `perm` covers: own -> the caller; team -> the caller, the members and the
--      lead of the caller's teams; hierarchy -> the caller, everyone below them in
--      the reporting hierarchy, and the members and leads of the teams led by them
--      or anyone below them; location -> current members of teams at the location
--      and users whose primary location it is. Org scope is NOT expanded here:
--      callers test authz.has_org(perm) first (an org-wide array per statement
--      would defeat the InitPlan pattern). Used by the RLS read policy below, by
--      the definer functions of this package (targets, designation changes) and
--      by the API (one call per request).
--   2. eureka.performance_target: one target per person, period kind (week,
--      month, quarter) and aligned period start; counts only (submissions,
--      interviews, placements; at least one). RLS forced; the app reads it under
--      performance:read (or performance.target:manage) scope and never writes it.
--      Writes only through authz.performance_target_set / _delete (rule 6), which
--      re-check performance.target:manage over the target person (never the
--      caller themself). A BEFORE INSERT OR UPDATE guard sets set_by and the
--      timestamps and keeps the key columns immutable (rule 4), and refuses any
--      writer but the definer functions.
-- Every IF is NULL-safe (rule 1); functions pin search_path, are not executable
-- by PUBLIC and are granted to exactly the role that needs them (rule 2).
SET search_path = eureka, public;

-- ---------- table ----------
SET ROLE eureka_owner;

CREATE TABLE eureka.performance_target (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES eureka.app_user(id),
  period_kind  text NOT NULL CHECK (period_kind IN ('week', 'month', 'quarter')),
  period_start date NOT NULL CHECK (period_start BETWEEN date '2000-01-01' AND date '2100-12-31'),
  -- Exclusive end of the period (America/New_York calendar days).
  period_end   date GENERATED ALWAYS AS (
    CASE period_kind WHEN 'week' THEN period_start + 7
                     WHEN 'month' THEN (period_start + interval '1 month')::date
                     ELSE (period_start + interval '3 months')::date END) STORED,
  submissions  integer CHECK (submissions BETWEEN 0 AND 100000),
  interviews   integer CHECK (interviews BETWEEN 0 AND 100000),
  placements   integer CHECK (placements BETWEEN 0 AND 100000),
  set_by       uuid NOT NULL REFERENCES eureka.app_user(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT performance_target_some CHECK (num_nonnulls(submissions, interviews, placements) > 0),
  -- Weeks start on Monday, months on the 1st, quarters on 1 Jan / Apr / Jul / Oct.
  CONSTRAINT performance_target_aligned CHECK (
    (period_kind = 'week' AND extract(isodow FROM period_start) = 1)
    OR (period_kind = 'month' AND extract(day FROM period_start) = 1)
    OR (period_kind = 'quarter' AND extract(day FROM period_start) = 1 AND extract(month FROM period_start) IN (1, 4, 7, 10))),
  CONSTRAINT performance_target_key UNIQUE (user_id, period_kind, period_start)
);
CREATE INDEX performance_target_period_end ON eureka.performance_target (period_end, id);

ALTER TABLE eureka.performance_target ENABLE ROW LEVEL SECURITY;
ALTER TABLE eureka.performance_target FORCE ROW LEVEL SECURITY;

GRANT SELECT ON eureka.performance_target TO eureka_app;
GRANT SELECT, INSERT, DELETE ON eureka.performance_target TO authz_definer;
GRANT UPDATE (submissions, interviews, placements, set_by, updated_at) ON eureka.performance_target TO authz_definer;

CREATE POLICY definer_read   ON eureka.performance_target FOR SELECT TO authz_definer USING (true);
CREATE POLICY definer_insert ON eureka.performance_target FOR INSERT TO authz_definer WITH CHECK (true);
CREATE POLICY definer_update ON eureka.performance_target FOR UPDATE TO authz_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_delete ON eureka.performance_target FOR DELETE TO authz_definer USING (true);

RESET ROLE;

-- ---------- functions ----------
SET ROLE authz_definer;

CREATE FUNCTION authz.scope_user_ids(perm text) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH s AS (SELECT authz.team_ids(perm) AS teams, authz.location_ids(perm) AS locs)
  SELECT coalesce(pg_catalog.array_agg(DISTINCT x) FILTER (WHERE x IS NOT NULL), '{}') FROM (
    SELECT pg_catalog.unnest(authz.recruiter_ids(perm)) AS x
    UNION ALL
    SELECT tm.user_id FROM eureka.team_member tm, s
     WHERE tm.team_id = ANY (s.teams) AND tm.valid @> pg_catalog.now()
    UNION ALL
    SELECT t.lead_id FROM eureka.team t, s WHERE t.id = ANY (s.teams)
    UNION ALL
    SELECT tm.user_id FROM eureka.team_member tm JOIN eureka.team t ON t.id = tm.team_id, s
     WHERE t.location_id = ANY (s.locs) AND tm.valid @> pg_catalog.now()
    UNION ALL
    SELECT u.id FROM eureka.app_user u, s WHERE u.primary_location_id = ANY (s.locs)
  ) q
$$;

-- Rule 4: server-managed columns; only the definer functions below write.
CREATE FUNCTION authz.performance_target_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE actor uuid := authz.current_user_id();
BEGIN
  IF current_user IS DISTINCT FROM 'authz_definer' OR actor IS NULL THEN
    RAISE EXCEPTION 'performance targets are written by authz.performance_target_set only'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.set_by := actor;
  NEW.updated_at := pg_catalog.now();
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := pg_catalog.now();
  ELSE
    NEW.id := OLD.id;
    NEW.user_id := OLD.user_id;
    NEW.period_kind := OLD.period_kind;
    NEW.period_start := OLD.period_start;
    NEW.created_at := OLD.created_at;
  END IF;
  RETURN NEW;
END $$;

-- Caller must hold performance.target:manage over p_user (never themself).
-- Internal helper (EXECUTE: nobody; the definer functions run as its owner).
CREATE FUNCTION authz.performance_target_check(p_user uuid) RETURNS uuid
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE actor uuid := authz.current_user_id();
BEGIN
  IF actor IS NULL OR NOT authz.has_perm('performance.target:manage') THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_user IS NULL OR NOT EXISTS (SELECT 1 FROM eureka.app_user u WHERE u.id = p_user) THEN
    RAISE EXCEPTION 'user_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF p_user = actor THEN
    RAISE EXCEPTION 'self_change' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT (authz.has_org('performance.target:manage')
          OR p_user = ANY (authz.scope_user_ids('performance.target:manage'))) THEN
    RAISE EXCEPTION 'not_in_scope' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN actor;
END $$;

-- Creates or replaces the target of (person, period kind, period start).
-- NULL counts mean "no target for that metric"; at least one is required.
CREATE FUNCTION authz.performance_target_set(
  p_user uuid, p_kind text, p_start date, p_submissions integer, p_interviews integer, p_placements integer)
RETURNS TABLE (target_id uuid, created boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE v_id uuid; v_created boolean;
BEGIN
  PERFORM authz.performance_target_check(p_user);
  IF NOT EXISTS (SELECT 1 FROM eureka.app_user u WHERE u.id = p_user AND u.status = 'active') THEN
    RAISE EXCEPTION 'user_inactive' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO eureka.performance_target AS t
    (user_id, period_kind, period_start, submissions, interviews, placements, set_by)
  VALUES (p_user, p_kind, p_start, p_submissions, p_interviews, p_placements, authz.current_user_id())
  ON CONFLICT ON CONSTRAINT performance_target_key DO UPDATE
    SET submissions = EXCLUDED.submissions, interviews = EXCLUDED.interviews, placements = EXCLUDED.placements
  RETURNING t.id, (t.xmax = 0) INTO v_id, v_created;
  RETURN QUERY SELECT v_id, v_created;
END $$;

-- Deletes a target; returns its person (for the audit row).
CREATE FUNCTION authz.performance_target_delete(p_id uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_user uuid;
BEGIN
  SELECT t.user_id INTO v_user FROM eureka.performance_target t WHERE t.id = p_id FOR UPDATE;
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'target_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  PERFORM authz.performance_target_check(v_user);
  DELETE FROM eureka.performance_target t WHERE t.id = p_id;
  RETURN v_user;
END $$;

RESET ROLE;

REVOKE ALL ON FUNCTION authz.performance_target_guard() FROM PUBLIC;
-- The table owner attaches the trigger (as 0089 does for interview_notice).
GRANT EXECUTE ON FUNCTION authz.performance_target_guard() TO eureka_owner;

SET ROLE eureka_owner;
CREATE TRIGGER performance_target_guard BEFORE INSERT OR UPDATE ON eureka.performance_target
  FOR EACH ROW EXECUTE FUNCTION authz.performance_target_guard();

-- Rule 3: InitPlan per statement, never a definer call per row.
CREATE POLICY performance_target_read ON eureka.performance_target FOR SELECT TO eureka_app USING (
  (SELECT authz.has_org('performance:read'))
  OR (SELECT authz.has_org('performance.target:manage'))
  OR user_id = ANY ((SELECT authz.scope_user_ids('performance:read'))::uuid[])
  OR user_id = ANY ((SELECT authz.scope_user_ids('performance.target:manage'))::uuid[])
);
RESET ROLE;

REVOKE ALL ON FUNCTION authz.scope_user_ids(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.performance_target_check(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.performance_target_set(uuid, text, date, integer, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.performance_target_delete(uuid) FROM PUBLIC;
-- RLS evaluates scope_user_ids as the querying role (the API).
GRANT EXECUTE ON FUNCTION authz.scope_user_ids(text) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.performance_target_set(uuid, text, date, integer, integer, integer) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.performance_target_delete(uuid) TO eureka_app;
