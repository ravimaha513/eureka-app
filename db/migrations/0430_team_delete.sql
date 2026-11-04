-- An admin (access:manage) deletes a team (docs/admin-api.md AD-15).
--
-- A team is referenced by history that must survive it (submissions, interviews,
-- placements, paperwork and BGC snapshots, jobs), so a delete is soft:
--   1. eureka.team.deleted_at marks it deleted and lead_id is cleared at the same
--      moment (CHECK team_deleted_no_lead). Every "teams I lead" lookup
--      (authz.team_ids, owned_team_ids, actor_team, access.service, the
--      lead_of_team refusal on deactivation, ...) compares lead_id, so a deleted
--      team silently grants no scope and holds nobody as its lead.
--   2. eureka.team_deleted_guard refuses writes that point at a deleted team:
--      new memberships, coach assignments, team shares, candidates put in it, and
--      any further update of the team row (rename, lead change, undelete), as
--      'team_not_found' (404).
--   3. eureka.team_delete is the transaction marker (the eureka.candidate_purge
--      pattern, 0330) that lets authz.admin_delete_team move or clear candidates'
--      team (eureka.candidate_column_guard) and drop the team's shares
--      (eureka.candidate_team_share_guard) without candidate:assign, which an
--      admin does not hold.
--   4. Team pickers skip deleted teams: authz.import_team_for and the
--      invalid_team check of authz.set_candidate_visibility.
-- In db/functions: authz.admin_delete_team, authz.admin_team_delete_impact (new);
-- eureka.candidate_column_guard, eureka.candidate_team_share_guard (marker).
SET ROLE eureka_owner;
ALTER TABLE eureka.team ADD COLUMN deleted_at timestamptz;
ALTER TABLE eureka.team ALTER COLUMN lead_id DROP NOT NULL;
ALTER TABLE eureka.team ADD CONSTRAINT team_deleted_no_lead CHECK ((deleted_at IS NULL) = (lead_id IS NOT NULL));

CREATE TABLE eureka.team_delete (
  xact    xid8 NOT NULL,
  pid     integer NOT NULL,
  team_id uuid NOT NULL,
  PRIMARY KEY (xact, pid)
);
ALTER TABLE eureka.team_delete ENABLE ROW LEVEL SECURITY;
ALTER TABLE eureka.team_delete FORCE ROW LEVEL SECURITY;
CREATE POLICY definer_all ON eureka.team_delete FOR ALL TO authz_definer USING (true) WITH CHECK (true);

CREATE FUNCTION eureka.team_deleted_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME = 'team' THEN
    IF OLD.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'team_not_found' USING ERRCODE = 'no_data_found';
    END IF;
  ELSIF NEW.team_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM eureka.team t WHERE t.id = NEW.team_id AND t.deleted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'team_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION eureka.team_deleted_guard() FROM PUBLIC;

CREATE TRIGGER team_deleted_guard BEFORE UPDATE ON eureka.team
  FOR EACH ROW EXECUTE FUNCTION eureka.team_deleted_guard();
CREATE TRIGGER team_deleted_guard BEFORE INSERT ON eureka.team_member
  FOR EACH ROW EXECUTE FUNCTION eureka.team_deleted_guard();
CREATE TRIGGER team_deleted_guard BEFORE INSERT ON eureka.coach_assignment
  FOR EACH ROW EXECUTE FUNCTION eureka.team_deleted_guard();
CREATE TRIGGER team_deleted_guard BEFORE INSERT ON eureka.candidate_team_share
  FOR EACH ROW EXECUTE FUNCTION eureka.team_deleted_guard();
CREATE TRIGGER team_deleted_guard BEFORE INSERT OR UPDATE OF team_id ON eureka.candidate
  FOR EACH ROW EXECUTE FUNCTION eureka.team_deleted_guard();
RESET ROLE;

GRANT SELECT, INSERT, DELETE ON eureka.team_delete TO authz_definer;
GRANT SELECT (deleted_at) ON eureka.team TO authz_definer;
GRANT UPDATE (lead_id, deleted_at) ON eureka.team TO authz_definer;

SET ROLE authz_definer;
CREATE FUNCTION authz.team_deleting(p_team uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT p_team IS NOT NULL AND EXISTS (
    SELECT 1 FROM eureka.team_delete d
     WHERE d.xact = pg_catalog.pg_current_xact_id_if_assigned() AND d.pid = pg_catalog.pg_backend_pid()
       AND d.team_id = p_team)
$$;
REVOKE ALL ON FUNCTION authz.team_deleting(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION authz.import_team_for(p_map jsonb, p_cell text)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  cell constant text := authz.import_label(p_cell);
  k text; ids uuid[];
BEGIN
  IF cell = '' THEN RETURN NULL; END IF;
  k := authz.import_label(coalesce(authz.import_map_entry(p_map -> 'teams', cell) #>> '{}', p_cell));
  SELECT pg_catalog.array_agg(t.id) INTO ids FROM eureka.team t WHERE t.deleted_at IS NULL AND authz.import_label(t.name) = k;
  IF ids IS NULL THEN
    SELECT pg_catalog.array_agg(t.id) INTO ids FROM eureka.team t JOIN eureka.app_user u ON u.id = t.lead_id
     WHERE authz.import_label(u.display_name) = k;
  END IF;
  RETURN CASE WHEN coalesce(pg_catalog.cardinality(ids), 0) = 1 THEN ids[1] END;
END $function$;

CREATE OR REPLACE FUNCTION authz.set_candidate_visibility(p_candidate uuid, p_visibility text, p_teams uuid[])
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
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
               WHERE NOT EXISTS (SELECT 1 FROM eureka.team tm WHERE tm.id = t AND tm.deleted_at IS NULL)) THEN
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
END $function$;
RESET ROLE;
