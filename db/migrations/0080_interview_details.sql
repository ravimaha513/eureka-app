-- Interview details, panel and scorecards (interviews-settings package,
-- docs/interviews-settings-api.md rules IS-1..IS-9).
--   1. interview.interview_type (phone / video / in_person) and
--      interview.meeting_url (https only, at most 500 characters). Both are
--      Sales fields: eureka.interview_guard now lists them with round, times,
--      links and coach (only a Sales grant on the actor snapshot changes them).
--      The duration is not stored: ends_at stays the source of truth and the
--      API derives ends_at from a duration (15..240 minutes).
--   2. eureka.interview_panelist: the panel (app users) with at most one lead,
--      written only through authz.set_interview_panel (definer: same Sales
--      check as the guard, active users, at most 10, lead must be a member).
--      Readable wherever the interview is readable (subquery under the
--      caller's interview RLS, like feedback_read). Panel membership grants
--      no access to the interview.
--   3. Scorecard on interview_feedback: technical skills, communication,
--      problem solving, attitude (1..5 each, all four or none), only on
--      'coach' and 'client' feedback. Feedback stays append-only.
-- Every IF is NULL-safe (rule 1); the definer function re-checks permission
-- and scope (rule 6); no free text or links reach audit_event (rule 5).
SET search_path = eureka, public;

-- ---------- 1. interview columns ----------
SET ROLE eureka_owner;
ALTER TABLE eureka.interview
  ADD COLUMN interview_type text CHECK (interview_type IN ('phone', 'video', 'in_person')),
  ADD COLUMN meeting_url    text CHECK (meeting_url ~ '^https://[^[:space:]]+$' AND char_length(meeting_url) <= 500);

-- Same function as 0017 with interview_type and meeting_url in the Sales tuple.
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
       OR NEW.call_status IS DISTINCT FROM 'scheduled' THEN
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
  IF (NEW.feedback_email_sent_at, NEW.cleared_at, NEW.cleared_by)
     IS DISTINCT FROM (OLD.feedback_email_sent_at, OLD.cleared_at, OLD.cleared_by) THEN
    RAISE EXCEPTION 'server_managed_field' USING ERRCODE = 'insufficient_privilege';
  END IF;

  sales_ok := coalesce(authz.has_org(perm)
    OR OLD.recruiter_id = ANY (authz.recruiter_ids(perm))
    OR OLD.team_id = ANY (authz.owned_team_ids(perm)), false);
  loc_ok := coalesce(OLD.location_id = ANY (authz.location_ids(perm)), false);

  IF (NEW.round, NEW.starts_at, NEW.ends_at, NEW.otter_url, NEW.recording_url, NEW.coach_id, NEW.invite_received,
      NEW.interview_type, NEW.meeting_url)
     IS DISTINCT FROM (OLD.round, OLD.starts_at, OLD.ends_at, OLD.otter_url, OLD.recording_url, OLD.coach_id, OLD.invite_received,
      OLD.interview_type, OLD.meeting_url)
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
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- ---------- 2. panel ----------
CREATE TABLE eureka.interview_panelist (
  interview_id uuid NOT NULL REFERENCES eureka.interview(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES eureka.app_user(id),
  is_lead      boolean NOT NULL DEFAULT false,
  added_by     uuid REFERENCES eureka.app_user(id),
  added_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (interview_id, user_id)
);
CREATE UNIQUE INDEX interview_panelist_one_lead ON eureka.interview_panelist (interview_id) WHERE is_lead;
CREATE INDEX interview_panelist_user ON eureka.interview_panelist (user_id);

-- Rows come and go only inside authz.set_interview_panel (owner of the
-- function: authz_definer) or with their interview (FK cascade as the owner).
-- added_by / added_at are server-managed; rows never change in place.
CREATE FUNCTION eureka.interview_panelist_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' AND current_user = 'authz_definer' THEN
    NEW.added_by := authz.current_user_id();
    NEW.added_at := pg_catalog.now();
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' AND (current_user = 'authz_definer'
       OR coalesce(pg_catalog.pg_trigger_depth() > 1 AND current_user = 'eureka_owner', false)) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'the interview panel changes only through authz.set_interview_panel'
    USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER interview_panelist_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.interview_panelist
  FOR EACH ROW EXECUTE FUNCTION eureka.interview_panelist_guard();
CREATE TRIGGER interview_panelist_no_truncate BEFORE TRUNCATE ON eureka.interview_panelist
  FOR EACH STATEMENT EXECUTE FUNCTION eureka.interview_panelist_guard();

ALTER TABLE eureka.interview_panelist ENABLE ROW LEVEL SECURITY;
ALTER TABLE eureka.interview_panelist FORCE ROW LEVEL SECURITY;

-- ---------- 3. scorecard ----------
ALTER TABLE eureka.interview_feedback
  ADD COLUMN technical_skills smallint CHECK (technical_skills BETWEEN 1 AND 5),
  ADD COLUMN communication    smallint CHECK (communication BETWEEN 1 AND 5),
  ADD COLUMN problem_solving  smallint CHECK (problem_solving BETWEEN 1 AND 5),
  ADD COLUMN attitude         smallint CHECK (attitude BETWEEN 1 AND 5),
  ADD CONSTRAINT interview_feedback_scorecard_complete
    CHECK (num_nulls(technical_skills, communication, problem_solving, attitude) IN (0, 4)),
  ADD CONSTRAINT interview_feedback_scorecard_kind
    CHECK (technical_skills IS NULL OR kind IN ('coach', 'client'));
-- A scorecard alone is feedback too.
ALTER TABLE eureka.interview_feedback DROP CONSTRAINT interview_feedback_content;
ALTER TABLE eureka.interview_feedback ADD CONSTRAINT interview_feedback_content
  CHECK (rating IS NOT NULL OR nullif(btrim(notes), '') IS NOT NULL OR technical_skills IS NOT NULL);
RESET ROLE;

REVOKE ALL ON FUNCTION eureka.interview_panelist_guard() FROM PUBLIC;
REVOKE ALL ON eureka.interview_panelist FROM PUBLIC;

-- App: interview_type and meeting_url are written on insert (table INSERT
-- grant of 0003) and updated like the other Sales columns.
GRANT UPDATE (interview_type, meeting_url) ON eureka.interview TO eureka_app;
GRANT INSERT (technical_skills, communication, problem_solving, attitude) ON eureka.interview_feedback TO eureka_app;

-- Panel: the app reads rows of interviews it can read; only the definer writes.
GRANT SELECT ON eureka.interview_panelist TO eureka_app;
CREATE POLICY panelist_read ON eureka.interview_panelist FOR SELECT TO eureka_app
  USING (EXISTS (SELECT 1 FROM eureka.interview i WHERE i.id = interview_id));
GRANT SELECT, INSERT (interview_id, user_id, is_lead), DELETE ON eureka.interview_panelist TO authz_definer;
CREATE POLICY definer_read ON eureka.interview_panelist FOR SELECT TO authz_definer USING (true);
CREATE POLICY definer_insert ON eureka.interview_panelist FOR INSERT TO authz_definer WITH CHECK (true);
CREATE POLICY definer_delete ON eureka.interview_panelist FOR DELETE TO authz_definer USING (true);

SET ROLE authz_definer;

-- Replaces the panel of an interview (IS-4). The caller needs the Sales
-- grant on the interview's actor snapshot that eureka.interview_guard asks
-- for the other Sales columns; an unknown interview answers the same
-- 'not_permitted' (nothing is revealed). Members: distinct active users, at
-- most 10; the lead (optional) must be a member. Returns the member count.
CREATE FUNCTION authz.set_interview_panel(p_interview uuid, p_members uuid[], p_lead uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  perm constant text := 'interview:update';
  members uuid[] := coalesce(p_members, '{}');
  i record;
  n integer;
BEGIN
  IF authz.current_user_id() IS NULL OR p_interview IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT iv.recruiter_id, iv.team_id INTO i FROM eureka.interview iv WHERE iv.id = p_interview;
  IF NOT FOUND OR NOT coalesce(authz.has_org(perm)
       OR i.recruiter_id = ANY (authz.recruiter_ids(perm))
       OR i.team_id = ANY (authz.owned_team_ids(perm)), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- One writer per interview at a time (two concurrent replacements would
  -- otherwise both delete and then collide on the primary key).
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('interview_panel:' || p_interview::text, 0));

  n := coalesce(pg_catalog.cardinality(members), 0);
  IF n > 10 THEN
    RAISE EXCEPTION 'panel_too_large' USING ERRCODE = 'check_violation';
  END IF;
  IF pg_catalog.array_position(members, NULL) IS NOT NULL
     OR (SELECT count(DISTINCT m) FROM pg_catalog.unnest(members) AS m) IS DISTINCT FROM n::bigint THEN
    RAISE EXCEPTION 'invalid_panel' USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT count(*) FROM eureka.app_user u WHERE u.id = ANY (members) AND u.status = 'active') IS DISTINCT FROM n::bigint THEN
    RAISE EXCEPTION 'invalid_panel_member' USING ERRCODE = 'check_violation';
  END IF;
  IF p_lead IS NOT NULL AND NOT coalesce(p_lead = ANY (members), false) THEN
    RAISE EXCEPTION 'lead_not_in_panel' USING ERRCODE = 'check_violation';
  END IF;

  DELETE FROM eureka.interview_panelist WHERE interview_id = p_interview;
  INSERT INTO eureka.interview_panelist (interview_id, user_id, is_lead)
  SELECT p_interview, m, coalesce(m = p_lead, false) FROM pg_catalog.unnest(members) AS m;
  RETURN n;
END $$;
RESET ROLE;

REVOKE ALL ON FUNCTION authz.set_interview_panel(uuid, uuid[], uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.set_interview_panel(uuid, uuid[], uuid) TO eureka_app;
