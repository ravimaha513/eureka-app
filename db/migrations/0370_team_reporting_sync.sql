-- A team member reports to the team's lead.
-- Hierarchy scope (authz.team_ids 'hierarchy', scope_user_ids, 0210) follows
-- reporting_line, but the team drawer and My team only wrote team_member: an AD
-- who added a manager to their team, and a manager who added their leads, never
-- became their manager, so the AD saw none of the manager's Hot List or
-- candidates. Now the team is the reporting line:
--   1. eureka.team_reporting_sync: after a current team_member row is inserted
--      (authz.team_add_member, admin_add_team_member, move_team_member, bulk
--      import, org chart team adds), the member reports to the team's lead;
--      after team.lead_id changes (admin_set_team_lead), every current member
--      reports to the new lead. A line that already points at the lead is left
--      alone. A move that would close a loop is refused as 'cycle' (the API
--      maps it to 422).
--   2. Backfill: every current member of a team reports to its lead. Rows that
--      would close a loop, or whose lead or member is not active, are skipped.
-- Removing someone from a team leaves their reporting line as it was.
-- Tests: apps/api/test/team-reporting-sync.db.int.test.ts.
SET ROLE eureka_owner;

CREATE FUNCTION eureka.set_manager_to_lead(p_user uuid, p_lead uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_user IS NULL OR p_lead IS NULL OR p_user = p_lead THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM eureka.reporting_line rl
             WHERE rl.user_id = p_user AND rl.manager_id = p_lead AND rl.valid @> pg_catalog.now()) THEN
    RETURN;
  END IF;
  -- As authz.ended: end at now(); a line that starts later becomes empty.
  UPDATE eureka.reporting_line
     SET valid = CASE WHEN pg_catalog.lower_inf(valid) OR pg_catalog.lower(valid) <= pg_catalog.now()
                      THEN pg_catalog.tstzrange(pg_catalog.lower(valid), pg_catalog.now())
                      ELSE 'empty'::pg_catalog.tstzrange END
   WHERE user_id = p_user AND (pg_catalog.upper_inf(valid) OR pg_catalog.upper(valid) > pg_catalog.now());
  BEGIN
    INSERT INTO eureka.reporting_line (user_id, manager_id) VALUES (p_user, p_lead);
  EXCEPTION WHEN check_violation THEN
    RAISE EXCEPTION 'cycle' USING ERRCODE = 'check_violation';
  END;
END $$;

CREATE FUNCTION eureka.team_reporting_sync() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE m uuid;
BEGIN
  IF TG_TABLE_NAME = 'team_member' THEN
    IF NEW.valid @> pg_catalog.now() THEN
      PERFORM eureka.set_manager_to_lead(NEW.user_id, (SELECT t.lead_id FROM eureka.team t WHERE t.id = NEW.team_id));
    END IF;
  ELSIF NEW.lead_id IS DISTINCT FROM OLD.lead_id THEN
    FOR m IN SELECT tm.user_id FROM eureka.team_member tm
              WHERE tm.team_id = NEW.id AND tm.valid @> pg_catalog.now() LOOP
      PERFORM eureka.set_manager_to_lead(m, NEW.lead_id);
    END LOOP;
  END IF;
  RETURN NULL;
END $$;

REVOKE ALL ON FUNCTION eureka.set_manager_to_lead(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION eureka.team_reporting_sync() FROM PUBLIC;

CREATE TRIGGER team_member_reporting AFTER INSERT ON eureka.team_member
  FOR EACH ROW EXECUTE FUNCTION eureka.team_reporting_sync();
CREATE TRIGGER team_lead_reporting AFTER UPDATE OF lead_id ON eureka.team
  FOR EACH ROW EXECUTE FUNCTION eureka.team_reporting_sync();

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT tm.user_id, t.lead_id FROM eureka.team_member tm
      JOIN eureka.team t ON t.id = tm.team_id
      JOIN eureka.app_user mu ON mu.id = tm.user_id AND mu.status = 'active'
      JOIN eureka.app_user lu ON lu.id = t.lead_id AND lu.status = 'active'
     WHERE tm.valid @> pg_catalog.now() AND tm.user_id <> t.lead_id
     ORDER BY tm.user_id
  LOOP
    BEGIN
      PERFORM eureka.set_manager_to_lead(r.user_id, r.lead_id);
    EXCEPTION WHEN check_violation THEN
      RAISE NOTICE 'team_reporting_sync: skipped % -> % (cycle)', r.user_id, r.lead_id;
    END;
  END LOOP;
END $$;

RESET ROLE;
