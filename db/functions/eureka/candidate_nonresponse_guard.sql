-- eureka.candidate_nonresponse_guard: current definition (repeatable; db/functions/README.md).
-- Earlier body: migration 0171. Change this file, not a new migration.

SET ROLE eureka_owner;
CREATE OR REPLACE FUNCTION eureka.candidate_nonresponse_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  -- Candidate delete (authz.delete_candidate, migration 0320) removes these rows.
  IF TG_OP = 'DELETE' AND current_user = 'authz_definer' THEN
    IF authz.candidate_purging() THEN RETURN OLD; END IF;
  END IF;
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'non-response flags are never truncated' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF current_user IS DISTINCT FROM 'authz_definer' THEN
    RAISE EXCEPTION 'non-response flags are written only by the non-response functions' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'non-response flags are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.status := 'open';
    NEW.resolution := NULL; NEW.resolved_by := NULL; NEW.resolved_at := NULL;
    NEW.flagged_at := pg_catalog.now();
    NEW.hold_reached_at := NULL; NEW.warning_mail_sent_at := NULL; NEW.hold_mail_sent_at := NULL;
  ELSIF (NEW.candidate_id, NEW.reason, NEW.flagged_by, NEW.flagged_at)
        IS DISTINCT FROM (OLD.candidate_id, OLD.reason, OLD.flagged_by, OLD.flagged_at)
        OR (OLD.status = 'resolved' AND (NEW.status, NEW.resolution, NEW.resolved_by, NEW.resolved_at)
            IS DISTINCT FROM (OLD.status, OLD.resolution, OLD.resolved_by, OLD.resolved_at)) THEN
    RAISE EXCEPTION 'immutable non-response field' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $function$
;
REVOKE ALL ON FUNCTION eureka.candidate_nonresponse_guard() FROM PUBLIC;
RESET ROLE;
