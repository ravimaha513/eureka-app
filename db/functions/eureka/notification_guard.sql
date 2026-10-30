-- eureka.notification_guard: current definition (repeatable; db/functions/README.md).
-- Earlier body: migration 0046. Change this file, not a new migration.

SET ROLE eureka_owner;
CREATE OR REPLACE FUNCTION eureka.notification_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  -- Candidate delete (authz.delete_candidate, migration 0320) removes these rows.
  IF TG_OP = 'DELETE' AND current_user = 'authz_definer' THEN
    IF authz.candidate_purging() THEN RETURN OLD; END IF;
  END IF;
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'notifications are never truncated' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF current_user IS DISTINCT FROM 'eureka_worker' THEN
      RAISE EXCEPTION 'notifications are written only by the notification worker'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.created_at := pg_catalog.now();
    NEW.read_at := NULL;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF current_user IS DISTINCT FROM 'eureka_app'
       OR (pg_catalog.to_jsonb(NEW) - 'read_at') IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - 'read_at') THEN
      RAISE EXCEPTION 'only the read mark of a notification can change'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- The server sets the time; marking an already read row read keeps the first time.
    NEW.read_at := CASE WHEN NEW.read_at IS NULL THEN NULL ELSE coalesce(OLD.read_at, pg_catalog.now()) END;
    RETURN NEW;
  END IF;

  -- DELETE (prune): the worker, rows past the retention floor only.
  IF current_user IS DISTINCT FROM 'eureka_worker'
     OR NOT coalesce(OLD.created_at < pg_catalog.now() - interval '30 days', false) THEN
    RAISE EXCEPTION 'only notifications older than 30 days may be pruned'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN OLD;
END $function$
;
REVOKE ALL ON FUNCTION eureka.notification_guard() FROM PUBLIC;
RESET ROLE;
