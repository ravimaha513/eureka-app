-- Interview reports (gap L4, docs/interviews-settings-api.md "Interview reports").
--   1. The interview coach is the "proxy" of the spec. interview.coach_id
--      (0003) is already a Sales field under eureka.interview_guard and the
--      duration is ends_at - starts_at (0080: no duration column). The API
--      accepts only an active holder of the interview_coach role as coach;
--      the database now checks the same whenever coach_id is set or changed
--      (eureka.interview_coach_guard, through the definer helper
--      authz.is_interview_coach, so the check does not depend on the
--      writer's read rights on user_role / app_user). A coach who later loses the
--      role stays on the interviews they already have.
--   2. Indexes for the reports: interviews by coach and time, and the latest
--      candidate feedback (kind 'candidate', 0021) per interview for the daily
--      report and the board's candidate feedback column.
-- The reports themselves are plain reads under the caller's interview RLS
-- (no new grants, policies or permissions): interview:read and report:read,
-- plus report:export for the CSV exports.
-- Every IF is NULL-safe (rule 1); functions are REVOKEd from PUBLIC with a
-- pinned search_path (rule 2); nothing new reaches audit_event (rule 5).
SET search_path = eureka, public;

-- ---------- 1. coach check ----------
SET ROLE authz_definer;

-- True when p_user is an active user holding the interview_coach role now.
-- Answers a yes/no about a user id the caller already holds; reveals nothing else.
CREATE FUNCTION authz.is_interview_coach(p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT p_user IS NOT NULL AND EXISTS (
    SELECT 1 FROM eureka.user_role ur JOIN eureka.app_user u ON u.id = ur.user_id
    WHERE ur.user_id = p_user AND ur.role_key = 'interview_coach'
      AND ur.valid @> pg_catalog.now() AND u.status = 'active')
$$;
RESET ROLE;

REVOKE ALL ON FUNCTION authz.is_interview_coach(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.is_interview_coach(uuid) TO eureka_app, eureka_owner;

SET ROLE eureka_owner;
CREATE FUNCTION eureka.interview_coach_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.coach_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.coach_id IS NOT DISTINCT FROM OLD.coach_id THEN
    RETURN NEW;
  END IF;
  IF NOT coalesce(authz.is_interview_coach(NEW.coach_id), false) THEN
    RAISE EXCEPTION 'invalid_coach' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER interview_coach_guard BEFORE INSERT OR UPDATE OF coach_id ON eureka.interview
  FOR EACH ROW EXECUTE FUNCTION eureka.interview_coach_guard();

-- ---------- 2. report indexes ----------
CREATE INDEX interview_coach_time ON eureka.interview (coach_id, starts_at) WHERE coach_id IS NOT NULL;
CREATE INDEX interview_feedback_candidate_latest ON eureka.interview_feedback (interview_id, created_at DESC, id DESC)
  WHERE kind = 'candidate';
RESET ROLE;

REVOKE ALL ON FUNCTION eureka.interview_coach_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eureka.interview_coach_guard() TO eureka_app, eureka_worker, eureka_owner, authz_definer;
