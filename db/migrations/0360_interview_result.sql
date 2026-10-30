-- Interview result (docs/interviews-settings-api.md IS-10).
--   1. interview.result: the outcome of the round, pending -> cleared |
--      rejected (and back), set after the call. Distinct from interview.cleared,
--      which is the location's pre-call readiness flag. A Sales field: only a
--      Sales grant on the actor snapshot (recruiter, team lead and above)
--      changes it. result_at / result_by are server-managed (set when the
--      result leaves pending, cleared when it goes back).
--   2. eureka.interview_guard learns the new columns. New interviews start
--      pending.
--   3. Partial index for the Placements "Cleared interviews" list by team.
SET ROLE eureka_owner;

ALTER TABLE eureka.interview
  ADD COLUMN result    text NOT NULL DEFAULT 'pending'
    CONSTRAINT interview_result_valid CHECK (result IN ('pending', 'cleared', 'rejected')),
  ADD COLUMN result_at timestamptz,
  ADD COLUMN result_by uuid REFERENCES eureka.app_user(id);

CREATE INDEX interview_cleared_by_team ON eureka.interview (team_id, result_at DESC) WHERE result = 'cleared';

CREATE OR REPLACE FUNCTION eureka.interview_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  perm constant text := 'interview:update';
  sales_ok boolean;
  loc_ok boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF coalesce(authz.submission_closed(NEW.submission_id), false) THEN
      RAISE EXCEPTION 'submission_closed' USING ERRCODE = 'check_violation';
    END IF;
    IF coalesce(NEW.cleared, false) OR coalesce(NEW.consent_captured, false)
       OR NEW.feedback_email_sent_at IS NOT NULL OR NEW.cleared_at IS NOT NULL OR NEW.cleared_by IS NOT NULL
       OR NEW.call_status IS DISTINCT FROM 'scheduled'
       OR NEW.result IS DISTINCT FROM 'pending' OR NEW.result_at IS NOT NULL OR NEW.result_by IS NOT NULL THEN
      RAISE EXCEPTION 'server_managed_field' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  IF current_user = 'eureka_worker' THEN
    IF (to_jsonb(NEW) - 'feedback_email_sent_at') IS DISTINCT FROM (to_jsonb(OLD) - 'feedback_email_sent_at') THEN
      RAISE EXCEPTION 'worker may only mark feedback email sent' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW.id, NEW.submission_id, NEW.client_id) IS DISTINCT FROM (OLD.id, OLD.submission_id, OLD.client_id) THEN
    RAISE EXCEPTION 'column is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW.feedback_email_sent_at, NEW.cleared_at, NEW.cleared_by, NEW.result_at, NEW.result_by)
     IS DISTINCT FROM (OLD.feedback_email_sent_at, OLD.cleared_at, OLD.cleared_by, OLD.result_at, OLD.result_by) THEN
    RAISE EXCEPTION 'server_managed_field' USING ERRCODE = 'insufficient_privilege';
  END IF;

  sales_ok := coalesce(authz.has_org(perm)
    OR OLD.recruiter_id = ANY (authz.recruiter_ids(perm))
    OR OLD.team_id = ANY (authz.owned_team_ids(perm)), false);
  loc_ok := coalesce(OLD.location_id = ANY (authz.location_ids(perm)), false);

  IF (NEW.round, NEW.starts_at, NEW.ends_at, NEW.otter_url, NEW.recording_url, NEW.coach_id, NEW.invite_received,
      NEW.interview_type, NEW.meeting_url, NEW.result)
     IS DISTINCT FROM (OLD.round, OLD.starts_at, OLD.ends_at, OLD.otter_url, OLD.recording_url, OLD.coach_id, OLD.invite_received,
      OLD.interview_type, OLD.meeting_url, OLD.result)
     AND NOT sales_ok THEN
    RAISE EXCEPTION 'field_not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW.cleared, NEW.consent_captured, NEW.system_name)
     IS DISTINCT FROM (OLD.cleared, OLD.consent_captured, OLD.system_name)
     AND NOT loc_ok THEN
    RAISE EXCEPTION 'field_not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.call_status IS DISTINCT FROM OLD.call_status AND NOT (sales_ok OR loc_ok) THEN
    RAISE EXCEPTION 'field_not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.cleared IS DISTINCT FROM OLD.cleared THEN
    NEW.cleared_at := CASE WHEN NEW.cleared THEN now() END;
    NEW.cleared_by := CASE WHEN NEW.cleared THEN authz.current_user_id() END;
  END IF;
  IF NEW.result IS DISTINCT FROM OLD.result THEN
    NEW.result_at := CASE WHEN NEW.result IS DISTINCT FROM 'pending' THEN now() END;
    NEW.result_by := CASE WHEN NEW.result IS DISTINCT FROM 'pending' THEN authz.current_user_id() END;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
RESET ROLE;

GRANT UPDATE (result) ON eureka.interview TO eureka_app;
