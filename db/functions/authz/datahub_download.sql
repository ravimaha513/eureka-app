-- API: authorizes one download (or in-app view) of a file version and logs it
-- (access log + audit, same transaction). Not readable -> not_found. Folder
-- membership and level decide; for a restricted folder (or a file stored as
-- restricted) a step-up grant is recorded when the session holds one but is
-- not required. File not clean -> 'not_available'. 'ok' returns what the API
-- needs to sign the link. First defined in 0075.
SET ROLE authz_definer;

CREATE OR REPLACE FUNCTION authz.datahub_download(p_version uuid, p_session bytea)
RETURNS TABLE (outcome text, file_object_id uuid, classification text, content_type text, version integer, access_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE d record; g_id uuid; a_id uuid; strict_level boolean; eff text;
BEGIN
  IF authz.current_user_id() IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT v.id, v.file_id, v.version, v.file_object_id, x.folder_id, fo.level, pf.level AS parent_level,
         o.classification, o.status, o.content_type INTO d
    FROM eureka.datahub_file_version v
    JOIN eureka.datahub_file x ON x.id = v.file_id AND x.deleted_at IS NULL
    JOIN eureka.datahub_folder fo ON fo.id = x.folder_id AND fo.deleted_at IS NULL
    LEFT JOIN eureka.datahub_folder pf ON pf.id = fo.parent_id
    JOIN eureka.file_object o ON o.id = v.file_object_id
   WHERE v.id = p_version;
  IF NOT FOUND OR NOT (d.folder_id = ANY (authz.datahub_readable_folders())) THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'no_data_found';
  END IF;
  -- The effective level: the stricter of the folder and its parent; a file stored as restricted stays restricted.
  eff := authz.datahub_stricter(authz.datahub_stricter(d.level, d.parent_level),
                                CASE WHEN d.classification = 'restricted' THEN 'restricted' END);
  strict_level := eff = 'restricted';
  -- A live step-up grant is recorded when the session holds one; it is no longer required.
  IF strict_level THEN
    SELECT s.grant_id INTO g_id FROM authz.step_up_current(p_session) s;
  END IF;
  IF d.status IS DISTINCT FROM 'clean' THEN
    RETURN QUERY SELECT 'not_available'::text, NULL::uuid, d.classification, NULL::text, d.version, NULL::uuid;
    RETURN;
  END IF;
  INSERT INTO eureka.datahub_access AS a (folder_id, file_id, version_id, version, user_id, action, level, step_up_grant_id)
  VALUES (d.folder_id, d.file_id, d.id, d.version, authz.current_user_id(), 'download',
          eff, g_id)
  RETURNING a.id INTO a_id;
  INSERT INTO eureka.audit_event (actor_id, action, entity_type, entity_id, changes)
  VALUES (authz.current_user_id(), CASE WHEN strict_level THEN 'datahub.viewed' ELSE 'datahub.downloaded' END,
          'datahub_file', d.file_id, pg_catalog.jsonb_build_object(
            'folderId', d.folder_id, 'versionId', d.id, 'version', d.version, 'fileObjectId', d.file_object_id,
            'level', eff, 'accessId', a_id, 'stepUpGrantId', g_id));
  RETURN QUERY SELECT 'ok'::text, d.file_object_id, d.classification, d.content_type, d.version, a_id;
END $$;

REVOKE ALL ON FUNCTION authz.datahub_download(uuid, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.datahub_download(uuid, bytea) TO eureka_app;

RESET ROLE;
