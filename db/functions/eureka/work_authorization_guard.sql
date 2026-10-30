-- eureka.work_authorization_guard: current definition (repeatable; db/functions/README.md).
-- Earlier bodies: migrations 0042, 0047. Change this file, not a new migration.

SET ROLE eureka_owner;
CREATE OR REPLACE FUNCTION eureka.work_authorization_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE actor uuid := authz.current_user_id();
BEGIN
  -- Candidate delete (authz.delete_candidate, migration 0330) removes these rows.
  IF TG_OP = 'DELETE' AND current_user = 'authz_definer' THEN
    IF authz.candidate_purging() THEN RETURN OLD; END IF;
  END IF;
  IF current_user IS DISTINCT FROM 'authz_definer' THEN
    RAISE EXCEPTION 'work authorization rows are written only by definer functions' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'work authorization rows are not deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF actor IS NULL THEN
      RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.row_version := 1;
    NEW.created_by := actor;
    NEW.updated_by := actor;
    NEW.created_at := pg_catalog.now();
    NEW.updated_at := pg_catalog.now();
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.person_id, NEW.created_by, NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.person_id, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'column is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF actor IS NULL THEN
    IF (NEW.auth_type, NEW.valid_from, NEW.valid_to, NEW.status, NEW.row_version, NEW.updated_by, NEW.updated_at, NEW.number_mac)
       IS DISTINCT FROM (OLD.auth_type, OLD.valid_from, OLD.valid_to, OLD.status, OLD.row_version, OLD.updated_by, OLD.updated_at, OLD.number_mac)
       OR NEW.number_enc IS NULL OR OLD.number_enc IS NULL THEN
      RAISE EXCEPTION 'key rotation changes only the ciphertext' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  NEW.row_version := OLD.row_version + 1;
  NEW.updated_by := actor;
  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END $function$
;
REVOKE ALL ON FUNCTION eureka.work_authorization_guard() FROM PUBLIC;
RESET ROLE;
