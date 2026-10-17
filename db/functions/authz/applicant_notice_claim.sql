-- authz.applicant_notice_claim: current definition (repeatable; db/functions/README.md).
-- Claims up to p_limit due applicant notices for sending (0190) and returns what the email needs. The
-- claim moves next_attempt_at forward by the backoff (1, 2, 4 ... 128 minutes), so the notice is not
-- claimed again while this send is in flight; the 8th unsuccessful claim marks it 'failed'.
-- Executable by the API (eureka_app) without a user: it reads only notices that are due.

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.applicant_notice_claim(p_limit integer)
 RETURNS TABLE(id uuid, kind text, to_status text, email text, job_title text, attempts smallint,
               interview_type text, interview_round text, starts_at timestamp with time zone,
               duration_minutes integer, meeting_link text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
#variable_conflict use_column
BEGIN
  DELETE FROM eureka.applicant_notice n WHERE n.created_at < pg_catalog.now() - interval '30 days';
  UPDATE eureka.applicant_notice n SET status = 'failed'
   WHERE n.status = 'pending' AND n.attempts >= 8 AND n.next_attempt_at <= pg_catalog.now();
  RETURN QUERY
  WITH due AS (
    SELECT n.id FROM eureka.applicant_notice n
     WHERE n.status = 'pending' AND n.next_attempt_at <= pg_catalog.now() AND n.attempts < 8
     ORDER BY n.next_attempt_at, n.id
     LIMIT least(greatest(coalesce(p_limit, 20), 1), 100)
     FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE eureka.applicant_notice n
       SET attempts = n.attempts + 1,
           next_attempt_at = pg_catalog.now() + interval '1 minute' * (2 ^ n.attempts)
      FROM due WHERE n.id = due.id
    RETURNING n.id, n.application_id, n.kind, n.to_status, n.interview_id, n.attempts
  )
  SELECT c.id, c.kind, c.to_status, ap.email, j.title, c.attempts,
         i.interview_type, i.round, i.starts_at, i.duration_minutes::integer, i.meeting_link
    FROM claimed c
    JOIN eureka.job_application a ON a.id = c.application_id
    JOIN eureka.applicant ap ON ap.id = a.applicant_id AND ap.status = 'active'
    JOIN eureka.job j ON j.id = a.job_id
    LEFT JOIN eureka.application_interview i ON i.id = c.interview_id;
END $function$;

REVOKE ALL ON FUNCTION authz.applicant_notice_claim(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.applicant_notice_claim(integer) TO eureka_app;
RESET ROLE;
