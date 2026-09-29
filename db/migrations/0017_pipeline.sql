-- Submissions pipeline and interview board (design B2.2, B2.3, B2.6, B4.5, B4.8).
--   1. Submission status changes only through authz.transition_submission
--      (definer, NULL-safe; see 0012/0015 for the NULL pitfalls).
--   2. Interview column allowlist by grant kind, server-managed fields,
--      recording links only with consent (AS-12), no overlapping interviews
--      for one candidate (exclusion constraint), client snapshot.
--   3. interview_feedback: append-only, RLS, kind derived from the grant.
SET search_path = eureka, public;

-- ---------- scope helpers ----------
SET ROLE authz_definer;

-- authz.team_ids without the coached branch: teams a Sales grant (team,
-- hierarchy) covers. Coaching never gives write rights on activity rows.
CREATE FUNCTION authz.owned_team_ids(perm text) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH me AS (SELECT authz.current_user_id() AS id),
  scopes AS (SELECT DISTINCT scope FROM authz.grants(perm)),
  own_teams AS (
    SELECT tm.team_id FROM eureka.team_member tm, me
      WHERE tm.user_id = me.id AND tm.valid @> pg_catalog.now()
    UNION SELECT t.id FROM eureka.team t, me WHERE t.lead_id = me.id
  )
  SELECT coalesce(array_agg(DISTINCT x), '{}') FROM (
    SELECT team_id AS x FROM own_teams WHERE EXISTS (SELECT 1 FROM scopes WHERE scope IN ('team','hierarchy'))
    UNION ALL
    SELECT t.id FROM eureka.team t JOIN eureka.reporting_closure rc ON rc.descendant_id = t.lead_id, me
      WHERE rc.ancestor_id = me.id AND EXISTS (SELECT 1 FROM scopes WHERE scope = 'hierarchy')
  ) s
$$;

-- Teams covered by a coached grant only.
CREATE FUNCTION authz.coached_team_ids(perm text) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce(array_agg(DISTINCT ca.team_id), '{}')
  FROM eureka.coach_assignment ca
  WHERE ca.coach_id = authz.current_user_id() AND ca.valid @> pg_catalog.now()
    AND EXISTS (SELECT 1 FROM authz.grants(perm) g WHERE g.scope = 'coached')
$$;

RESET ROLE;

-- ---------- submission ----------
SET ROLE eureka_owner;
ALTER TABLE eureka.submission
  ADD COLUMN status_changed_at timestamptz,
  ADD COLUMN status_changed_by uuid REFERENCES eureka.app_user(id);
-- NOT VALID: enforced for every new write; older dev rows are not re-checked.
ALTER TABLE eureka.submission ADD CONSTRAINT submission_rejection_reason
  CHECK (status <> 'rejected' OR nullif(btrim(rejection_reason), '') IS NOT NULL) NOT VALID;

-- Status columns change only inside authz.transition_submission.
CREATE FUNCTION eureka.submission_status_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (NEW.status, NEW.rejection_reason, NEW.status_changed_at, NEW.status_changed_by)
     IS DISTINCT FROM (OLD.status, OLD.rejection_reason, OLD.status_changed_at, OLD.status_changed_by)
     AND current_user <> 'authz_definer' THEN
    RAISE EXCEPTION 'status changes must use a transition' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER submission_status_guard BEFORE UPDATE ON eureka.submission
  FOR EACH ROW EXECUTE FUNCTION eureka.submission_status_guard();
RESET ROLE;

-- The API has no general submission edit yet; the app keeps no UPDATE right.
REVOKE UPDATE ON eureka.submission FROM eureka_app;
GRANT UPDATE (status, rejection_reason, status_changed_at, status_changed_by) ON eureka.submission TO authz_definer;
CREATE POLICY definer_transition ON eureka.submission FOR UPDATE TO authz_definer USING (true) WITH CHECK (true);

SET ROLE authz_definer;

-- Submission state machine (design B2.6). Every IF is NULL-safe: a NULL
-- argument or a NULL scope result is treated as "no".
CREATE FUNCTION authz.transition_submission(p_submission uuid, p_to text, p_reason text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE s record; reason text := nullif(pg_catalog.btrim(p_reason), '');
BEGIN
  SELECT * INTO s FROM eureka.submission WHERE id = p_submission FOR UPDATE;
  IF NOT FOUND OR NOT coalesce(
       authz.owns('submission:read', s.recruiter_id, s.team_id, s.location_id)
       OR authz.candidate_owned(s.candidate_id, 'submission:read'), false) THEN
    RAISE EXCEPTION 'submission_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT coalesce(authz.owns('submission:update', s.recruiter_id, s.team_id, s.location_id), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_to IS NULL OR NOT coalesce((s.status, p_to) IN (
      ('submitted','under_review'), ('under_review','interview_requested'),
      ('interview_requested','interview_scheduled'), ('interview_scheduled','interview_completed'),
      ('interview_completed','selected')), false)
     AND NOT coalesce(p_to IN ('rejected','withdrawn')
                      AND s.status IN ('submitted','under_review','interview_requested',
                                       'interview_scheduled','interview_completed'), false) THEN
    RAISE EXCEPTION 'invalid_transition' USING ERRCODE = 'check_violation';
  END IF;
  IF p_to = 'rejected' AND reason IS NULL THEN
    RAISE EXCEPTION 'rejection_reason_required' USING ERRCODE = 'check_violation';
  END IF;
  IF p_to <> 'rejected' AND reason IS NOT NULL THEN
    RAISE EXCEPTION 'rejection_reason_not_allowed' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE eureka.submission
     SET status = p_to, rejection_reason = reason,
         status_changed_at = pg_catalog.now(), status_changed_by = authz.current_user_id()
   WHERE id = p_submission;
  RETURN p_to;
END $$;

-- True when the caller could open interviews on this submission but it is in
-- a terminal state. Unknown or out-of-scope submissions return false so the
-- answer reveals nothing (RLS then refuses the insert).
CREATE FUNCTION authz.submission_closed(p_submission uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM eureka.submission s
    WHERE s.id = p_submission AND s.status IN ('selected','rejected','withdrawn')
      AND authz.owns('submission:update', s.recruiter_id, s.team_id, s.location_id))
$$;

RESET ROLE;

-- ---------- interview ----------
SET ROLE eureka_owner;
ALTER TABLE eureka.interview
  ADD COLUMN client_id   uuid REFERENCES eureka.client(id),   -- snapshot from the submission
  ADD COLUMN system_name text CHECK (char_length(system_name) <= 80),
  ADD COLUMN cleared_at  timestamptz,
  ADD COLUMN cleared_by  uuid REFERENCES eureka.app_user(id),
  ADD COLUMN updated_at  timestamptz NOT NULL DEFAULT now();

-- AS-12: no Otter or recording link without captured consent.
ALTER TABLE eureka.interview ADD CONSTRAINT interview_recording_consent
  CHECK (consent_captured OR (otter_url IS NULL AND recording_url IS NULL)) NOT VALID;

-- FR-INT conflict check: one live interview per candidate at a time.
-- Adjacent slots ([10:00,11:00) and [11:00,12:00)) do not overlap.
ALTER TABLE eureka.interview ADD CONSTRAINT interview_no_overlap
  EXCLUDE USING gist (candidate_id WITH =, tstzrange(starts_at, ends_at) WITH &&)
  WHERE (call_status NOT IN ('cancelled', 'rescheduled', 'no_invite'));
CREATE INDEX interview_candidate_time ON eureka.interview (candidate_id, starts_at);

-- Column allowlist by grant kind (design B4.7, B4.8 N3):
--   Sales grant (own/team/hierarchy) on the actor snapshot: round, times,
--     links, coach, invite_received, call_status
--   Location grant on interview.location_id: cleared, consent_captured,
--     system_name, call_status
--   Worker: feedback_email_sent_at only. Everything else is server-managed.
CREATE FUNCTION eureka.interview_guard() RETURNS trigger
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

  IF (NEW.round, NEW.starts_at, NEW.ends_at, NEW.otter_url, NEW.recording_url, NEW.coach_id, NEW.invite_received)
     IS DISTINCT FROM (OLD.round, OLD.starts_at, OLD.ends_at, OLD.otter_url, OLD.recording_url, OLD.coach_id, OLD.invite_received)
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
CREATE TRIGGER interview_guard BEFORE INSERT OR UPDATE ON eureka.interview
  FOR EACH ROW EXECUTE FUNCTION eureka.interview_guard();
RESET ROLE;

-- The snapshot trigger now also copies the submission's client.
SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.interview_snapshot() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE s record;
BEGIN
  SELECT sub.candidate_id, sub.recruiter_id, sub.team_id, sub.location_id, sub.client_id INTO s
  FROM eureka.submission sub WHERE sub.id = NEW.submission_id;
  IF (NEW.candidate_id IS NOT NULL AND NEW.candidate_id IS DISTINCT FROM s.candidate_id)
     OR (NEW.recruiter_id IS NOT NULL AND NEW.recruiter_id IS DISTINCT FROM s.recruiter_id)
     OR (NEW.team_id IS NOT NULL AND NEW.team_id IS DISTINCT FROM s.team_id)
     OR (NEW.location_id IS NOT NULL AND NEW.location_id IS DISTINCT FROM s.location_id)
     OR (NEW.client_id IS NOT NULL AND NEW.client_id IS DISTINCT FROM s.client_id) THEN
    RAISE EXCEPTION 'snapshot columns are set by the server' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.candidate_id := s.candidate_id; NEW.recruiter_id := s.recruiter_id;
  NEW.team_id := s.team_id; NEW.location_id := s.location_id; NEW.client_id := s.client_id;
  RETURN NEW;
END $$;
RESET ROLE;

-- App writes only the editable columns; server-managed ones come from triggers.
REVOKE UPDATE ON eureka.interview FROM eureka_app;
GRANT UPDATE (round, starts_at, ends_at, otter_url, recording_url, coach_id, invite_received,
              call_status, cleared, consent_captured, system_name) ON eureka.interview TO eureka_app;

-- ---------- interview_feedback ----------
SET ROLE eureka_owner;
CREATE TABLE eureka.interview_feedback (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  interview_id uuid NOT NULL REFERENCES eureka.interview(id),
  author_id    uuid REFERENCES eureka.app_user(id),
  -- coach: Interview Coach; location: location admin; client: feedback the
  -- recruiter relays from the client (Sales grants); candidate: public form.
  kind         text NOT NULL CHECK (kind IN ('coach','location','client','candidate')),
  rating       smallint CHECK (rating BETWEEN 1 AND 5),
  notes        text CHECK (char_length(notes) <= 4000),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT interview_feedback_author CHECK ((kind = 'candidate') = (author_id IS NULL)),
  CONSTRAINT interview_feedback_content CHECK (rating IS NOT NULL OR nullif(btrim(notes), '') IS NOT NULL)
);
CREATE INDEX interview_feedback_interview ON eureka.interview_feedback (interview_id, created_at);

CREATE FUNCTION eureka.interview_feedback_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'interview feedback is append-only' USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER interview_feedback_append_only BEFORE UPDATE OR DELETE ON eureka.interview_feedback
  FOR EACH ROW EXECUTE FUNCTION eureka.interview_feedback_append_only();
RESET ROLE;

ALTER TABLE eureka.interview_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE eureka.interview_feedback FORCE ROW LEVEL SECURITY;

GRANT SELECT ON eureka.interview_feedback TO eureka_app;
GRANT INSERT (interview_id, author_id, kind, rating, notes) ON eureka.interview_feedback TO eureka_app;

SET ROLE authz_definer;
-- Feedback of a kind is allowed when the grant of that kind covers the
-- interview the way interview visibility does (actor snapshot or owned
-- candidate, design B4.4). 'candidate' feedback never comes from staff.
CREATE FUNCTION authz.feedback_kind_allowed(p_interview uuid, p_kind text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  perm constant text := 'interview.feedback:create';
  i record; c record;
  org boolean := false; rids uuid[] := '{}'; tids uuid[] := '{}'; lids uuid[] := '{}';
BEGIN
  SELECT iv.recruiter_id, iv.team_id, iv.location_id, iv.candidate_id INTO i
  FROM eureka.interview iv WHERE iv.id = p_interview;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT cd.recruiter_id, cd.team_id, cd.location_id INTO c FROM eureka.candidate cd WHERE cd.id = i.candidate_id;
  IF p_kind = 'coach' THEN
    tids := authz.coached_team_ids(perm);
  ELSIF p_kind = 'location' THEN
    lids := authz.location_ids(perm);
  ELSIF p_kind = 'client' THEN
    org := authz.has_org(perm); rids := authz.recruiter_ids(perm); tids := authz.owned_team_ids(perm);
  ELSE
    RETURN false;
  END IF;
  RETURN coalesce(org
    OR i.recruiter_id = ANY (rids) OR i.team_id = ANY (tids) OR i.location_id = ANY (lids)
    OR c.recruiter_id = ANY (rids) OR c.team_id = ANY (tids) OR c.location_id = ANY (lids), false);
END $$;
RESET ROLE;

-- Readable wherever the interview is readable (the subquery runs under the
-- caller's interview RLS, like person_read).
CREATE POLICY feedback_read ON eureka.interview_feedback FOR SELECT TO eureka_app
  USING (EXISTS (SELECT 1 FROM eureka.interview i WHERE i.id = interview_id));
CREATE POLICY feedback_insert ON eureka.interview_feedback FOR INSERT TO eureka_app
  WITH CHECK (
    author_id = (SELECT authz.current_user_id())
    AND kind <> 'candidate'
    AND authz.feedback_kind_allowed(interview_id, kind));

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'authz.owned_team_ids(text)', 'authz.coached_team_ids(text)',
    'authz.transition_submission(uuid,text,text)', 'authz.submission_closed(uuid)',
    'authz.feedback_kind_allowed(uuid,text)', 'authz.interview_snapshot()',
    'eureka.submission_status_guard()', 'eureka.interview_guard()', 'eureka.interview_feedback_append_only()']
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO eureka_app, eureka_worker, eureka_owner, authz_definer', f);
  END LOOP;
END $$;
