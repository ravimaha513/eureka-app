-- eureka.work_authorization_notice_guard: current definition (repeatable; db/functions/README.md).
-- Earlier body: migration 0042. Change this file, not a new migration.

SET ROLE eureka_owner;
CREATE OR REPLACE FUNCTION eureka.work_authorization_notice_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  -- Candidate delete (authz.delete_candidate, migration 0330) removes these rows.
  IF TG_OP = 'DELETE' AND current_user = 'authz_definer' THEN
    IF authz.candidate_purging() THEN RETURN OLD; END IF;
  END IF;
  IF TG_OP IS DISTINCT FROM 'INSERT' OR current_user IS DISTINCT FROM 'authz_definer' THEN
    RAISE EXCEPTION 'expiry notices are only added, by the expiry job' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.created_at := pg_catalog.now();
  RETURN NEW;
END $function$
;
REVOKE ALL ON FUNCTION eureka.work_authorization_notice_guard() FROM PUBLIC;
RESET ROLE;
