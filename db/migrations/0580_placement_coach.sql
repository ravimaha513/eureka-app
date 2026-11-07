-- Placement coach snapshot for the dashboard's Coach filter and grouping
-- (docs/dashboards-api.md "Coach and technology").
--   `placement.coach_id`: the interview coach of the submission's final coached
--   round, taken when the placement is created (authz.create_placement, since:
--   0580). Final round = the latest interview of the submission that took place
--   or is planned (not cancelled, rescheduled or no_invite) and has a coach.
--   A placement is the client's confirmation after the final round, so it is
--   attributed to that round's coach; cleared L1/L2 rounds are counted
--   separately (interviewsCleared) and never count as placements.
--   A snapshot (like technology_id, 0160) so every placement:read holder can
--   filter by it (BU Head has no interview:read) and later interview edits do
--   not move placed counts. Back-filled for existing rows with the same rule.
-- Ids only; nothing reaches audit_event or outbox_event (rule 5).
SET search_path = eureka, public;

SET ROLE eureka_owner;

ALTER TABLE eureka.placement ADD COLUMN coach_id uuid REFERENCES eureka.app_user(id);
CREATE INDEX placement_coach ON eureka.placement (coach_id);

-- Back-fill. The owner reads and writes both tables directly for this one
-- statement; the write guard and FORCE are restored in the same transaction.
ALTER TABLE eureka.placement DISABLE TRIGGER placement_write_guard;
ALTER TABLE eureka.placement NO FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.interview NO FORCE ROW LEVEL SECURITY;
UPDATE eureka.placement p SET coach_id = (
    SELECT i.coach_id FROM eureka.interview i
    WHERE i.submission_id = p.submission_id AND i.coach_id IS NOT NULL
      AND i.call_status NOT IN ('cancelled', 'rescheduled', 'no_invite')
    ORDER BY i.starts_at DESC, i.id DESC LIMIT 1)
  WHERE p.coach_id IS NULL;
ALTER TABLE eureka.interview FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.placement FORCE ROW LEVEL SECURITY;
ALTER TABLE eureka.placement ENABLE TRIGGER placement_write_guard;

RESET ROLE;
