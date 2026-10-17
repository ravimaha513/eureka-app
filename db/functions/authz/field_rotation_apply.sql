-- authz.field_rotation_apply: current definition (repeatable; db/functions/README.md).
-- Earlier bodies: migrations 0042, 0047, 0054. Change this file, not a new migration.

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.field_rotation_apply(p_class text, p_row uuid, p_old_enc bytea, p_new_enc bytea, p_new_key uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE new_version integer; old_version integer; old_key uuid;
BEGIN
  IF p_class IS NULL OR p_class NOT IN ('work_auth_number', 'utility_password') THEN
    RAISE EXCEPTION 'unsupported field class' USING ERRCODE = 'check_violation';
  END IF;
  IF p_row IS NULL OR p_old_enc IS NULL OR p_new_enc IS NULL
     OR p_new_key IS NULL OR p_new_key IS DISTINCT FROM authz.field_key_newest(p_class) THEN
    RAISE EXCEPTION 'not_current_key' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT coalesce(authz.field_header_matches(p_new_enc, p_new_key), false) THEN
    RAISE EXCEPTION 'invalid_ciphertext' USING ERRCODE = 'check_violation';
  END IF;
  SELECT k.version INTO new_version FROM eureka.field_key k WHERE k.id = p_new_key;
  IF p_class = 'work_auth_number' THEN
    SELECT k.version, k.id INTO old_version, old_key FROM eureka.field_key k
      JOIN eureka.work_authorization w ON w.number_key_id = k.id WHERE w.id = p_row;
  ELSE
    SELECT k.version, k.id INTO old_version, old_key FROM eureka.field_key k
      JOIN eureka.utility u ON u.password_key_id = k.id WHERE u.id = p_row;
  END IF;
  IF old_version IS NULL OR NOT coalesce(new_version > old_version, false) THEN
    RETURN false;
  END IF;
  IF p_class = 'work_auth_number' THEN
    UPDATE eureka.work_authorization w SET number_enc = p_new_enc, number_key_id = p_new_key
     WHERE w.id = p_row AND w.number_enc = p_old_enc;
  ELSE
    UPDATE eureka.utility u SET password_enc = p_new_enc, password_key_id = p_new_key
     WHERE u.id = p_row AND u.password_enc = p_old_enc;
  END IF;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  INSERT INTO eureka.field_rotation_log (field_class, row_id, from_key, to_key) VALUES (p_class, p_row, old_key, p_new_key);
  RETURN true;
END $function$;

REVOKE ALL ON FUNCTION authz.field_rotation_apply(text, uuid, bytea, bytea, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.field_rotation_apply(text, uuid, bytea, bytea, uuid) TO eureka_worker;
RESET ROLE;
