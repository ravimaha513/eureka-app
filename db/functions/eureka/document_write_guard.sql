-- eureka.document_write_guard: current definition (repeatable; db/functions/README.md).
-- Earlier bodies: migrations 0043, 0054. Change this file, not a new migration.
-- Updates (migration 0421): title, a type of the same classification, a replacement file
-- (pending_file_id) and its swap-in once clean; owner, classification and creation stay fixed.

SET ROLE eureka_owner;
CREATE OR REPLACE FUNCTION eureka.document_write_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE cls text;
BEGIN
  -- Candidate delete (authz.delete_candidate, migration 0330) removes these rows.
  IF TG_OP = 'DELETE' AND current_user = 'authz_definer' THEN
    IF authz.candidate_purging() THEN RETURN OLD; END IF;
  END IF;
  IF current_user IS DISTINCT FROM 'authz_definer' THEN
    RAISE EXCEPTION 'document rows are written only by definer functions' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'document rows are not deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.id, NEW.candidate_id, NEW.placement_id, NEW.bill_id, NEW.classification, NEW.created_by, NEW.created_at)
       IS DISTINCT FROM
       (OLD.id, OLD.candidate_id, OLD.placement_id, OLD.bill_id, OLD.classification, OLD.created_by, OLD.created_at) THEN
      RAISE EXCEPTION 'column is immutable' USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- Another type, of the same classification (the stored key and encryption follow it).
    IF NEW.doc_type IS DISTINCT FROM OLD.doc_type
       AND NOT EXISTS (SELECT 1 FROM authz.document_type t WHERE t.key = NEW.doc_type AND t.classification = OLD.classification) THEN
      RAISE EXCEPTION 'document type and file do not match' USING ERRCODE = 'check_violation';
    END IF;
    -- Earlier files are only ever appended.
    IF NEW.previous_file_ids[1:pg_catalog.cardinality(OLD.previous_file_ids)] IS DISTINCT FROM OLD.previous_file_ids THEN
      RAISE EXCEPTION 'previous files are append-only' USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- The file changes only to the clean replacement, and the old one is kept.
    IF NEW.file_id IS DISTINCT FROM OLD.file_id THEN
      IF NEW.file_id IS DISTINCT FROM OLD.pending_file_id OR NEW.pending_file_id IS NOT NULL
         OR NOT (OLD.file_id = ANY (NEW.previous_file_ids))
         OR NOT EXISTS (SELECT 1 FROM eureka.file_object f WHERE f.id = NEW.file_id AND f.status = 'clean'
                          AND f.classification = OLD.classification) THEN
        RAISE EXCEPTION 'a document file is replaced only by its clean replacement' USING ERRCODE = 'check_violation';
      END IF;
    -- A new replacement: a fresh upload of the same classification.
    ELSIF NEW.pending_file_id IS DISTINCT FROM OLD.pending_file_id THEN
      IF NEW.pending_file_id IS NULL OR NOT EXISTS (
           SELECT 1 FROM eureka.file_object f WHERE f.id = NEW.pending_file_id AND f.status = 'pending'
             AND f.classification = OLD.classification) THEN
        RAISE EXCEPTION 'document type and file do not match' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    NEW.version := OLD.version + 1;
    NEW.updated_at := pg_catalog.now();
    NEW.updated_by := authz.current_user_id();
    RETURN NEW;
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
  NEW.pending_file_id := NULL; NEW.previous_file_ids := '{}';
  NEW.updated_at := NULL; NEW.updated_by := NULL; NEW.version := 1;
  RETURN NEW;
END $function$
;
REVOKE ALL ON FUNCTION eureka.document_write_guard() FROM PUBLIC;
RESET ROLE;
