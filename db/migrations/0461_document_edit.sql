-- Editing a document after upload (docs/documents-api.md DOC-4..DOC-6):
--   * title: an optional display name (the download name stays derived from
--     the type, so no user text reaches Content-Disposition);
--   * doc_type: another type of the SAME classification only. The stored key
--     and its encryption follow the classification (design A6.5), so moving a
--     file between internal and restricted would mean re-encrypting it;
--     that is a new upload instead (422 classification_change);
--   * replacing the file: a new file_object goes through the same quarantine
--     and scan; the current file stays the one that opens until the new one is
--     clean, then the scan finish swaps it in. The document id does not change,
--     so checklist links (checklist_item.document_id) survive.
-- Earlier files of the document are kept in previous_file_ids (never opened
-- again; authz.delete_candidate removes them with the document).
-- Rule 5: titles are free text and never reach audit_event (the API audits
-- field names, type keys and ids only).

SET ROLE eureka_owner;

ALTER TABLE eureka.document
  ADD COLUMN title             text CHECK (char_length(btrim(title)) BETWEEN 1 AND 120 AND title !~ '[[:cntrl:]]'),
  ADD COLUMN pending_file_id   uuid UNIQUE REFERENCES eureka.file_object(id),
  ADD COLUMN previous_file_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN updated_at        timestamptz,
  ADD COLUMN updated_by        uuid REFERENCES eureka.app_user(id),
  ADD COLUMN version           integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  ADD CONSTRAINT document_pending_differs CHECK (pending_file_id IS DISTINCT FROM file_id);

CREATE POLICY definer_update ON eureka.document FOR UPDATE TO authz_definer USING (true) WITH CHECK (true);
-- A replacement waiting for (or refused by) the scan is readable with its document, as the current file is.
CREATE POLICY file_object_read_pending ON eureka.file_object FOR SELECT TO eureka_app USING (
  EXISTS (SELECT 1 FROM eureka.document d WHERE d.pending_file_id = file_object.id)
);

RESET ROLE;

GRANT UPDATE (title, doc_type, file_id, pending_file_id, previous_file_ids, updated_at, updated_by, version)
  ON eureka.document TO authz_definer;

SET ROLE authz_definer;

-- API: title and/or type of a candidate's (or placement's) document. 404 when
-- the document is not visible to the caller (as authz.document_download);
-- 403 without document:upload over the candidate (and, for restricted
-- documents, document.restricted:read); 422 invalid_change /
-- classification_change; 409 version_mismatch. Returns the changed field names.
CREATE FUNCTION authz.update_document(p_document uuid, p_changes jsonb, p_expected_version integer)
RETURNS TABLE (changed text[], from_type text, to_type text, new_version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  d eureka.document%ROWTYPE;
  v_title text; v_type text; cls text;
  ch text[] := ARRAY[]::text[];
BEGIN
  IF authz.current_user_id() IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO d FROM eureka.document x WHERE x.id = p_document FOR UPDATE;
  IF NOT FOUND OR d.candidate_id IS NULL
     OR NOT coalesce(authz.candidate_visible(d.candidate_id, 'candidate:read'), false)
     OR NOT coalesce(authz.candidate_owned(d.candidate_id, 'document:read'), false)
     OR (d.classification IS DISTINCT FROM 'internal'
         AND NOT coalesce(authz.candidate_owned(d.candidate_id, 'document.restricted:read'), false)) THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT coalesce(authz.candidate_owned(d.candidate_id, 'document:upload'), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF pg_catalog.jsonb_typeof(p_changes) IS DISTINCT FROM 'object'
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.jsonb_object_keys(p_changes))
     OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_each(p_changes) e
                WHERE e.key NOT IN ('title', 'docType')
                   OR (e.key = 'title' AND pg_catalog.jsonb_typeof(e.value) NOT IN ('string', 'null'))
                   OR (e.key = 'docType' AND pg_catalog.jsonb_typeof(e.value) IS DISTINCT FROM 'string')) THEN
    RAISE EXCEPTION 'invalid_change' USING ERRCODE = 'check_violation';
  END IF;
  IF p_expected_version IS NOT NULL AND p_expected_version IS DISTINCT FROM d.version THEN
    RAISE EXCEPTION 'version_mismatch' USING ERRCODE = 'serialization_failure';
  END IF;

  v_title := CASE WHEN p_changes ? 'title' THEN nullif(pg_catalog.btrim(p_changes ->> 'title'), '') ELSE d.title END;
  v_type := CASE WHEN p_changes ? 'docType' THEN p_changes ->> 'docType' ELSE d.doc_type END;
  IF v_type IS DISTINCT FROM d.doc_type THEN
    SELECT t.classification INTO cls FROM authz.document_type t WHERE t.key = v_type;
    IF cls IS NULL THEN
      RAISE EXCEPTION 'invalid_change' USING ERRCODE = 'check_violation';
    END IF;
    IF cls IS DISTINCT FROM d.classification THEN
      RAISE EXCEPTION 'classification_change' USING ERRCODE = 'check_violation';
    END IF;
    ch := ch || 'doc_type'::text;
  END IF;
  IF v_title IS DISTINCT FROM d.title THEN ch := ch || 'title'::text; END IF;

  IF pg_catalog.cardinality(ch) > 0 THEN
    BEGIN
      UPDATE eureka.document x SET title = v_title, doc_type = v_type WHERE x.id = d.id;
    EXCEPTION WHEN check_violation THEN
      RAISE EXCEPTION 'invalid_change' USING ERRCODE = 'check_violation';
    END;
  END IF;
  RETURN QUERY SELECT ch, d.doc_type, v_type, (SELECT x.version FROM eureka.document x WHERE x.id = d.id);
END $$;

-- API: a new file for an existing document, into quarantine like any upload
-- (same visibility, permission, content type, size and pending-upload limit as
-- authz.create_document_upload). An earlier replacement still waiting is
-- dropped (kept in previous_file_ids). Returns the new file id for the
-- presigned POST.
CREATE FUNCTION authz.replace_document_file(p_document uuid, p_content_type text, p_size integer, p_expected_version integer)
RETURNS TABLE (file_id uuid, classification text, upload_expires_at timestamptz, new_version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  d eureka.document%ROWTYPE;
  f_id uuid; f_exp timestamptz;
BEGIN
  IF authz.current_user_id() IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO d FROM eureka.document x WHERE x.id = p_document FOR UPDATE;
  IF NOT FOUND OR d.candidate_id IS NULL
     OR NOT coalesce(authz.candidate_visible(d.candidate_id, 'candidate:read'), false)
     OR NOT coalesce(authz.candidate_owned(d.candidate_id, 'document:read'), false)
     OR (d.classification IS DISTINCT FROM 'internal'
         AND NOT coalesce(authz.candidate_owned(d.candidate_id, 'document.restricted:read'), false)) THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT coalesce(authz.candidate_owned(d.candidate_id, 'document:upload'), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_expected_version IS NOT NULL AND p_expected_version IS DISTINCT FROM d.version THEN
    RAISE EXCEPTION 'version_mismatch' USING ERRCODE = 'serialization_failure';
  END IF;
  IF p_content_type IS NULL OR p_size IS NULL
     OR p_content_type NOT IN ('application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                               'image/png', 'image/jpeg')
     OR NOT coalesce(p_size BETWEEN 1 AND 15728640, false) THEN
    RAISE EXCEPTION 'invalid_upload' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('document:' || d.candidate_id::text, 0));
  IF (SELECT pg_catalog.count(*) FROM eureka.document x JOIN eureka.file_object f ON f.id IN (x.file_id, x.pending_file_id)
       WHERE x.candidate_id = d.candidate_id AND f.status = 'pending' AND f.id IS DISTINCT FROM d.pending_file_id) >= 5 THEN
    RAISE EXCEPTION 'too_many_pending' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO eureka.file_object AS f (classification, content_type, size_bytes, uploaded_by, upload_expires_at)
  VALUES (d.classification, p_content_type, p_size, authz.current_user_id(), pg_catalog.now())
  RETURNING f.id, f.upload_expires_at INTO f_id, f_exp;
  UPDATE eureka.document x
     SET pending_file_id = f_id,
         previous_file_ids = CASE WHEN d.pending_file_id IS NULL THEN x.previous_file_ids ELSE x.previous_file_ids || d.pending_file_id END
   WHERE x.id = d.id;
  RETURN QUERY SELECT f_id, d.classification, f_exp, (SELECT x.version FROM eureka.document x WHERE x.id = d.id);
END $$;

-- The 0043 upload limit now also counts replacements waiting for their scan.
CREATE OR REPLACE FUNCTION authz.create_document_upload(
  p_candidate uuid, p_placement uuid, p_doc_type text, p_content_type text, p_size integer)
RETURNS TABLE (document_id uuid, file_id uuid, classification text, upload_expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  cand uuid; cls text; f_id uuid; f_exp timestamptz; d_id uuid;
  p record;
BEGIN
  IF authz.current_user_id() IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (p_candidate IS NULL) = (p_placement IS NULL) THEN
    RAISE EXCEPTION 'invalid_upload' USING ERRCODE = 'check_violation';
  END IF;
  IF p_placement IS NOT NULL THEN
    SELECT x.candidate_id, x.recruiter_id, x.team_id, x.location_id INTO p FROM eureka.placement x WHERE x.id = p_placement;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'not_found' USING ERRCODE = 'no_data_found';
    END IF;
    IF NOT coalesce(
         authz.owns('placement:read', p.recruiter_id, p.team_id, p.location_id)
         OR authz.candidate_owned(p.candidate_id, 'placement:read'), false) THEN
      RAISE EXCEPTION 'not_found' USING ERRCODE = 'no_data_found';
    END IF;
    cand := p.candidate_id;
  ELSE
    cand := p_candidate;
  END IF;
  IF NOT coalesce(authz.candidate_visible(cand, 'candidate:read'), false) THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT coalesce(authz.candidate_owned(cand, 'document:upload'), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT t.classification INTO cls FROM authz.document_type t WHERE t.key = p_doc_type;
  IF cls IS NULL THEN
    RAISE EXCEPTION 'invalid_upload' USING ERRCODE = 'check_violation';
  END IF;
  IF cls IS NOT DISTINCT FROM 'restricted' AND NOT coalesce(authz.candidate_owned(cand, 'document.restricted:read'), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_content_type IS NULL OR p_size IS NULL
     OR p_content_type NOT IN ('application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                               'image/png', 'image/jpeg')
     OR NOT coalesce(p_size BETWEEN 1 AND 15728640, false) THEN
    RAISE EXCEPTION 'invalid_upload' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('document:' || cand::text, 0));
  IF (SELECT pg_catalog.count(*) FROM eureka.document d JOIN eureka.file_object f ON f.id IN (d.file_id, d.pending_file_id)
       WHERE d.candidate_id = cand AND f.status = 'pending') >= 5 THEN
    RAISE EXCEPTION 'too_many_pending' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO eureka.file_object AS f (classification, content_type, size_bytes, uploaded_by, upload_expires_at)
  VALUES (cls, p_content_type, p_size, authz.current_user_id(), pg_catalog.now())
  RETURNING f.id, f.upload_expires_at INTO f_id, f_exp;
  INSERT INTO eureka.document AS d (candidate_id, placement_id, doc_type, classification, file_id, created_by)
  VALUES (cand, p_placement, p_doc_type, cls, f_id, authz.current_user_id())
  RETURNING d.id INTO d_id;
  INSERT INTO eureka.audit_event (actor_id, action, entity_type, entity_id, changes)
  VALUES (authz.current_user_id(), 'document.upload_requested', 'document', d_id, pg_catalog.jsonb_build_object(
    'candidateId', cand, 'placementId', p_placement, 'fileId', f_id, 'docType', p_doc_type,
    'classification', cls, 'contentType', p_content_type, 'sizeBytes', p_size));
  RETURN QUERY SELECT d_id, f_id, cls, f_exp;
END $$;

-- Worker: as 0043, and a clean replacement becomes the document's file (the
-- one it replaces moves to previous_file_ids). A refused replacement stays as
-- pending_file_id so the page can say why; the current file is untouched.
CREATE OR REPLACE FUNCTION authz.document_scan_finish(p_id uuid, p_status text, p_result text, p_sha256 text, p_size integer)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE f eureka.file_object%ROWTYPE;
BEGIN
  IF p_id IS NULL OR p_status IS NULL OR p_result IS NULL
     OR p_status NOT IN ('clean', 'infected', 'failed', 'rejected', 'expired')
     OR NOT coalesce(p_result ~ '^[A-Z_]{1,40}$', false) THEN
    RAISE EXCEPTION 'invalid_scan_result' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO f FROM eureka.file_object x WHERE x.id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF f.status IS DISTINCT FROM 'pending' THEN
    RETURN 'not_pending';
  END IF;
  IF p_status IS NOT DISTINCT FROM 'clean' THEN
    IF p_result IS DISTINCT FROM 'NO_THREATS_FOUND'
       OR p_size IS DISTINCT FROM f.size_bytes
       OR NOT coalesce(p_sha256 ~ '^[0-9a-f]{64}$', false) THEN
      RAISE EXCEPTION 'invalid_scan_result' USING ERRCODE = 'check_violation';
    END IF;
    UPDATE eureka.file_object SET status = 'clean', scan_result = p_result, sha256_hex = p_sha256 WHERE id = p_id;
    UPDATE eureka.document d
       SET previous_file_ids = d.previous_file_ids || d.file_id, file_id = p_id, pending_file_id = NULL
     WHERE d.pending_file_id = p_id;
  ELSE
    IF p_status IS NOT DISTINCT FROM 'expired' AND NOT coalesce(pg_catalog.now() > f.upload_expires_at, false) THEN
      RAISE EXCEPTION 'invalid_scan_result' USING ERRCODE = 'check_violation';
    END IF;
    UPDATE eureka.file_object SET status = p_status, scan_result = p_result WHERE id = p_id;
  END IF;
  RETURN p_status;
END $$;

RESET ROLE;

REVOKE ALL ON FUNCTION authz.update_document(uuid, jsonb, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.replace_document_file(uuid, text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.update_document(uuid, jsonb, integer) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.replace_document_file(uuid, text, integer, integer) TO eureka_app;
