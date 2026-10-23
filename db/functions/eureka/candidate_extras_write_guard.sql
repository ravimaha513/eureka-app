-- eureka.candidate_extras_write_guard: current definition (repeatable; db/functions/README.md).
-- Earlier bodies: migrations 0026, 0032, 0065. Change this file, not a new migration.

SET ROLE eureka_owner;
CREATE OR REPLACE FUNCTION eureka.candidate_extras_write_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  IF current_user IS DISTINCT FROM 'authz_definer' THEN
    RAISE EXCEPTION '% rows are written only by definer functions', TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_TABLE_NAME = 'batch' AND TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'batch' THEN
    IF (pg_catalog.to_jsonb(NEW) - ARRAY['status', 'name', 'trainer_id', 'start_date', 'end_date', 'start_month',
                                         'size_planned', 'cover_color', 'cover_icon', 'row_version', 'updated_at'])
       IS DISTINCT FROM
       (pg_catalog.to_jsonb(OLD) - ARRAY['status', 'name', 'trainer_id', 'start_date', 'end_date', 'start_month',
                                         'size_planned', 'cover_color', 'cover_icon', 'row_version', 'updated_at']) THEN
      RAISE EXCEPTION 'only the batch status and details change' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.row_version := OLD.row_version + 1;
    NEW.updated_at := pg_catalog.now();
    RETURN NEW;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_TABLE_NAME = 'candidate_event' THEN
    NEW.at := pg_catalog.now();
    NEW.actor_id := authz.current_user_id();
  ELSE
    NEW.created_at := pg_catalog.now();
    NEW.created_by := authz.current_user_id();
    NEW.status := 'planned';
    NEW.row_version := 1;
    NEW.updated_at := pg_catalog.now();
  END IF;
  RETURN NEW;
END $function$;

REVOKE ALL ON FUNCTION eureka.candidate_extras_write_guard() FROM PUBLIC;
RESET ROLE;
