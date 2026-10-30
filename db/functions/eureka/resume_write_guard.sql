-- eureka.resume_write_guard: current definition (repeatable; db/functions/README.md).
-- Earlier body: migration 0036. Change this file, not a new migration.

SET ROLE eureka_owner;
CREATE OR REPLACE FUNCTION eureka.resume_write_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  -- Candidate delete (authz.delete_candidate, migration 0320) removes these rows.
  IF TG_OP = 'DELETE' AND current_user = 'authz_definer' THEN
    IF authz.candidate_purging() THEN RETURN OLD; END IF;
  END IF;
  IF current_user IS DISTINCT FROM 'authz_definer' THEN
    RAISE EXCEPTION 'resume rows are written only by definer functions' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'resume rows are not deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.status := 'pending';
    NEW.scan_result := NULL;
    NEW.sha256_hex := NULL;
    NEW.version := NULL;
    NEW.is_current := false;
    NEW.uploaded_by := authz.current_user_id();
    NEW.created_at := pg_catalog.now();
    NEW.upload_expires_at := pg_catalog.now() + interval '5 minutes';
    NEW.scanned_at := NULL;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.candidate_id, NEW.content_type, NEW.size_bytes, NEW.uploaded_by, NEW.created_at, NEW.upload_expires_at)
     IS DISTINCT FROM
     (OLD.id, OLD.candidate_id, OLD.content_type, OLD.size_bytes, OLD.uploaded_by, OLD.created_at, OLD.upload_expires_at) THEN
    RAISE EXCEPTION 'column is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status IS NOT DISTINCT FROM 'pending' THEN
    IF NEW.status IS NOT DISTINCT FROM 'pending' THEN
      RAISE EXCEPTION 'a scan result must leave pending' USING ERRCODE = 'check_violation';
    END IF;
    NEW.scanned_at := pg_catalog.now();
    RETURN NEW;
  END IF;
  IF (NEW.status, NEW.scan_result, NEW.sha256_hex, NEW.version, NEW.scanned_at)
     IS DISTINCT FROM (OLD.status, OLD.scan_result, OLD.sha256_hex, OLD.version, OLD.scanned_at)
     OR coalesce(NEW.is_current AND NOT OLD.is_current, true) THEN
    RAISE EXCEPTION 'a scanned resume is final' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $function$
;
REVOKE ALL ON FUNCTION eureka.resume_write_guard() FROM PUBLIC;
RESET ROLE;
