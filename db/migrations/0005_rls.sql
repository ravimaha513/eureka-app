-- Row-Level Security (design B4.5). Policies call authz functions wrapped in
-- scalar sub-selects so each is evaluated once per statement (InitPlan).
SET search_path = eureka, public;

ALTER TABLE person      ENABLE ROW LEVEL SECURITY; ALTER TABLE person      FORCE ROW LEVEL SECURITY;
ALTER TABLE candidate   ENABLE ROW LEVEL SECURITY; ALTER TABLE candidate   FORCE ROW LEVEL SECURITY;
ALTER TABLE submission  ENABLE ROW LEVEL SECURITY; ALTER TABLE submission  FORCE ROW LEVEL SECURITY;
ALTER TABLE interview   ENABLE ROW LEVEL SECURITY; ALTER TABLE interview   FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_event ENABLE ROW LEVEL SECURITY; ALTER TABLE audit_event FORCE ROW LEVEL SECURITY;

-- ---------- candidate ----------
CREATE POLICY candidate_read ON candidate FOR SELECT TO eureka_app USING (
  (SELECT authz.has_org('candidate:read'))
  OR recruiter_id = ANY ((SELECT authz.recruiter_ids('candidate:read'))::uuid[])
  OR team_id      = ANY ((SELECT authz.team_ids('candidate:read'))::uuid[])
  OR location_id  = ANY ((SELECT authz.location_ids('candidate:read'))::uuid[])
  OR ((SELECT authz.all_teams('candidate:read'))
      AND visibility = 'all_teams' AND marketing_status IN ('active','full_of_interviews'))
);

CREATE POLICY candidate_insert ON candidate FOR INSERT TO eureka_app WITH CHECK (
  (SELECT authz.has_org('candidate:create'))
  OR team_id = ANY ((SELECT authz.team_ids('candidate:create'))::uuid[])
  OR (recruiter_id = ANY ((SELECT authz.recruiter_ids('candidate:create'))::uuid[])
      AND team_id = (SELECT authz.actor_team()))
);

-- Any update permission admits the row; the column guard (0006) decides which
-- columns each permission may change (design B4.8, N3).
CREATE POLICY candidate_update ON candidate FOR UPDATE TO eureka_app
USING (
  authz.owns('candidate:update', recruiter_id, team_id, location_id)
  OR authz.owns('candidate:assign', recruiter_id, team_id, location_id)
  OR authz.owns('candidate.visibility:update', recruiter_id, team_id, location_id)
  OR authz.owns('candidate.rating:update', recruiter_id, team_id, location_id)
)
WITH CHECK (
  authz.owns('candidate:update', recruiter_id, team_id, location_id)
  OR authz.owns('candidate:assign', recruiter_id, team_id, location_id)
  OR authz.owns('candidate.visibility:update', recruiter_id, team_id, location_id)
  OR authz.owns('candidate.rating:update', recruiter_id, team_id, location_id)
);

-- ---------- person (visible through a visible candidate) ----------
CREATE POLICY person_read ON person FOR SELECT TO eureka_app
  USING (EXISTS (SELECT 1 FROM candidate c WHERE c.person_id = person.id));
CREATE POLICY person_insert ON person FOR INSERT TO eureka_app
  WITH CHECK ((SELECT authz.has_perm('candidate:create')));
CREATE POLICY person_update ON person FOR UPDATE TO eureka_app
  USING (EXISTS (SELECT 1 FROM candidate c WHERE c.person_id = person.id
                 AND authz.owns('candidate:update', c.recruiter_id, c.team_id, c.location_id)))
  WITH CHECK (true);

-- ---------- submission ----------
CREATE POLICY submission_read ON submission FOR SELECT TO eureka_app USING (
  (SELECT authz.has_org('submission:read'))
  OR recruiter_id = ANY ((SELECT authz.recruiter_ids('submission:read'))::uuid[])
  OR team_id      = ANY ((SELECT authz.team_ids('submission:read'))::uuid[])
  OR location_id  = ANY ((SELECT authz.location_ids('submission:read'))::uuid[])
  OR authz.candidate_owned(candidate_id, 'submission:read')
);
CREATE POLICY submission_insert ON submission FOR INSERT TO eureka_app WITH CHECK (
  recruiter_id = (SELECT authz.current_user_id())
  AND authz.candidate_visible(candidate_id, 'submission:create')
);
CREATE POLICY submission_update ON submission FOR UPDATE TO eureka_app
  USING (authz.owns('submission:update', recruiter_id, team_id, location_id))
  WITH CHECK (authz.owns('submission:update', recruiter_id, team_id, location_id));

-- ---------- interview ----------
CREATE POLICY interview_read ON interview FOR SELECT TO eureka_app USING (
  (SELECT authz.has_org('interview:read'))
  OR recruiter_id = ANY ((SELECT authz.recruiter_ids('interview:read'))::uuid[])
  OR team_id      = ANY ((SELECT authz.team_ids('interview:read'))::uuid[])
  OR location_id  = ANY ((SELECT authz.location_ids('interview:read'))::uuid[])
  OR authz.candidate_owned(candidate_id, 'interview:read')
);
-- Interview creation is authorized against the parent submission (design B4.8, N4a).
CREATE POLICY interview_insert ON interview FOR INSERT TO eureka_app WITH CHECK (
  (SELECT authz.has_perm('interview:create'))
  AND EXISTS (SELECT 1 FROM submission s WHERE s.id = submission_id
              AND authz.owns('submission:update', s.recruiter_id, s.team_id, s.location_id))
);
CREATE POLICY interview_update ON interview FOR UPDATE TO eureka_app
  USING (authz.owns('interview:update', recruiter_id, team_id, location_id))
  WITH CHECK (authz.owns('interview:update', recruiter_id, team_id, location_id));

-- Worker: feedback-email job reads due interviews and marks them sent (design B4.5).
GRANT SELECT (id, candidate_id, ends_at, call_status, feedback_email_sent_at) ON interview TO eureka_worker;
GRANT UPDATE (feedback_email_sent_at) ON interview TO eureka_worker;
-- An updated row must still satisfy the SELECT policy, so the policy does not
-- filter on feedback_email_sent_at; the job's query does.
CREATE POLICY interview_worker_due ON interview FOR SELECT TO eureka_worker
  USING (call_status NOT IN ('cancelled','no_invite') AND ends_at > now() - interval '7 days');
CREATE POLICY interview_worker_mark ON interview FOR UPDATE TO eureka_worker
  USING (feedback_email_sent_at IS NULL) WITH CHECK (feedback_email_sent_at IS NOT NULL);

-- ---------- audit (append-only; read with audit:read) ----------
CREATE POLICY audit_insert ON audit_event FOR INSERT TO eureka_app, eureka_worker WITH CHECK (true);
GRANT SELECT ON audit_event TO eureka_app;
CREATE POLICY audit_read ON audit_event FOR SELECT TO eureka_app
  USING ((SELECT authz.has_perm('audit:read')));
