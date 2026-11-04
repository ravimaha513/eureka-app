-- authz.training_batches: current definition (repeatable; db/functions/README.md).
-- Earlier body: migration 0065. Batches the caller created added here, so a creator
-- without batch-level coverage (Sales leadership) can open them (docs/training-api.md
-- TR-3, TR-8). Change this file, not a new migration.
--
-- Batches the caller sees on the Training Batches screen, with the number of
-- students they may see there: every student when the batch is covered at
-- batch level, else the students they own under training:read.

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.training_batches()
 RETURNS TABLE(batch_id uuid, covered boolean, students integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  WITH s AS MATERIALIZED (
    SELECT authz.training_batch_ids('training:read') AS b, authz.owned_candidate_ids('training:read') AS c,
           authz.current_user_id() AS me,
           coalesce(authz.batch_manager() OR authz.has_perm('training:manage')
                    OR authz.has_perm('training.batch:create'), false) AS planner
    WHERE authz.has_perm('training:read')),
  owned AS MATERIALIZED (
    SELECT c.id, c.batch_id FROM s, pg_catalog.unnest(s.c) AS x(id) JOIN eureka.candidate c ON c.id = x.id
    WHERE c.batch_id IS NOT NULL),
  vis AS (
    SELECT pg_catalog.unnest(s.b) AS id FROM s
    UNION
    SELECT o.batch_id FROM owned o
    UNION
    SELECT b.id FROM s, eureka.batch b WHERE s.planner AND b.created_by = s.me)
  SELECT v.id, coalesce(v.id = ANY (s.b), false),
         CASE WHEN coalesce(v.id = ANY (s.b), false)
              THEN (SELECT count(*)::integer FROM eureka.candidate c WHERE c.batch_id = v.id)
              ELSE (SELECT count(*)::integer FROM owned o WHERE o.batch_id = v.id) END
  FROM vis v, s
$function$;

REVOKE ALL ON FUNCTION authz.training_batches() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.training_batches() TO eureka_app;
RESET ROLE;
