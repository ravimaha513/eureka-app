-- Saved views for the Candidates list as well as the Hot List, and views shared with the team
-- (filters UI, docs/candidates-api.md "Saved views").
--   * list: which list a view belongs to ('hotlist' | 'candidates'); set on insert, never changed.
--     A name is unique per owner and list.
--   * shared: the owner shares the view with their team. shared_team_id is server-managed (rule 4):
--     the guard sets it to the owner's current team (membership, else the team they lead) when the
--     view is shared, NULL otherwise. Teammates can read a shared view; only the owner changes or
--     deletes it. Reading a view grants nothing: the list still applies the reader's own scope.
--   * filters may now carry value lists, so the size cap goes from 2 KB to 8 KB.
SET search_path = eureka, public;
SET ROLE eureka_owner;

ALTER TABLE eureka.hotlist_view
  ADD COLUMN list           text NOT NULL DEFAULT 'hotlist' CHECK (list IN ('hotlist', 'candidates')),
  ADD COLUMN shared         boolean NOT NULL DEFAULT false,
  ADD COLUMN shared_team_id uuid REFERENCES eureka.team(id),
  ADD CONSTRAINT hotlist_view_shared_team CHECK (shared = (shared_team_id IS NOT NULL));

ALTER TABLE eureka.hotlist_view DROP CONSTRAINT hotlist_view_filters_check;
ALTER TABLE eureka.hotlist_view ADD CONSTRAINT hotlist_view_filters_check
  CHECK (jsonb_typeof(filters) = 'object' AND pg_column_size(filters) <= 8192);

DROP INDEX eureka.hotlist_view_owner_name;
CREATE UNIQUE INDEX hotlist_view_owner_name ON eureka.hotlist_view (owner_id, list, lower(name));
CREATE INDEX hotlist_view_shared_team ON eureka.hotlist_view (shared_team_id) WHERE shared_team_id IS NOT NULL;

-- The team a view is shared with: the caller's current team (a user is in at most one at a time),
-- else the first team they lead. NULL when they have neither.
CREATE FUNCTION eureka.hotlist_view_share_team(me uuid) RETURNS uuid
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce(
    (SELECT tm.team_id FROM eureka.team_member tm WHERE tm.user_id = me AND tm.valid @> pg_catalog.now() LIMIT 1),
    (SELECT t.id FROM eureka.team t WHERE t.lead_id = me AND t.deleted_at IS NULL ORDER BY t.id LIMIT 1))
$$;
REVOKE ALL ON FUNCTION eureka.hotlist_view_share_team(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eureka.hotlist_view_share_team(uuid) TO eureka_app; -- called by the view guards

CREATE OR REPLACE FUNCTION eureka.hotlist_view_insert_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE me uuid := authz.current_user_id();
BEGIN
  IF me IS NULL OR NEW.owner_id IS DISTINCT FROM me THEN
    RAISE EXCEPTION 'server_managed_field' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.created_at := pg_catalog.now();
  NEW.updated_at := pg_catalog.now();
  NEW.shared_team_id := NULL;
  IF NEW.shared THEN
    NEW.shared_team_id := eureka.hotlist_view_share_team(me);
    IF NEW.shared_team_id IS NULL THEN
      RAISE EXCEPTION 'no_team' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('hotlist_view:' || me::text));
  IF coalesce((SELECT count(*) FROM eureka.hotlist_view v WHERE v.owner_id = me), 0) >= 50 THEN
    RAISE EXCEPTION 'too_many_views' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION eureka.hotlist_view_update_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.list IS DISTINCT FROM OLD.list THEN
    RAISE EXCEPTION 'server_managed_field' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.updated_at := pg_catalog.now();
  IF NOT NEW.shared THEN
    NEW.shared_team_id := NULL;
  ELSIF NOT OLD.shared OR NEW.shared_team_id IS DISTINCT FROM OLD.shared_team_id THEN
    -- Newly shared (or a client tried to move it): always the owner's current team.
    NEW.shared_team_id := eureka.hotlist_view_share_team(OLD.owner_id);
    IF NEW.shared_team_id IS NULL THEN
      RAISE EXCEPTION 'no_team' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- Teammates read shared views. Uncorrelated subqueries on the caller's teams (InitPlan / hashed
-- subplan, rule 3); the owner policy (FOR ALL) still alone governs insert, update and delete.
CREATE POLICY hotlist_view_team_read ON eureka.hotlist_view FOR SELECT TO eureka_app
  USING (shared_team_id IN (
    SELECT tm.team_id FROM eureka.team_member tm
     WHERE tm.user_id = (SELECT authz.current_user_id()) AND tm.valid @> now()
    UNION ALL
    SELECT t.id FROM eureka.team t WHERE t.lead_id = (SELECT authz.current_user_id()) AND t.deleted_at IS NULL));

GRANT INSERT (name, filters, list, shared), UPDATE (name, filters, shared) ON eureka.hotlist_view TO eureka_app;

RESET ROLE;
