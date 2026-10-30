-- authz.transition_candidate: current definition (repeatable; db/functions/README.md).
-- Earlier bodies: migrations 0006, 0015, 0022. Change this file, not a new migration.

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.transition_candidate(p_candidate uuid, p_to text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE c record;
BEGIN
  SELECT * INTO c FROM eureka.candidate WHERE id = p_candidate FOR UPDATE;
  IF NOT FOUND OR NOT coalesce(
       authz.owns('candidate:read', c.recruiter_id, c.team_id, c.location_id)
       OR (authz.all_teams('candidate:read') AND c.visibility = 'all_teams'
           AND c.marketing_status IN ('active','full_of_interviews'))
       OR c.id = ANY (authz.shared_candidate_ids('candidate:read')), false) THEN
    RAISE EXCEPTION 'candidate not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT coalesce(authz.owns('candidate:update', c.recruiter_id, c.team_id, c.location_id), false) THEN
    RAISE EXCEPTION 'not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_to IS NULL OR NOT coalesce((c.marketing_status, p_to) IN (
      ('in_training','active'),
      ('active','on_hold'), ('active','stopped'), ('active','full_of_interviews'), ('active','confirmation'),
      ('on_hold','active'), ('full_of_interviews','active'),
      ('confirmation','active'), ('bench','active'),
      ('in_training','terminated'), ('active','terminated'), ('on_hold','terminated'),
      ('stopped','terminated'), ('full_of_interviews','terminated'), ('confirmation','terminated'),
      ('bench','terminated')), false) THEN
    RAISE EXCEPTION 'invalid transition % -> %', c.marketing_status, p_to USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM eureka.placement p
             WHERE p.candidate_id = p_candidate AND p.status IN ('confirmed', 'paperwork', 'bgc', 'ready')) THEN
    RAISE EXCEPTION 'placement_open' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE eureka.candidate SET marketing_status = p_to,
    bench_since = CASE WHEN p_to = 'bench' THEN current_date ELSE NULL END
  WHERE id = p_candidate;
  RETURN p_to;
END $function$;

REVOKE ALL ON FUNCTION authz.transition_candidate(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.transition_candidate(uuid, text) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.transition_candidate(uuid, text) TO eureka_worker;
-- eureka_owner never calls it (apps/api and db/seed callers use eureka_app; the import definers are
-- authz_definer, which owns it). REVOKE rather than drop the grant: existing ACLs survive CREATE OR REPLACE.
REVOKE EXECUTE ON FUNCTION authz.transition_candidate(uuid, text) FROM eureka_owner;
RESET ROLE;
