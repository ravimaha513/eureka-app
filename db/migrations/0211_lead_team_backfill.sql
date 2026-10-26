-- Back-fill for 0210: before it, authz.actor_team picked a lead's membership
-- before the team they lead, so candidates, submissions and client jobs a lead
-- created while also a member of another team (their manager's) were stamped
-- with that team. Move those rows to the lead's own team (the one actor_team
-- now returns), and re-copy the snapshot onto the rows derived from them
-- (interview, placement <- submission; bgc, checklist_item <- placement).
--
-- A row moves when its actor (candidate.recruiter_id, submission.recruiter_id,
-- job.owner_id) leads a team now, the row's team is not one they lead, and they
-- are or were a member of that team. Caveat: a recruiter later promoted to
-- lead who is still on record as a member of their old team has their earlier
-- rows moved too; there is no lead history to tell the two apart.
--
-- This is a correction, not a reassignment: guards, history and timeline
-- triggers are off for these statements (team_assigned_at and the candidate
-- timeline are left as they were). Triggers and FORCE are restored in the same
-- transaction. Tests: apps/api/test/hierarchy-scope.db.int.test.ts.
SET ROLE eureka_owner;

ALTER TABLE eureka.candidate DISABLE TRIGGER candidate_column_guard;
ALTER TABLE eureka.candidate DISABLE TRIGGER candidate_profile_guard;
ALTER TABLE eureka.candidate DISABLE TRIGGER candidate_event_update;
ALTER TABLE eureka.submission DISABLE TRIGGER submission_immutable;
ALTER TABLE eureka.submission DISABLE TRIGGER candidate_event_update;
ALTER TABLE eureka.interview DISABLE TRIGGER interview_immutable;
ALTER TABLE eureka.interview DISABLE TRIGGER candidate_event_update;
ALTER TABLE eureka.placement DISABLE TRIGGER placement_write_guard;
ALTER TABLE eureka.placement DISABLE TRIGGER candidate_event_update;
ALTER TABLE eureka.bgc DISABLE TRIGGER bgc_write_guard;
ALTER TABLE eureka.bgc DISABLE TRIGGER bgc_history;
ALTER TABLE eureka.checklist_item DISABLE TRIGGER checklist_item_write_guard;
ALTER TABLE eureka.checklist_item DISABLE TRIGGER checklist_item_history;
ALTER TABLE eureka.job DISABLE TRIGGER job_guard;

ALTER TABLE eureka.candidate NO FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.submission NO FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.interview NO FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.placement NO FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.bgc NO FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.checklist_item NO FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.job NO FORCE ROW LEVEL SECURITY;

-- (lead, team they were stamped with) -> the team they lead (lowest id, as actor_team).
CREATE TEMP TABLE lead_team_move ON COMMIT DROP AS
SELECT DISTINCT tm.user_id AS lead_id, tm.team_id AS from_team,
       (SELECT t.id FROM eureka.team t WHERE t.lead_id = tm.user_id ORDER BY t.id LIMIT 1) AS to_team
  FROM eureka.team_member tm
 WHERE EXISTS (SELECT 1 FROM eureka.team t WHERE t.lead_id = tm.user_id)
   AND NOT EXISTS (SELECT 1 FROM eureka.team t WHERE t.id = tm.team_id AND t.lead_id = tm.user_id);

UPDATE eureka.candidate c SET team_id = m.to_team
  FROM lead_team_move m WHERE c.recruiter_id = m.lead_id AND c.team_id = m.from_team;
UPDATE eureka.submission s SET team_id = m.to_team
  FROM lead_team_move m WHERE s.recruiter_id = m.lead_id AND s.team_id = m.from_team;
UPDATE eureka.job j SET team_id = m.to_team
  FROM lead_team_move m WHERE j.owner_id = m.lead_id AND j.team_id = m.from_team;

-- Snapshots are copied at insert and immutable, so they differ only where moved above.
UPDATE eureka.interview i SET team_id = s.team_id
  FROM eureka.submission s WHERE s.id = i.submission_id AND i.team_id IS DISTINCT FROM s.team_id;
UPDATE eureka.placement p SET team_id = s.team_id
  FROM eureka.submission s WHERE s.id = p.submission_id AND p.team_id IS DISTINCT FROM s.team_id;
UPDATE eureka.bgc b SET team_id = p.team_id
  FROM eureka.placement p WHERE p.id = b.placement_id AND b.team_id IS DISTINCT FROM p.team_id;
UPDATE eureka.checklist_item i SET team_id = p.team_id
  FROM eureka.placement p WHERE p.id = i.placement_id AND i.team_id IS DISTINCT FROM p.team_id;

ALTER TABLE eureka.job FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.checklist_item FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.bgc FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.placement FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.interview FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.submission FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.candidate FORCE ROW LEVEL SECURITY;

ALTER TABLE eureka.job ENABLE TRIGGER job_guard;
ALTER TABLE eureka.checklist_item ENABLE TRIGGER checklist_item_history;
ALTER TABLE eureka.checklist_item ENABLE TRIGGER checklist_item_write_guard;
ALTER TABLE eureka.bgc ENABLE TRIGGER bgc_history;
ALTER TABLE eureka.bgc ENABLE TRIGGER bgc_write_guard;
ALTER TABLE eureka.placement ENABLE TRIGGER candidate_event_update;
ALTER TABLE eureka.placement ENABLE TRIGGER placement_write_guard;
ALTER TABLE eureka.interview ENABLE TRIGGER candidate_event_update;
ALTER TABLE eureka.interview ENABLE TRIGGER interview_immutable;
ALTER TABLE eureka.submission ENABLE TRIGGER candidate_event_update;
ALTER TABLE eureka.submission ENABLE TRIGGER submission_immutable;
ALTER TABLE eureka.candidate ENABLE TRIGGER candidate_event_update;
ALTER TABLE eureka.candidate ENABLE TRIGGER candidate_profile_guard;
ALTER TABLE eureka.candidate ENABLE TRIGGER candidate_column_guard;

RESET ROLE;
