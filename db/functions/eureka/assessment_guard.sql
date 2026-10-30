-- eureka.assessment_guard: current definition (repeatable; db/functions/README.md).
-- Earlier body: migration 0170. Change this file, not a new migration.

SET ROLE eureka_owner;
CREATE OR REPLACE FUNCTION eureka.assessment_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  -- Candidate delete (authz.delete_candidate, migration 0330) removes these rows.
  IF TG_OP = 'DELETE' AND current_user = 'authz_definer' THEN
    IF authz.candidate_purging() THEN RETURN OLD; END IF;
  END IF;
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'assessments are never truncated' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF current_user IS DISTINCT FROM 'authz_definer' THEN
    RAISE EXCEPTION 'assessments are written only by the assessment functions' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'assessments are never deleted (cancel instead)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.candidate_id := (SELECT s.candidate_id FROM eureka.submission s WHERE s.id = NEW.submission_id);
    NEW.created_at := pg_catalog.now();
    NEW.updated_at := NEW.created_at;
    NEW.updated_by := NEW.created_by;
    NEW.row_version := 1;
  ELSE
    IF NEW.submission_id IS DISTINCT FROM OLD.submission_id OR NEW.candidate_id IS DISTINCT FROM OLD.candidate_id
       OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'immutable assessment field' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.updated_at := pg_catalog.now();
    NEW.row_version := OLD.row_version + 1;
  END IF;
  RETURN NEW;
END $function$
;
REVOKE ALL ON FUNCTION eureka.assessment_guard() FROM PUBLIC;
RESET ROLE;
