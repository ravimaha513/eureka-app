-- eureka.document_write_guard: current definition (repeatable; db/functions/README.md).
-- Earlier bodies: migrations 0043, 0054. Change this file, not a new migration.

SET ROLE eureka_owner;
CREATE OR REPLACE FUNCTION eureka.document_write_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE cls text;
BEGIN
  -- Candidate delete (authz.delete_candidate, migration 0320) removes these rows.
  IF TG_OP = 'DELETE' AND current_user = 'authz_definer' THEN
    IF authz.candidate_purging() THEN RETURN OLD; END IF;
  END IF;
  IF current_user IS DISTINCT FROM 'authz_definer' THEN
    RAISE EXCEPTION 'document rows are written only by definer functions' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP IS DISTINCT FROM 'INSERT' THEN
    RAISE EXCEPTION 'document rows are not changed or deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT t.classification INTO cls FROM authz.document_type t WHERE t.key = NEW.doc_type;
  IF cls IS NULL OR NOT EXISTS (
       SELECT 1 FROM eureka.file_object f WHERE f.id = NEW.file_id AND f.classification = cls AND f.status = 'pending') THEN
    RAISE EXCEPTION 'document type and file do not match' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.placement_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM eureka.placement p WHERE p.id = NEW.placement_id AND p.candidate_id = NEW.candidate_id) THEN
    RAISE EXCEPTION 'placement belongs to another candidate' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.bill_id IS NOT NULL AND (cls IS DISTINCT FROM 'internal' OR NEW.candidate_id IS NOT NULL OR NEW.placement_id IS NOT NULL) THEN
    RAISE EXCEPTION 'a bill invoice is an internal document of the bill only' USING ERRCODE = 'check_violation';
  END IF;
  NEW.classification := cls;
  NEW.created_by := authz.current_user_id();
  NEW.created_at := pg_catalog.now();
  RETURN NEW;
END $function$
;
REVOKE ALL ON FUNCTION eureka.document_write_guard() FROM PUBLIC;
RESET ROLE;
