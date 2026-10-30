-- API: authorizes one download (or in-app view) of a document's file and logs
-- it (access log + audit, same transaction). Not visible (candidate,
-- document:read or, for restricted documents, document.restricted:read) ->
-- not_found. The role and scope checks decide: a step-up grant is recorded
-- when the session holds one but is not required (Google gives unverified
-- apps no auth_time, so Google users could never step up). File not clean ->
-- 'not_available'. 'ok' returns what the API needs to sign the link: never a
-- key chosen by the client. First defined in 0043.
SET ROLE authz_definer;

CREATE OR REPLACE FUNCTION authz.document_download(p_document uuid, p_session bytea)
RETURNS TABLE (outcome text, file_id uuid, classification text, content_type text, doc_type text,
               candidate_id uuid, access_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE d record; g_id uuid; a_id uuid;
BEGIN
  IF authz.current_user_id() IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT x.id, x.candidate_id, x.placement_id, x.doc_type, x.classification, x.file_id, f.status, f.content_type
    INTO d
    FROM eureka.document x JOIN eureka.file_object f ON f.id = x.file_id WHERE x.id = p_document;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT coalesce(authz.candidate_visible(d.candidate_id, 'candidate:read'), false)
     OR NOT coalesce(authz.candidate_owned(d.candidate_id, 'document:read'), false)
     OR (d.classification IS DISTINCT FROM 'internal'
         AND NOT coalesce(authz.candidate_owned(d.candidate_id, 'document.restricted:read'), false)) THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'no_data_found';
  END IF;
  -- A live step-up grant is recorded when the session holds one; it is no longer required.
  IF d.classification IS DISTINCT FROM 'internal' THEN
    SELECT s.grant_id INTO g_id FROM authz.step_up_current(p_session) s;
  END IF;
  IF d.status IS DISTINCT FROM 'clean' THEN
    RETURN QUERY SELECT 'not_available'::text, NULL::uuid, d.classification, NULL::text, d.doc_type, d.candidate_id, NULL::uuid;
    RETURN;
  END IF;
  INSERT INTO eureka.document_access AS a (document_id, user_id, action, doc_type, classification, step_up_grant_id)
  VALUES (d.id, authz.current_user_id(), 'download', d.doc_type, d.classification, g_id)
  RETURNING a.id INTO a_id;
  INSERT INTO eureka.audit_event (actor_id, action, entity_type, entity_id, changes)
  VALUES (authz.current_user_id(),
          CASE WHEN d.classification = 'restricted' THEN 'document.viewed' ELSE 'document.downloaded' END,
          'document', d.id, pg_catalog.jsonb_build_object(
            'candidateId', d.candidate_id, 'placementId', d.placement_id, 'fileId', d.file_id, 'docType', d.doc_type,
            'classification', d.classification, 'accessId', a_id, 'stepUpGrantId', g_id));
  RETURN QUERY SELECT 'ok'::text, d.file_id, d.classification, d.content_type, d.doc_type, d.candidate_id, a_id;
END $$;

REVOKE ALL ON FUNCTION authz.document_download(uuid, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.document_download(uuid, bytea) TO eureka_app;

RESET ROLE;
