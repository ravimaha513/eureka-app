-- eureka.candidate_team_share_guard: current definition (repeatable; db/functions/README.md).
-- Earlier body: migration 0240. Change this file, not a new migration.

SET ROLE eureka_owner;
CREATE OR REPLACE FUNCTION eureka.candidate_team_share_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  -- Candidate delete (authz.delete_candidate, migration 0330) removes these rows.
  IF TG_OP = 'DELETE' AND current_user = 'authz_definer' THEN
    IF authz.candidate_purging() THEN RETURN OLD; END IF;
  END IF;
  IF current_user IS DISTINCT FROM 'authz_definer' THEN
    RAISE EXCEPTION 'team shares are written only by authz.set_candidate_visibility' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.shared_by := authz.current_user_id();
    NEW.shared_at := pg_catalog.now();
  ELSIF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'team shares are immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $function$
;
REVOKE ALL ON FUNCTION eureka.candidate_team_share_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eureka.candidate_team_share_guard() TO authz_definer;
RESET ROLE;
