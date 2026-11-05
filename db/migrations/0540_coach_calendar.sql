-- Coach calendar (docs/coach-calendar-api.md CC-1..CC-5). A grid of every Interview Coach's
-- interviews, and who may see it. Only the CEO decides, and "the CEO" means a current holder of the
-- system role `ceo`: authz.is_ceo() checks the role itself rather than a permission, because a
-- permission could be put on a custom role or copied by cloning. This is the one deliberate
-- exception to branching on traits (0311): the owner asked for this one role. System roles cannot
-- be edited, and role_create / role_set_grants keep coach_calendar:* off custom roles.
--   1. eureka.coach_calendar_grant: one row per grantee, a role or one user, covering all coaches
--      or the listed ones, at 'full' (candidate, round, status) or 'busy' (times only) detail.
--      Grants add up: a viewer gets the union of their user and role grants, at the highest detail.
--   2. authz.coach_calendar_visible(): the coaches the caller may see. The CEO sees all; each coach
--      sees themself; everyone else needs a grant. Holding interview:read does not imply access.
--      Admins never get access through a grant (admin separation, 0500), even if they became admin
--      after it was made; grants on an archived role do nothing. "Coach" is the interview_coach
--      role, the same set the scheduling picker offers (InterviewsService.coaches).
--   3. authz.coach_calendar_events(): those coaches' live interviews in a window. Definer because a
--      granted viewer need not be able to read interviews; busy rows carry times only.
-- No candidate data, rates, emails or free text in the grant row or its audit (rule 5).
-- Every IF is NULL-safe (rule 1); functions pin search_path (rule 2).

SET ROLE eureka_owner;
CREATE TABLE eureka.coach_calendar_grant (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grantee_role  text REFERENCES eureka.role(key),
  grantee_user  uuid REFERENCES eureka.app_user(id),
  all_coaches   boolean NOT NULL,
  coach_ids     uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(coach_ids) <= 500),
  detail        text NOT NULL CHECK (detail IN ('full', 'busy')),
  created_by    uuid NOT NULL REFERENCES eureka.app_user(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid NOT NULL REFERENCES eureka.app_user(id),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT coach_calendar_grant_one_grantee CHECK ((grantee_role IS NULL) <> (grantee_user IS NULL)),
  CONSTRAINT coach_calendar_grant_coverage CHECK (all_coaches = (cardinality(coach_ids) = 0))
);
CREATE UNIQUE INDEX coach_calendar_grant_role ON eureka.coach_calendar_grant (grantee_role) WHERE grantee_role IS NOT NULL;
CREATE UNIQUE INDEX coach_calendar_grant_user ON eureka.coach_calendar_grant (grantee_user) WHERE grantee_user IS NOT NULL;
CREATE INDEX coach_calendar_grant_created_by ON eureka.coach_calendar_grant (created_by);
CREATE INDEX coach_calendar_grant_updated_by ON eureka.coach_calendar_grant (updated_by);

-- created_* and updated_* are server-managed (rule 4).
CREATE FUNCTION eureka.coach_calendar_grant_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF authz.current_user_id() IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.created_by := authz.current_user_id();
    NEW.created_at := pg_catalog.now();
  ELSE
    NEW.created_by := OLD.created_by;
    NEW.created_at := OLD.created_at;
  END IF;
  NEW.updated_by := authz.current_user_id();
  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION eureka.coach_calendar_grant_guard() FROM PUBLIC;
CREATE TRIGGER coach_calendar_grant_guard BEFORE INSERT OR UPDATE ON eureka.coach_calendar_grant
  FOR EACH ROW EXECUTE FUNCTION eureka.coach_calendar_grant_guard();

ALTER TABLE eureka.coach_calendar_grant ENABLE ROW LEVEL SECURITY;
ALTER TABLE eureka.coach_calendar_grant FORCE ROW LEVEL SECURITY;
-- Writes go through the definer functions below; the read policy follows authz.is_ceo().
CREATE POLICY definer_read ON eureka.coach_calendar_grant FOR SELECT TO authz_definer USING (true);
CREATE POLICY definer_insert ON eureka.coach_calendar_grant FOR INSERT TO authz_definer WITH CHECK (true);
CREATE POLICY definer_update ON eureka.coach_calendar_grant FOR UPDATE TO authz_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_delete ON eureka.coach_calendar_grant FOR DELETE TO authz_definer USING (true);
RESET ROLE;

GRANT SELECT ON eureka.coach_calendar_grant TO eureka_app;
GRANT SELECT, INSERT, DELETE ON eureka.coach_calendar_grant TO authz_definer;
GRANT UPDATE (all_coaches, coach_ids, detail) ON eureka.coach_calendar_grant TO authz_definer;

SET ROLE authz_definer;
CREATE FUNCTION authz.is_ceo() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM eureka.user_role ur JOIN eureka.app_user u ON u.id = ur.user_id
     WHERE ur.user_id = authz.current_user_id() AND ur.role_key = 'ceo'
       AND ur.valid @> pg_catalog.now() AND u.status = 'active')
$$;
REVOKE ALL ON FUNCTION authz.is_ceo() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.is_ceo() TO eureka_app;

-- The grants that apply to the caller: by name, or by a current role that is not archived.
CREATE FUNCTION authz.coach_calendar_my_grants()
RETURNS TABLE (all_coaches boolean, coach_ids uuid[], detail text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT g.all_coaches, g.coach_ids, g.detail
    FROM eureka.coach_calendar_grant g
    LEFT JOIN eureka.role r ON r.key = g.grantee_role
   WHERE authz.current_user_id() IS NOT NULL
     AND NOT coalesce(authz.user_has_trait(authz.current_user_id(), 'admin'), false)
     AND (g.grantee_user = authz.current_user_id()
          OR (r.archived_at IS NULL
              AND g.grantee_role IN (SELECT ur.role_key FROM eureka.user_role ur
                                      WHERE ur.user_id = authz.current_user_id() AND ur.valid @> pg_catalog.now())))
$$;
REVOKE ALL ON FUNCTION authz.coach_calendar_my_grants() FROM PUBLIC;

CREATE FUNCTION authz.coach_calendar_visible()
RETURNS TABLE (coach_id uuid, coach_name text, detail text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH me AS (
    SELECT authz.current_user_id() AS id, coalesce(authz.is_ceo(), false) AS is_ceo
  ), mine AS (
    SELECT * FROM authz.coach_calendar_my_grants()
  ), coaches AS (
    SELECT DISTINCT u.id, u.display_name
      FROM eureka.app_user u JOIN eureka.user_role ur ON ur.user_id = u.id
     WHERE u.status = 'active' AND ur.role_key = 'interview_coach' AND ur.valid @> pg_catalog.now()
  )
  SELECT c.id, c.display_name::text,
         CASE WHEN me.is_ceo OR c.id = me.id
                OR EXISTS (SELECT 1 FROM mine m WHERE m.detail = 'full' AND (m.all_coaches OR c.id = ANY (m.coach_ids)))
              THEN 'full' ELSE 'busy' END
    FROM coaches c, me
   WHERE me.id IS NOT NULL
     AND (me.is_ceo OR c.id = me.id
          OR EXISTS (SELECT 1 FROM mine m WHERE m.all_coaches OR c.id = ANY (m.coach_ids)))
$$;
REVOKE ALL ON FUNCTION authz.coach_calendar_visible() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.coach_calendar_visible() TO eureka_app;

-- Whether the screen applies to the caller at all (the API's 403, and the sidebar entry).
CREATE FUNCTION authz.coach_calendar_can_view() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT authz.current_user_id() IS NOT NULL AND (
    coalesce(authz.is_ceo(), false)
    OR EXISTS (SELECT 1 FROM eureka.user_role ur
                WHERE ur.user_id = authz.current_user_id() AND ur.role_key = 'interview_coach' AND ur.valid @> pg_catalog.now())
    OR EXISTS (SELECT 1 FROM authz.coach_calendar_my_grants()))
$$;
REVOKE ALL ON FUNCTION authz.coach_calendar_can_view() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.coach_calendar_can_view() TO eureka_app;

-- Live interviews only: the same statuses every other interview count leaves out (0017).
-- The window is capped here too, so the cap cannot be skipped by calling the function directly.
CREATE FUNCTION authz.coach_calendar_events(p_from timestamptz, p_to timestamptz)
RETURNS TABLE (coach_id uuid, starts_at timestamptz, ends_at timestamptz, interview_id uuid, candidate_name text, round text, call_status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT v.coach_id, i.starts_at, i.ends_at,
         CASE WHEN v.detail = 'full' THEN i.id END,
         CASE WHEN v.detail = 'full' THEN p.first_name || ' ' || p.last_name END,
         CASE WHEN v.detail = 'full' THEN i.round END,
         CASE WHEN v.detail = 'full' THEN i.call_status END
    FROM authz.coach_calendar_visible() v
    JOIN eureka.interview i ON i.coach_id = v.coach_id
    JOIN eureka.candidate c ON c.id = i.candidate_id
    JOIN eureka.person p ON p.id = c.person_id
   WHERE p_to > p_from AND p_to - p_from <= interval '32 days'
     AND i.starts_at < p_to AND i.ends_at > p_from
     AND i.call_status NOT IN ('cancelled', 'rescheduled', 'no_invite')
   ORDER BY i.starts_at, i.id
$$;
REVOKE ALL ON FUNCTION authz.coach_calendar_events(timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.coach_calendar_events(timestamptz, timestamptz) TO eureka_app;

-- One grant per grantee: granting again replaces what they had.
CREATE FUNCTION authz.coach_calendar_grant_set(p_role text, p_user uuid, p_all boolean, p_coaches uuid[], p_detail text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_coaches uuid[] := '{}';
  v_id uuid;
BEGIN
  IF NOT coalesce(authz.is_ceo(), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (p_role IS NULL) = (p_user IS NULL) THEN
    RAISE EXCEPTION 'invalid_grantee' USING ERRCODE = 'check_violation';
  END IF;
  -- The CEO already sees all; admin roles hold no business data (0500); archived roles are gone.
  IF p_role IS NOT NULL AND (p_role = 'ceo' OR NOT EXISTS (
       SELECT 1 FROM eureka.role r WHERE r.key = p_role AND NOT r.is_admin AND r.archived_at IS NULL)) THEN
    RAISE EXCEPTION 'invalid_grantee' USING ERRCODE = 'check_violation';
  END IF;
  IF p_user IS NOT NULL THEN
    -- The lock orders this against admin_set_user_status, whose DELETE could not see an uncommitted grant.
    PERFORM 1 FROM eureka.app_user u WHERE u.id = p_user AND u.status = 'active' FOR SHARE;
    IF NOT FOUND OR coalesce(authz.user_has_trait(p_user, 'admin'), false) THEN
      RAISE EXCEPTION 'invalid_grantee' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF p_detail IS NULL OR p_detail NOT IN ('full', 'busy') THEN
    RAISE EXCEPTION 'invalid_detail' USING ERRCODE = 'check_violation';
  END IF;
  IF p_all IS NULL THEN
    RAISE EXCEPTION 'invalid_coaches' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT p_all THEN
    SELECT coalesce(pg_catalog.array_agg(DISTINCT x), '{}') INTO v_coaches FROM pg_catalog.unnest(p_coaches) x WHERE x IS NOT NULL;
    IF pg_catalog.cardinality(v_coaches) = 0
       OR pg_catalog.cardinality(v_coaches) IS DISTINCT FROM (
         SELECT pg_catalog.count(DISTINCT ur.user_id)::integer
           FROM eureka.user_role ur JOIN eureka.app_user u ON u.id = ur.user_id
          WHERE ur.user_id = ANY (v_coaches) AND ur.role_key = 'interview_coach'
            AND ur.valid @> pg_catalog.now() AND u.status = 'active') THEN
      RAISE EXCEPTION 'invalid_coaches' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF p_role IS NOT NULL THEN
    INSERT INTO eureka.coach_calendar_grant AS g (grantee_role, all_coaches, coach_ids, detail)
    VALUES (p_role, p_all, v_coaches, p_detail)
    ON CONFLICT (grantee_role) WHERE grantee_role IS NOT NULL
    DO UPDATE SET all_coaches = EXCLUDED.all_coaches, coach_ids = EXCLUDED.coach_ids, detail = EXCLUDED.detail
    RETURNING g.id INTO v_id;
  ELSE
    INSERT INTO eureka.coach_calendar_grant AS g (grantee_user, all_coaches, coach_ids, detail)
    VALUES (p_user, p_all, v_coaches, p_detail)
    ON CONFLICT (grantee_user) WHERE grantee_user IS NOT NULL
    DO UPDATE SET all_coaches = EXCLUDED.all_coaches, coach_ids = EXCLUDED.coach_ids, detail = EXCLUDED.detail
    RETURNING g.id INTO v_id;
  END IF;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION authz.coach_calendar_grant_set(text, uuid, boolean, uuid[], text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.coach_calendar_grant_set(text, uuid, boolean, uuid[], text) TO eureka_app;

-- Returns what was removed, so the audit can say who lost access.
CREATE FUNCTION authz.coach_calendar_grant_delete(p_id uuid)
RETURNS TABLE (grantee_role text, grantee_user uuid, all_coaches boolean, coach_ids uuid[], detail text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  r eureka.coach_calendar_grant%ROWTYPE;
BEGIN
  IF NOT coalesce(authz.is_ceo(), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  DELETE FROM eureka.coach_calendar_grant g WHERE g.id = p_id RETURNING g.* INTO r;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'no_data_found';
  END IF;
  RETURN QUERY SELECT r.grantee_role, r.grantee_user, r.all_coaches, r.coach_ids, r.detail;
END $$;
REVOKE ALL ON FUNCTION authz.coach_calendar_grant_delete(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.coach_calendar_grant_delete(uuid) TO eureka_app;
RESET ROLE;

SET ROLE eureka_owner;
CREATE POLICY coach_calendar_grant_read ON eureka.coach_calendar_grant FOR SELECT TO eureka_app
  USING ((SELECT authz.is_ceo()));
RESET ROLE;
