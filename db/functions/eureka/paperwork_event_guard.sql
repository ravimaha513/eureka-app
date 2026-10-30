-- eureka.paperwork_event_guard: current definition (repeatable; db/functions/README.md).
-- Earlier body: migration 0044. Change this file, not a new migration.

SET ROLE eureka_owner;
CREATE OR REPLACE FUNCTION eureka.paperwork_event_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  -- Candidate delete (authz.delete_candidate, migration 0320) removes these rows.
  IF TG_OP = 'DELETE' AND current_user = 'authz_definer' THEN
    IF authz.candidate_purging() THEN RETURN OLD; END IF;
  END IF;
  IF current_user IS DISTINCT FROM 'authz_definer' OR TG_OP IS DISTINCT FROM 'INSERT' THEN
    RAISE EXCEPTION 'paperwork history is append-only and written by the database'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.at := pg_catalog.now();
  NEW.actor_id := authz.current_user_id();
  RETURN NEW;
END $function$
;
REVOKE ALL ON FUNCTION eureka.paperwork_event_guard() FROM PUBLIC;
RESET ROLE;
