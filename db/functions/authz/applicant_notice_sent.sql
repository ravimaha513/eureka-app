-- authz.applicant_notice_sent: current definition (repeatable; db/functions/README.md).
-- Marks a claimed applicant notice sent (0190). A notice that is no longer pending is left as it is.

SET ROLE authz_definer;
CREATE OR REPLACE FUNCTION authz.applicant_notice_sent(p_id uuid)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  UPDATE eureka.applicant_notice SET status = 'sent', sent_at = pg_catalog.now()
   WHERE id = p_id AND status = 'pending'
$function$;

REVOKE ALL ON FUNCTION authz.applicant_notice_sent(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.applicant_notice_sent(uuid) TO eureka_app;
RESET ROLE;
