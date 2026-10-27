-- Candidate visibility "Selected teams" (docs/candidates-api.md CA-5).
--
-- A candidate's visibility was `team` (its own team and hierarchy, location
-- roles, the CEO) or `all_teams` (also every Sales user while active / full of
-- interviews). It gains `selected_teams`: also the Sales users of the teams the
-- owner picks, under exactly the all-teams rule (same statuses, same
-- permissions: candidate:read, hotlist:read, submission:create,
-- placement:create; phones stay masked; no ownership rights).
--   1. eureka.candidate_team_share (candidate, team): the picked teams. Rows
--      count only while the candidate's visibility is `selected_teams`; they are
--      written only by authz.set_candidate_visibility (guard below).
--   2. authz.shared_candidate_ids(perm): candidates shared with a team the
--      caller belongs to for `perm` (authz.team_ids plus authz.actor_team, so a
--      recruiter counts their membership), Sales roles only (authz.all_teams),
--      marketable statuses only. Used by the candidate_read policy as an
--      InitPlan set (rule 3) and by authz.candidate_visible.
--   3. authz.set_candidate_visibility(candidate, visibility, teams): re-checks
--      candidate:read (404) and candidate.visibility:update ownership (403),
--      sets visibility and replaces the share rows in one statement.
-- Mirrored in packages/shared/src/authz/engine.ts (candidateVisible,
-- UserAccess.sharedCandidateIds). hotlist_page, hotlist_export and
-- transition_candidate are changed in db/functions/authz.
SET search_path = eureka, public;

SET ROLE eureka_owner;

ALTER TABLE eureka.candidate DROP CONSTRAINT candidate_visibility_check;
ALTER TABLE eureka.candidate ADD CONSTRAINT candidate_visibility_check
  CHECK (visibility IN ('team', 'all_teams', 'selected_teams'));

CREATE TABLE eureka.candidate_team_share (
  candidate_id uuid NOT NULL REFERENCES eureka.candidate(id) ON DELETE CASCADE,
  team_id      uuid NOT NULL REFERENCES eureka.team(id),
  shared_by    uuid NOT NULL REFERENCES eureka.app_user(id),
  shared_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (candidate_id, team_id)
);
CREATE INDEX candidate_team_share_team ON eureka.candidate_team_share (team_id, candidate_id);

CREATE FUNCTION eureka.candidate_team_share_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF current_user IS DISTINCT FROM 'authz_definer' THEN
    RAISE EXCEPTION 'team shares are written only by authz.set_candidate_visibility' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.shared_by := authz.current_user_id();
    NEW.shared_at := pg_catalog.now();
  ELSIF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'team shares are immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER candidate_team_share_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.candidate_team_share
  FOR EACH ROW EXECUTE FUNCTION eureka.candidate_team_share_guard();

ALTER TABLE eureka.candidate_team_share ENABLE ROW LEVEL SECURITY;
ALTER TABLE eureka.candidate_team_share FORCE ROW LEVEL SECURITY;
CREATE POLICY candidate_team_share_read ON eureka.candidate_team_share FOR SELECT TO eureka_app
  USING (EXISTS (SELECT 1 FROM eureka.candidate c WHERE c.id = candidate_team_share.candidate_id));
CREATE POLICY definer_read   ON eureka.candidate_team_share FOR SELECT TO authz_definer USING (true);
CREATE POLICY definer_insert ON eureka.candidate_team_share FOR INSERT TO authz_definer WITH CHECK (true);
CREATE POLICY definer_delete ON eureka.candidate_team_share FOR DELETE TO authz_definer USING (true);

RESET ROLE;

REVOKE ALL ON eureka.candidate_team_share FROM PUBLIC;
GRANT SELECT ON eureka.candidate_team_share TO eureka_app;
GRANT SELECT, INSERT, DELETE ON eureka.candidate_team_share TO authz_definer;
REVOKE ALL ON FUNCTION eureka.candidate_team_share_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eureka.candidate_team_share_guard() TO authz_definer;
-- authz.set_candidate_visibility writes the column (the column guard still re-checks ownership).
GRANT UPDATE (visibility) ON eureka.candidate TO authz_definer;

-- ---------- definer functions ----------
SET ROLE authz_definer;

CREATE FUNCTION authz.shared_candidate_ids(perm text) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce(pg_catalog.array_agg(DISTINCT s.candidate_id), '{}')
  FROM eureka.candidate_team_share s
  JOIN eureka.candidate c ON c.id = s.candidate_id
  WHERE authz.all_teams(perm)
    AND c.visibility = 'selected_teams'
    AND c.marketing_status IN ('active', 'full_of_interviews')
    AND (s.team_id = ANY (authz.team_ids(perm)) OR s.team_id IS NOT DISTINCT FROM authz.actor_team())
$$;

CREATE OR REPLACE FUNCTION authz.candidate_visible(p_candidate uuid, perm text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM eureka.candidate c WHERE c.id = p_candidate AND (
      authz.owns(perm, c.recruiter_id, c.team_id, c.location_id)
      OR (authz.all_teams(perm) AND c.visibility = 'all_teams'
          AND c.marketing_status IN ('active','full_of_interviews'))
      OR c.id = ANY (authz.shared_candidate_ids(perm))))
$$;

CREATE FUNCTION authz.set_candidate_visibility(p_candidate uuid, p_visibility text, p_teams uuid[])
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE c record; v_teams uuid[];
BEGIN
  SELECT * INTO c FROM eureka.candidate WHERE id = p_candidate FOR UPDATE;
  IF NOT FOUND OR authz.current_user_id() IS NULL
     OR NOT coalesce(authz.candidate_visible(p_candidate, 'candidate:read'), false) THEN
    RAISE EXCEPTION 'candidate_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT coalesce(authz.owns('candidate.visibility:update', c.recruiter_id, c.team_id, c.location_id), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_visibility IS NULL OR p_visibility NOT IN ('team', 'all_teams', 'selected_teams') THEN
    RAISE EXCEPTION 'invalid_visibility' USING ERRCODE = 'check_violation';
  END IF;

  -- The candidate's own team already sees it; it is never stored as a share.
  SELECT coalesce(pg_catalog.array_agg(DISTINCT t), '{}') INTO v_teams
  FROM pg_catalog.unnest(coalesce(p_teams, '{}')) t
  WHERE t IS DISTINCT FROM c.team_id;

  IF p_visibility = 'selected_teams' THEN
    IF coalesce(pg_catalog.cardinality(v_teams), 0) = 0 THEN
      RAISE EXCEPTION 'teams_required' USING ERRCODE = 'check_violation';
    END IF;
    IF pg_catalog.cardinality(v_teams) > 50 THEN
      RAISE EXCEPTION 'too_many_teams' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_catalog.unnest(v_teams) t
               WHERE NOT EXISTS (SELECT 1 FROM eureka.team tm WHERE tm.id = t)) THEN
      RAISE EXCEPTION 'invalid_team' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF coalesce(pg_catalog.cardinality(v_teams), 0) > 0 THEN
    RAISE EXCEPTION 'teams_not_allowed' USING ERRCODE = 'check_violation';
  END IF;

  IF c.visibility IS DISTINCT FROM p_visibility THEN
    UPDATE eureka.candidate SET visibility = p_visibility WHERE id = p_candidate;
  END IF;
  DELETE FROM eureka.candidate_team_share s
   WHERE s.candidate_id = p_candidate AND NOT (s.team_id = ANY (v_teams));
  INSERT INTO eureka.candidate_team_share (candidate_id, team_id, shared_by)
  SELECT p_candidate, t, authz.current_user_id() FROM pg_catalog.unnest(v_teams) t
  ON CONFLICT DO NOTHING;
  RETURN p_visibility;
END $$;

RESET ROLE;

REVOKE ALL ON FUNCTION authz.shared_candidate_ids(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.shared_candidate_ids(text) TO eureka_app;
REVOKE ALL ON FUNCTION authz.set_candidate_visibility(uuid, text, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.set_candidate_visibility(uuid, text, uuid[]) TO eureka_app;

-- ---------- candidate read policy: also the picked teams ----------
DROP POLICY candidate_read ON eureka.candidate;
CREATE POLICY candidate_read ON eureka.candidate FOR SELECT TO eureka_app USING (
  (SELECT authz.has_org('candidate:read'))
  OR recruiter_id = ANY ((SELECT authz.recruiter_ids('candidate:read'))::uuid[])
  OR team_id      = ANY ((SELECT authz.team_ids('candidate:read'))::uuid[])
  OR location_id  = ANY ((SELECT authz.location_ids('candidate:read'))::uuid[])
  OR ((SELECT authz.all_teams('candidate:read'))
      AND visibility = 'all_teams' AND marketing_status IN ('active','full_of_interviews'))
  OR id IN (SELECT pg_catalog.unnest((SELECT authz.shared_candidate_ids('candidate:read'))))
);
