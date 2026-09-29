-- Hot List visibility policy (OD-01, decided 2026-09-29).
-- The value comes from HOTLIST_VISIBILITY in packages/shared (catalog) and is
-- written by the migration runner on every deploy, like role grants.
--   everyone: every signed-in user sees every candidate in a Hot List status
--   team:     AS-07 (the candidate_read policy alone decides)
-- Only the Hot List rows become readable; candidate updates, submissions,
-- interviews and placements keep their own policies.
SET ROLE authz_definer;

CREATE TABLE authz.policy_setting (
  key   text PRIMARY KEY,
  value text NOT NULL
);
INSERT INTO authz.policy_setting (key, value) VALUES ('hotlist_visibility', 'team');

CREATE FUNCTION authz.hotlist_open() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT authz.current_user_id() IS NOT NULL AND EXISTS (
    SELECT 1 FROM authz.policy_setting WHERE key = 'hotlist_visibility' AND value = 'everyone')
$$;
REVOKE ALL ON FUNCTION authz.hotlist_open() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.hotlist_open() TO eureka_app;

RESET ROLE;

SET search_path = eureka, public;
CREATE POLICY candidate_hotlist_read ON candidate FOR SELECT TO eureka_app USING (
  (SELECT authz.hotlist_open())
  AND marketing_status IN ('active', 'on_hold', 'full_of_interviews', 'confirmation', 'bench', 'stopped')
);
