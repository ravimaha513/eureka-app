-- eureka.bgc_write_guard: current definition (repeatable; db/functions/README.md).
-- Earlier body: migration 0044. Change this file, not a new migration.

SET ROLE eureka_owner;
CREATE OR REPLACE FUNCTION eureka.bgc_write_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE p record;
BEGIN
  -- Candidate delete (authz.delete_candidate, migration 0320) removes these rows.
  IF TG_OP = 'DELETE' AND current_user = 'authz_definer' THEN
    IF authz.candidate_purging() THEN RETURN OLD; END IF;
  END IF;
  IF current_user IS DISTINCT FROM 'authz_definer' THEN
    RAISE EXCEPTION 'bgc records are written only by definer functions' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'bgc records are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT pl.candidate_id, pl.recruiter_id, pl.team_id, pl.location_id INTO p
      FROM eureka.placement pl WHERE pl.id = NEW.placement_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'placement_not_found' USING ERRCODE = 'foreign_key_violation';
    END IF;
    NEW.candidate_id := p.candidate_id; NEW.recruiter_id := p.recruiter_id;
    NEW.team_id := p.team_id; NEW.location_id := p.location_id;
    NEW.status := 'not_started';
    NEW.bgc_company := NULL; NEW.initiated_on := NULL; NEW.completed_on := NULL; NEW.helped_by := NULL;
    NEW.education_level := NULL; NEW.employment_years := NULL; NEW.address_years := NULL; NEW.notes := NULL;
    NEW.status_reason := NULL; NEW.status_changed_at := NULL; NEW.status_changed_by := NULL;
    NEW.created_at := pg_catalog.now(); NEW.created_by := authz.current_user_id();
    NEW.updated_at := NULL; NEW.updated_by := NULL; NEW.version := 1;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.placement_id, NEW.candidate_id, NEW.recruiter_id, NEW.team_id, NEW.location_id, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.id, OLD.placement_id, OLD.candidate_id, OLD.recruiter_id, OLD.team_id, OLD.location_id, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'column is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.version := OLD.version + 1;
  NEW.updated_at := pg_catalog.now();
  NEW.updated_by := authz.current_user_id();
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.status_changed_at := pg_catalog.now();
    NEW.status_changed_by := authz.current_user_id();
  ELSE
    NEW.status_changed_at := OLD.status_changed_at;
    NEW.status_changed_by := OLD.status_changed_by;
    NEW.status_reason := OLD.status_reason;
  END IF;
  RETURN NEW;
END $function$
;
REVOKE ALL ON FUNCTION eureka.bgc_write_guard() FROM PUBLIC;
RESET ROLE;
