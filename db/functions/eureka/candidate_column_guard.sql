-- eureka.candidate_column_guard: current definition (repeatable; db/functions/README.md).
-- Earlier bodies: migrations 0006, 0013, 0026, 0065, 0150. Change this file, not a new migration.

SET ROLE eureka_owner;
CREATE OR REPLACE FUNCTION eureka.candidate_column_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  is_definer boolean := current_user = 'authz_definer';
  owns_old   boolean;
  employment boolean := false;
BEGIN
  -- Never changeable through the API.
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.person_id IS DISTINCT FROM OLD.person_id
     OR NEW.location_id IS DISTINCT FROM OLD.location_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'column is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Status columns change only through authz.transition_candidate (N2).
  IF (NEW.marketing_status IS DISTINCT FROM OLD.marketing_status
      OR NEW.bench_since IS DISTINCT FROM OLD.bench_since) AND NOT is_definer THEN
    RAISE EXCEPTION 'status changes must use a transition' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF ((NEW.technology_id, NEW.gh_location_id, NEW.priority, NEW.marketing_email, NEW.vitel_number,
       NEW.marketing_start_date, NEW.in_person_ok)
      IS DISTINCT FROM
      (OLD.technology_id, OLD.gh_location_id, OLD.priority, OLD.marketing_email, OLD.vitel_number,
       OLD.marketing_start_date, OLD.in_person_ok)
      OR (NEW.batch_id IS DISTINCT FROM OLD.batch_id AND NOT is_definer))
     AND NOT authz.owns('candidate:update', OLD.recruiter_id, OLD.team_id, OLD.location_id) THEN
    RAISE EXCEPTION 'not permitted to update profile fields' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.technical_rating IS DISTINCT FROM OLD.technical_rating
     AND NOT authz.owns('candidate.rating:update', OLD.recruiter_id, OLD.team_id, OLD.location_id) THEN
    RAISE EXCEPTION 'not permitted to update technical rating' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.visibility IS DISTINCT FROM OLD.visibility
     AND NOT authz.owns('candidate.visibility:update', OLD.recruiter_id, OLD.team_id, OLD.location_id) THEN
    RAISE EXCEPTION 'not permitted to change visibility' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.team_id IS DISTINCT FROM OLD.team_id
     OR (NEW.recruiter_id IS DISTINCT FROM OLD.recruiter_id AND NOT is_definer) THEN
    -- Only the definer may read the marker (the app role has no privilege on it).
    IF is_definer THEN
      employment := EXISTS (SELECT 1 FROM authz.employment_team_context x
                             WHERE x.xact = pg_catalog.pg_current_xact_id() AND x.candidate_id = OLD.id);
    END IF;
    IF NOT coalesce(employment, false) THEN
      owns_old := authz.owns('candidate:assign', OLD.recruiter_id, OLD.team_id, OLD.location_id);
      IF NOT owns_old
         OR NOT coalesce(authz.has_org('candidate:assign') OR NEW.team_id = ANY (authz.team_ids('candidate:assign')), false) THEN
        RAISE EXCEPTION 'not permitted to reassign candidate' USING ERRCODE = 'insufficient_privilege';
      END IF;
    END IF;
  END IF;

  NEW.updated_at := now();
  NEW.row_version := OLD.row_version + 1;
  RETURN NEW;
END $function$;

REVOKE ALL ON FUNCTION eureka.candidate_column_guard() FROM PUBLIC;
-- A trigger function needs no EXECUTE to fire (only CREATE TRIGGER checks it, and the owner does that).
-- REVOKE rather than drop the old GRANT lines: CREATE OR REPLACE keeps existing ACLs, so the
-- grants already in a database would otherwise stay.
REVOKE EXECUTE ON FUNCTION eureka.candidate_column_guard() FROM authz_definer, eureka_app, eureka_worker;
RESET ROLE;
