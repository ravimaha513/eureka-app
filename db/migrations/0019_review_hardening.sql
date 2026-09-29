-- Independent review follow-ups (2026-09-29) for 0016 (worker) and 0017 (pipeline).
SET search_path = eureka, public;

-- 1. The worker could SET ROLE eureka_app, pick any user id and read with that
--    user's full scope (raw phones included). Nothing uses "act for a user" yet;
--    when a job needs it, it gets a narrow SECURITY DEFINER path instead.
REVOKE eureka_app FROM eureka_worker;

SET ROLE eureka_owner;

-- 2. audit_event.at and seq were client-settable, so rows could be back-dated
--    into days already exported. The server assigns both.
CREATE FUNCTION eureka.audit_event_stamp() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  NEW.at  := pg_catalog.now();
  NEW.seq := pg_catalog.nextval('eureka.audit_event_seq_seq');
  RETURN NEW;
END $$;
CREATE TRIGGER audit_event_stamp BEFORE INSERT ON audit_event
  FOR EACH ROW EXECUTE FUNCTION eureka.audit_event_stamp();

-- 3. The submission state machine could be bypassed through INSERT (a new row
--    straight in 'selected', attributed to someone else). New rows start clean.
CREATE FUNCTION eureka.submission_insert_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM 'submitted' OR NEW.rejection_reason IS NOT NULL
     OR NEW.status_changed_at IS NOT NULL OR NEW.status_changed_by IS NOT NULL THEN
    RAISE EXCEPTION 'server_managed_field' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER submission_insert_guard BEFORE INSERT ON submission
  FOR EACH ROW EXECUTE FUNCTION eureka.submission_insert_guard();
ALTER TABLE submission ADD CONSTRAINT submission_rejection_reason_len
  CHECK (rejection_reason IS NULL OR char_length(rejection_reason) <= 500) NOT VALID;

-- 4. Interview data limits the API already applies, now held by the database.
ALTER TABLE interview
  ADD CONSTRAINT interview_links_https CHECK (
        (otter_url IS NULL OR (otter_url ~ '^https://[^[:space:]]+$' AND char_length(otter_url) <= 500))
    AND (recording_url IS NULL OR (recording_url ~ '^https://[^[:space:]]+$' AND char_length(recording_url) <= 500))) NOT VALID,
  ADD CONSTRAINT interview_duration CHECK (ends_at - starts_at <= interval '12 hours') NOT VALID,
  ADD CONSTRAINT interview_start_sane CHECK (starts_at >= timestamptz '2000-01-01') NOT VALID;

-- 5. A location-only field could be set at insert; and the parent submission is
--    locked so it cannot close concurrently while an interview is added.
RESET ROLE;
SET ROLE authz_definer;
CREATE FUNCTION authz.lock_submission_for_interview(p_submission uuid) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT NULL::void FROM eureka.submission s WHERE s.id = p_submission FOR SHARE
$$;
REVOKE ALL ON FUNCTION authz.lock_submission_for_interview(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.lock_submission_for_interview(uuid) TO eureka_app;

-- 6. Activity lists evaluated authz.candidate_owned() per row (about 11 s for
--    4,000 interviews). Candidates owned for a permission are resolved once per
--    statement instead.
CREATE FUNCTION authz.owned_candidate_ids(perm text) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH s AS MATERIALIZED (
    SELECT authz.recruiter_ids(perm) AS r, authz.team_ids(perm) AS t, authz.location_ids(perm) AS l)
  SELECT coalesce(pg_catalog.array_agg(c.id), '{}')
  FROM eureka.candidate c, s
  WHERE c.recruiter_id = ANY (s.r) OR c.team_id = ANY (s.t) OR c.location_id = ANY (s.l)
$$;
REVOKE ALL ON FUNCTION authz.owned_candidate_ids(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.owned_candidate_ids(text) TO eureka_app;
RESET ROLE;

SET ROLE eureka_owner;

CREATE FUNCTION eureka.interview_insert_prepare() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.system_name IS NOT NULL THEN
    RAISE EXCEPTION 'server_managed_field' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM authz.lock_submission_for_interview(NEW.submission_id);
  RETURN NEW;
END $$;
-- Named to fire before interview_guard (triggers fire in name order).
CREATE TRIGGER interview_0_insert_prepare BEFORE INSERT ON interview
  FOR EACH ROW EXECUTE FUNCTION eureka.interview_insert_prepare();

DROP POLICY submission_read ON submission;
CREATE POLICY submission_read ON submission FOR SELECT TO eureka_app USING (
  (SELECT authz.has_org('submission:read'))
  OR recruiter_id = ANY ((SELECT authz.recruiter_ids('submission:read'))::uuid[])
  OR team_id      = ANY ((SELECT authz.team_ids('submission:read'))::uuid[])
  OR location_id  = ANY ((SELECT authz.location_ids('submission:read'))::uuid[])
  OR candidate_id = ANY ((SELECT authz.owned_candidate_ids('submission:read'))::uuid[])
);

DROP POLICY interview_read ON interview;
CREATE POLICY interview_read ON interview FOR SELECT TO eureka_app USING (
  (SELECT authz.has_org('interview:read'))
  OR recruiter_id = ANY ((SELECT authz.recruiter_ids('interview:read'))::uuid[])
  OR team_id      = ANY ((SELECT authz.team_ids('interview:read'))::uuid[])
  OR location_id  = ANY ((SELECT authz.location_ids('interview:read'))::uuid[])
  OR candidate_id = ANY ((SELECT authz.owned_candidate_ids('interview:read'))::uuid[])
);

RESET ROLE;

REVOKE ALL ON FUNCTION eureka.audit_event_stamp() FROM PUBLIC;
REVOKE ALL ON FUNCTION eureka.submission_insert_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION eureka.interview_insert_prepare() FROM PUBLIC;
