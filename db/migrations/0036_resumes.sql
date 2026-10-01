-- Candidate resumes (FR-CAN-07; design A5 "Files", A6.5 uploads, B2.2 `resume`,
-- B4.4 documents row, B4.5).
--
-- Pipeline: the API asks authz.create_resume_upload for a row (status
-- 'pending'), then hands the browser a short-lived presigned POST for the fixed
-- key quarantine/resumes/<id> (exact size, exact content type; the client never
-- chooses the key). GuardDuty Malware Protection for S3 tags the object with
-- its scan result. The worker polls pending rows, reads the tag of the exact
-- object version, and on NO_THREATS_FOUND reads that version, checks size and
-- magic bytes, writes it to clean/resumes/<id> and records the result through
-- authz.resume_scan_finish (version, sha256, is_current). Infected, failed,
-- rejected and never-uploaded rows are recorded too; nothing is ever deleted
-- here (retention: TODO with OD-03, see design B2.2 note on candidate_event).
--
-- Visibility (B4.4 "Documents"): document:read covering the owning candidate
-- (ownership, team, hierarchy, location or org; not the all-teams rule), and
-- the candidate itself readable. Upload: document:upload covering the candidate.
-- Rows carry ids, sizes, types and hashes only: no file names.
-- Every IF is NULL-safe (see 0012/0015).
SET search_path = eureka, public;

SET ROLE eureka_owner;

CREATE TABLE eureka.resume (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id      uuid NOT NULL REFERENCES eureka.candidate(id),
  status            text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'clean', 'infected', 'failed', 'rejected', 'expired')),
  -- GuardDuty result or the worker's reason (NO_THREATS_FOUND, THREATS_FOUND,
  -- UNSUPPORTED, ACCESS_DENIED, FAILED, TIMEOUT, NOT_UPLOADED, BAD_CONTENT, SIZE_MISMATCH).
  scan_result       text CHECK (scan_result ~ '^[A-Z_]{1,40}$'),
  content_type      text NOT NULL CHECK (content_type IN (
                      'application/pdf',
                      'application/vnd.openxmlformats-officedocument.wordprocessingml.document')),
  size_bytes        integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 15728640),
  sha256_hex        text CHECK (sha256_hex ~ '^[0-9a-f]{64}$'),
  version           integer CHECK (version >= 1),
  is_current        boolean NOT NULL DEFAULT false,
  uploaded_by       uuid NOT NULL REFERENCES eureka.app_user(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  upload_expires_at timestamptz NOT NULL,
  scanned_at        timestamptz,
  CONSTRAINT resume_clean_complete CHECK ((status = 'clean') = (version IS NOT NULL AND sha256_hex IS NOT NULL)),
  CONSTRAINT resume_current_is_clean CHECK (NOT is_current OR status = 'clean'),
  CONSTRAINT resume_scanned CHECK ((status = 'pending') = (scanned_at IS NULL)),
  CONSTRAINT resume_version_unique UNIQUE (candidate_id, version)
);
-- One current resume per candidate (design B2.2).
CREATE UNIQUE INDEX resume_one_current ON eureka.resume (candidate_id) WHERE is_current;
CREATE INDEX resume_candidate ON eureka.resume (candidate_id, created_at DESC);
CREATE INDEX resume_pending ON eureka.resume (created_at) WHERE status = 'pending';

-- Rule 4 and 6: rows are written only inside authz_definer functions; the
-- server sets every managed column; a scanned row never changes again except
-- that it stops being current when a newer version is promoted.
CREATE FUNCTION eureka.resume_write_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF current_user IS DISTINCT FROM 'authz_definer' THEN
    RAISE EXCEPTION 'resume rows are written only by definer functions' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'resume rows are not deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.status := 'pending';
    NEW.scan_result := NULL;
    NEW.sha256_hex := NULL;
    NEW.version := NULL;
    NEW.is_current := false;
    NEW.uploaded_by := authz.current_user_id();
    NEW.created_at := pg_catalog.now();
    NEW.upload_expires_at := pg_catalog.now() + interval '5 minutes';
    NEW.scanned_at := NULL;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.candidate_id, NEW.content_type, NEW.size_bytes, NEW.uploaded_by, NEW.created_at, NEW.upload_expires_at)
     IS DISTINCT FROM
     (OLD.id, OLD.candidate_id, OLD.content_type, OLD.size_bytes, OLD.uploaded_by, OLD.created_at, OLD.upload_expires_at) THEN
    RAISE EXCEPTION 'column is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status IS NOT DISTINCT FROM 'pending' THEN
    IF NEW.status IS NOT DISTINCT FROM 'pending' THEN
      RAISE EXCEPTION 'a scan result must leave pending' USING ERRCODE = 'check_violation';
    END IF;
    NEW.scanned_at := pg_catalog.now();
    RETURN NEW;
  END IF;
  IF (NEW.status, NEW.scan_result, NEW.sha256_hex, NEW.version, NEW.scanned_at)
     IS DISTINCT FROM (OLD.status, OLD.scan_result, OLD.sha256_hex, OLD.version, OLD.scanned_at)
     OR coalesce(NEW.is_current AND NOT OLD.is_current, true) THEN
    RAISE EXCEPTION 'a scanned resume is final' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER resume_write_guard BEFORE INSERT OR UPDATE OR DELETE ON eureka.resume
  FOR EACH ROW EXECUTE FUNCTION eureka.resume_write_guard();

CREATE FUNCTION eureka.resume_no_truncate() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'resume is not truncated' USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER resume_no_truncate BEFORE TRUNCATE ON eureka.resume
  FOR EACH STATEMENT EXECUTE FUNCTION eureka.resume_no_truncate();

ALTER TABLE eureka.resume ENABLE ROW LEVEL SECURITY; ALTER TABLE eureka.resume FORCE ROW LEVEL SECURITY;

-- Rule 3: no definer call per row. The scope arrays are InitPlans; the EXISTS
-- is a primary-key probe that also runs under the caller's candidate policy,
-- so the candidate must be readable too.
CREATE POLICY resume_read ON eureka.resume FOR SELECT TO eureka_app USING (
  EXISTS (SELECT 1 FROM eureka.candidate c WHERE c.id = resume.candidate_id AND (
    (SELECT authz.has_org('document:read'))
    OR c.recruiter_id = ANY ((SELECT authz.recruiter_ids('document:read'))::uuid[])
    OR c.team_id      = ANY ((SELECT authz.team_ids('document:read'))::uuid[])
    OR c.location_id  = ANY ((SELECT authz.location_ids('document:read'))::uuid[])))
);
CREATE POLICY definer_read   ON eureka.resume FOR SELECT TO authz_definer USING (true);
CREATE POLICY definer_insert ON eureka.resume FOR INSERT TO authz_definer WITH CHECK (true);
CREATE POLICY definer_update ON eureka.resume FOR UPDATE TO authz_definer USING (true) WITH CHECK (true);

RESET ROLE;

REVOKE ALL ON eureka.resume FROM PUBLIC;
REVOKE ALL ON FUNCTION eureka.resume_write_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION eureka.resume_no_truncate() FROM PUBLIC;
GRANT SELECT ON eureka.resume TO eureka_app;
GRANT SELECT, INSERT ON eureka.resume TO authz_definer;
GRANT UPDATE (status, scan_result, sha256_hex, version, is_current, scanned_at) ON eureka.resume TO authz_definer;

-- ---------- functions ----------
SET ROLE authz_definer;

-- API: a pending row for one upload. 404-equivalent when the candidate is not
-- readable, 403 when readable but document:upload does not cover it. At most
-- three uploads per candidate may be waiting at once.
CREATE FUNCTION authz.create_resume_upload(p_candidate uuid, p_content_type text, p_size integer)
RETURNS TABLE (id uuid, upload_expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF authz.current_user_id() IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_candidate IS NULL OR NOT coalesce(authz.candidate_visible(p_candidate, 'candidate:read'), false) THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT coalesce(authz.candidate_owned(p_candidate, 'document:upload'), false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_content_type IS NULL OR p_size IS NULL
     OR p_content_type NOT IN ('application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
     OR NOT coalesce(p_size BETWEEN 1 AND 15728640, false) THEN
    RAISE EXCEPTION 'invalid_upload' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('resume:' || p_candidate::text, 0));
  IF (SELECT pg_catalog.count(*) FROM eureka.resume r
       WHERE r.candidate_id = p_candidate AND r.status = 'pending') >= 3 THEN
    RAISE EXCEPTION 'too_many_pending' USING ERRCODE = 'check_violation';
  END IF;
  RETURN QUERY
  INSERT INTO eureka.resume AS r (candidate_id, content_type, size_bytes, upload_expires_at)
  VALUES (p_candidate, p_content_type, p_size, pg_catalog.now())
  RETURNING r.id, r.upload_expires_at;
END $$;

-- Worker: pending rows, oldest first (ids and declared metadata only).
CREATE FUNCTION authz.resume_scan_queue(p_limit integer, p_id uuid DEFAULT NULL)
RETURNS TABLE (id uuid, content_type text, size_bytes integer, created_at timestamptz, upload_expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT r.id, r.content_type, r.size_bytes, r.created_at, r.upload_expires_at
  FROM eureka.resume r
  WHERE r.status = 'pending' AND (p_id IS NULL OR r.id = p_id)
  ORDER BY r.created_at, r.id
  LIMIT LEAST(GREATEST(coalesce(p_limit, 0), 0), 100)
$$;

-- Worker: records the outcome of one scan. Only pending rows change; a clean
-- result needs the size the upload declared and a SHA-256, and becomes the
-- candidate's current resume with the next version number. Returns the new
-- status, or 'not_pending' when another run already finished the row.
CREATE FUNCTION authz.resume_scan_finish(p_id uuid, p_status text, p_result text, p_sha256 text, p_size integer)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE r eureka.resume%ROWTYPE; next_version integer;
BEGIN
  IF p_id IS NULL OR p_status IS NULL OR p_result IS NULL
     OR p_status NOT IN ('clean', 'infected', 'failed', 'rejected', 'expired')
     OR NOT coalesce(p_result ~ '^[A-Z_]{1,40}$', false) THEN
    RAISE EXCEPTION 'invalid_scan_result' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO r FROM eureka.resume x WHERE x.id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'no_data_found';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('resume:' || r.candidate_id::text, 0));
  SELECT * INTO r FROM eureka.resume x WHERE x.id = p_id FOR UPDATE;
  IF r.status IS DISTINCT FROM 'pending' THEN
    RETURN 'not_pending';
  END IF;
  IF p_status IS NOT DISTINCT FROM 'clean' THEN
    IF p_result IS DISTINCT FROM 'NO_THREATS_FOUND'
       OR p_size IS DISTINCT FROM r.size_bytes
       OR NOT coalesce(p_sha256 ~ '^[0-9a-f]{64}$', false) THEN
      RAISE EXCEPTION 'invalid_scan_result' USING ERRCODE = 'check_violation';
    END IF;
    SELECT coalesce(pg_catalog.max(x.version), 0) + 1 INTO next_version
      FROM eureka.resume x WHERE x.candidate_id = r.candidate_id;
    UPDATE eureka.resume SET is_current = false WHERE candidate_id = r.candidate_id AND is_current;
    UPDATE eureka.resume
       SET status = 'clean', scan_result = p_result, sha256_hex = p_sha256, version = next_version, is_current = true
     WHERE id = p_id;
  ELSE
    IF p_status IS NOT DISTINCT FROM 'expired' AND NOT coalesce(pg_catalog.now() > r.upload_expires_at, false) THEN
      RAISE EXCEPTION 'invalid_scan_result' USING ERRCODE = 'check_violation';
    END IF;
    UPDATE eureka.resume SET status = p_status, scan_result = p_result WHERE id = p_id;
  END IF;
  RETURN p_status;
END $$;

RESET ROLE;

REVOKE ALL ON FUNCTION authz.create_resume_upload(uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.resume_scan_queue(integer, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.resume_scan_finish(uuid, text, text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.create_resume_upload(uuid, text, integer) TO eureka_app;
GRANT EXECUTE ON FUNCTION authz.resume_scan_queue(integer, uuid) TO eureka_worker;
GRANT EXECUTE ON FUNCTION authz.resume_scan_finish(uuid, text, text, text, integer) TO eureka_worker;
