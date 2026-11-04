-- Whoever may create a batch can find it and fill it (docs/training-api.md TR-3, TR-8, TR-14).
--
-- Before: Lead, Manager and AD could create a batch but hold training:read at a
-- scope that covers no batch, so their empty batch was listed nowhere; only
-- Location roles held training:manage, so no other creator could add a student.
--
--   1. authz.batch_staff_location_ids: locations where the caller plans batches
--      (training managers, Sales leadership, training.batch:create holders).
--   2. authz.training_batches lists the batches of those locations. `covered`
--      does not change: student names stay limited to what the caller owns.
--   3. authz.set_batch_student accepts those callers. Anyone without
--      training:manage may only move candidates they own under candidate:read
--      (never the Open-to-all or shared-team ones they merely see).
--   4. authz.set_candidate_batch: the profile's batch picker, for those callers
--      and for holders of candidate:update on the candidate (who could already
--      change batch_id by editing the profile).

SET ROLE authz_definer;

CREATE FUNCTION authz.batch_staff_location_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE
    WHEN authz.has_org('training.batch:create') THEN (SELECT coalesce(pg_catalog.array_agg(l.id), '{}') FROM eureka.location l)
    ELSE (SELECT coalesce(pg_catalog.array_agg(DISTINCT x), '{}') FROM (
      SELECT pg_catalog.unnest(authz.batch_manage_location_ids()) AS x
      UNION
      SELECT pg_catalog.unnest(authz.location_ids('training.batch:create'))) s)
  END
$$;

CREATE OR REPLACE FUNCTION authz.training_batches()
RETURNS TABLE (batch_id uuid, covered boolean, students integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH s AS MATERIALIZED (
    SELECT authz.training_batch_ids('training:read') AS b, authz.owned_candidate_ids('training:read') AS c,
           authz.batch_staff_location_ids() AS l
    WHERE authz.has_perm('training:read')),
  owned AS MATERIALIZED (
    SELECT c.id, c.batch_id FROM s, pg_catalog.unnest(s.c) AS x(id) JOIN eureka.candidate c ON c.id = x.id
    WHERE c.batch_id IS NOT NULL),
  vis AS (
    SELECT pg_catalog.unnest(s.b) AS id FROM s
    UNION
    SELECT o.batch_id FROM owned o
    UNION
    SELECT b.id FROM s, eureka.batch b WHERE b.location_id = ANY (s.l))
  SELECT v.id, coalesce(v.id = ANY (s.b), false),
         CASE WHEN coalesce(v.id = ANY (s.b), false)
              THEN (SELECT count(*)::integer FROM eureka.candidate c WHERE c.batch_id = v.id)
              ELSE (SELECT count(*)::integer FROM owned o WHERE o.batch_id = v.id) END
  FROM vis v, s
$$;

CREATE OR REPLACE FUNCTION authz.set_batch_student(p_batch uuid, p_candidate uuid, p_member boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE b record; c record; manager boolean; staff boolean;
BEGIN
  SELECT * INTO b FROM eureka.batch WHERE id = p_batch FOR SHARE;
  manager := coalesce(p_batch = ANY (authz.training_batch_ids('training:manage')), false);
  staff := coalesce(b.location_id = ANY (authz.batch_staff_location_ids()), false);
  IF NOT FOUND OR authz.current_user_id() IS NULL
     OR NOT (staff OR coalesce(p_batch = ANY (authz.training_batch_ids('training:read')), false)) THEN
    RAISE EXCEPTION 'batch_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT (manager OR staff) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_member IS NULL THEN
    RAISE EXCEPTION 'invalid_change' USING ERRCODE = 'check_violation';
  END IF;
  SELECT x.id, x.batch_id, x.location_id, x.recruiter_id, x.team_id INTO c FROM eureka.candidate x WHERE x.id = p_candidate FOR UPDATE;
  -- One answer for "no such candidate", "not readable by the caller" and "not at this location".
  IF NOT FOUND OR c.location_id IS DISTINCT FROM b.location_id
     OR NOT coalesce(authz.candidate_visible(p_candidate, 'candidate:read'), false)
     OR NOT (manager OR authz.owns('candidate:read', c.recruiter_id, c.team_id, c.location_id)) THEN
    RAISE EXCEPTION 'candidate_not_eligible' USING ERRCODE = 'check_violation';
  END IF;
  IF p_member THEN
    IF c.batch_id IS NOT DISTINCT FROM p_batch THEN RETURN; END IF;
    IF b.status NOT IN ('planned', 'in_training') THEN
      RAISE EXCEPTION 'batch_closed' USING ERRCODE = 'check_violation';
    END IF;
    UPDATE eureka.candidate SET batch_id = p_batch WHERE id = p_candidate;
  ELSE
    IF c.batch_id IS DISTINCT FROM p_batch THEN
      RAISE EXCEPTION 'not_in_batch' USING ERRCODE = 'check_violation';
    END IF;
    UPDATE eureka.candidate SET batch_id = NULL WHERE id = p_candidate;
  END IF;
END $$;

-- UI hint and check of the profile's batch picker: the caller edits the candidate,
-- or plans batches at its location and owns it under candidate:read.
CREATE FUNCTION authz.candidate_batch_editable(p_candidate uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce(bool_or(
           authz.owns('candidate:update', c.recruiter_id, c.team_id, c.location_id)
           OR (c.location_id = ANY (authz.batch_staff_location_ids())
               AND authz.owns('candidate:read', c.recruiter_id, c.team_id, c.location_id))), false)
  FROM eureka.candidate c WHERE c.id = p_candidate
$$;

-- p_batch NULL takes the candidate out of its batch. Location and open status of
-- the new batch are checked by the candidate_batch_check trigger (batch_not_allowed).
CREATE FUNCTION authz.set_candidate_batch(p_candidate uuid, p_batch uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF authz.current_user_id() IS NULL OR NOT coalesce(authz.candidate_batch_editable(p_candidate), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE eureka.candidate SET batch_id = p_batch WHERE id = p_candidate AND batch_id IS DISTINCT FROM p_batch;
END $$;

REVOKE ALL ON FUNCTION authz.batch_staff_location_ids() FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.candidate_batch_editable(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.set_candidate_batch(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.batch_staff_location_ids() TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.candidate_batch_editable(uuid) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.set_candidate_batch(uuid, uuid) TO eureka_app;

RESET ROLE;
