-- Write-side guards (design B4.7, B4.8): column allowlist, activity snapshots,
-- team invariants and the candidate status transition function.
SET search_path = eureka, public;

-- ---------- candidate column allowlist ----------
SET ROLE eureka_owner;
CREATE FUNCTION eureka.candidate_column_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  is_definer boolean := current_user = 'authz_definer';
  owns_old   boolean;
BEGIN
  -- Never changeable through the API.
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.person_id IS DISTINCT FROM OLD.person_id
     OR NEW.location_id IS DISTINCT FROM OLD.location_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'column is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Status columns change only through authz.transition_candidate (N2).
  IF (NEW.marketing_status IS DISTINCT FROM OLD.marketing_status
      OR NEW.bench_since IS DISTINCT FROM OLD.bench_since) AND NOT is_definer THEN
    RAISE EXCEPTION 'status changes must use a transition' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF (NEW.technology_id, NEW.gh_location_id, NEW.priority, NEW.marketing_email, NEW.vitel_number,
      NEW.marketing_start_date, NEW.in_person_ok)
     IS DISTINCT FROM
     (OLD.technology_id, OLD.gh_location_id, OLD.priority, OLD.marketing_email, OLD.vitel_number,
      OLD.marketing_start_date, OLD.in_person_ok)
     AND NOT authz.owns('candidate:update', OLD.recruiter_id, OLD.team_id, OLD.location_id) THEN
    RAISE EXCEPTION 'not permitted to update profile fields' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.technical_rating IS DISTINCT FROM OLD.technical_rating
     AND NOT authz.owns('candidate.rating:update', OLD.recruiter_id, OLD.team_id, OLD.location_id) THEN
    RAISE EXCEPTION 'not permitted to update technical rating' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.visibility IS DISTINCT FROM OLD.visibility
     AND NOT authz.owns('candidate.visibility:update', OLD.recruiter_id, OLD.team_id, OLD.location_id) THEN
    RAISE EXCEPTION 'not permitted to change visibility' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF (NEW.team_id, NEW.recruiter_id) IS DISTINCT FROM (OLD.team_id, OLD.recruiter_id) THEN
    owns_old := authz.owns('candidate:assign', OLD.recruiter_id, OLD.team_id, OLD.location_id);
    IF NOT owns_old
       OR NOT (authz.has_org('candidate:assign') OR NEW.team_id = ANY (authz.team_ids('candidate:assign'))) THEN
      RAISE EXCEPTION 'not permitted to reassign candidate' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  NEW.updated_at := now();
  NEW.row_version := OLD.row_version + 1;
  RETURN NEW;
END $$;
CREATE TRIGGER candidate_column_guard BEFORE UPDATE ON eureka.candidate
  FOR EACH ROW EXECUTE FUNCTION eureka.candidate_column_guard();

-- ---------- team invariant: recruiter must belong to the candidate's team (N5) ----------
CREATE FUNCTION eureka.candidate_team_invariant() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.recruiter_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM eureka.team_member tm
       WHERE tm.team_id = NEW.team_id AND tm.user_id = NEW.recruiter_id AND tm.valid @> now()
       UNION ALL
       SELECT 1 FROM eureka.team t WHERE t.id = NEW.team_id AND t.lead_id = NEW.recruiter_id) THEN
    RAISE EXCEPTION 'recruiter is not a member of the candidate''s team' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER candidate_team_invariant BEFORE INSERT OR UPDATE OF team_id, recruiter_id ON eureka.candidate
  FOR EACH ROW EXECUTE FUNCTION eureka.candidate_team_invariant();
RESET ROLE;
-- The invariant reads team membership; its owner needs no RLS bypass (org tables have none).

-- ---------- activity snapshots (N3): set by the database, never by the client ----------
SET ROLE authz_definer;
CREATE FUNCTION authz.submission_snapshot() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE cand_location uuid; actor uuid := authz.current_user_id(); actor_team uuid := authz.actor_team();
BEGIN
  SELECT c.location_id INTO cand_location FROM eureka.candidate c WHERE c.id = NEW.candidate_id;
  IF (NEW.recruiter_id IS NOT NULL AND NEW.recruiter_id IS DISTINCT FROM actor)
     OR (NEW.team_id IS NOT NULL AND NEW.team_id IS DISTINCT FROM actor_team)
     OR (NEW.location_id IS NOT NULL AND NEW.location_id IS DISTINCT FROM cand_location) THEN
    RAISE EXCEPTION 'snapshot columns are set by the server' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.recruiter_id := actor;
  NEW.team_id := actor_team;
  NEW.location_id := cand_location;
  RETURN NEW;
END $$;

CREATE FUNCTION authz.interview_snapshot() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE s record;
BEGIN
  SELECT sub.candidate_id, sub.recruiter_id, sub.team_id, sub.location_id INTO s
  FROM eureka.submission sub WHERE sub.id = NEW.submission_id;
  IF (NEW.candidate_id IS NOT NULL AND NEW.candidate_id IS DISTINCT FROM s.candidate_id)
     OR (NEW.recruiter_id IS NOT NULL AND NEW.recruiter_id IS DISTINCT FROM s.recruiter_id)
     OR (NEW.team_id IS NOT NULL AND NEW.team_id IS DISTINCT FROM s.team_id)
     OR (NEW.location_id IS NOT NULL AND NEW.location_id IS DISTINCT FROM s.location_id) THEN
    RAISE EXCEPTION 'snapshot columns are set by the server' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.candidate_id := s.candidate_id; NEW.recruiter_id := s.recruiter_id;
  NEW.team_id := s.team_id; NEW.location_id := s.location_id;
  RETURN NEW;
END $$;

-- Snapshots are immutable after insert.
CREATE FUNCTION authz.activity_snapshot_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (NEW.candidate_id, NEW.recruiter_id, NEW.team_id, NEW.location_id)
     IS DISTINCT FROM (OLD.candidate_id, OLD.recruiter_id, OLD.team_id, OLD.location_id) THEN
    RAISE EXCEPTION 'snapshot columns are immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

-- ---------- candidate status transitions (N2, design B2.6) ----------
CREATE FUNCTION authz.transition_candidate(p_candidate uuid, p_to text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE c record;
BEGIN
  SELECT * INTO c FROM eureka.candidate WHERE id = p_candidate FOR UPDATE;
  IF NOT FOUND OR NOT (
       authz.owns('candidate:read', c.recruiter_id, c.team_id, c.location_id)
       OR (authz.all_teams('candidate:read') AND c.visibility = 'all_teams'
           AND c.marketing_status IN ('active','full_of_interviews'))) THEN
    RAISE EXCEPTION 'candidate not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT authz.owns('candidate:update', c.recruiter_id, c.team_id, c.location_id) THEN
    RAISE EXCEPTION 'not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT (c.marketing_status, p_to) IN (
      ('in_training','active'),
      ('active','on_hold'), ('active','stopped'), ('active','full_of_interviews'), ('active','confirmation'),
      ('on_hold','active'), ('full_of_interviews','active'),
      ('confirmation','active'), ('bench','active'),
      ('in_training','terminated'), ('active','terminated'), ('on_hold','terminated'),
      ('stopped','terminated'), ('full_of_interviews','terminated'), ('confirmation','terminated'),
      ('bench','terminated')) THEN
    RAISE EXCEPTION 'invalid transition % -> %', c.marketing_status, p_to USING ERRCODE = 'check_violation';
  END IF;
  UPDATE eureka.candidate SET marketing_status = p_to,
    bench_since = CASE WHEN p_to = 'bench' THEN current_date ELSE NULL END
  WHERE id = p_candidate;
  RETURN p_to;
END $$;
RESET ROLE;

CREATE TRIGGER submission_snapshot BEFORE INSERT ON eureka.submission
  FOR EACH ROW EXECUTE FUNCTION authz.submission_snapshot();
CREATE TRIGGER interview_snapshot BEFORE INSERT ON eureka.interview
  FOR EACH ROW EXECUTE FUNCTION authz.interview_snapshot();
CREATE TRIGGER submission_immutable BEFORE UPDATE ON eureka.submission
  FOR EACH ROW EXECUTE FUNCTION authz.activity_snapshot_immutable();
CREATE TRIGGER interview_immutable BEFORE UPDATE ON eureka.interview
  FOR EACH ROW EXECUTE FUNCTION authz.activity_snapshot_immutable();

DO $$
DECLARE f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('authz','eureka')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO eureka_app, eureka_worker, eureka_owner, authz_definer', f.sig);
  END LOOP;
END $$;
