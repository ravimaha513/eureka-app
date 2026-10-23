-- eureka.feedback_due: current definition (repeatable; db/functions/README.md).
-- Earlier bodies: migrations 0021, 0028, 0033. Change this file, not a new migration.

SET ROLE eureka_owner;
CREATE OR REPLACE FUNCTION eureka.feedback_due()
 RETURNS TABLE(id uuid)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
 SELECT i.id FROM eureka.interview i JOIN eureka.candidate c ON c.id=i.candidate_id JOIN eureka.person p ON p.id=c.person_id
 WHERE i.ends_at <= now()-interval '60 minutes'
 AND i.call_status NOT IN ('cancelled','rescheduled','no_invite') AND p.personal_email IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM eureka.feedback_delivery d WHERE d.interview_id=i.id AND d.starts_at=i.starts_at AND d.ends_at=i.ends_at AND (d.sent_at IS NOT NULL OR d.used_at IS NOT NULL))
 AND NOT EXISTS(SELECT 1 FROM eureka.import_link l WHERE l.sheet='interviews' AND l.entity_id=i.id AND i.ends_at <= l.committed_at)
 ORDER BY i.ends_at LIMIT 100
$function$;

REVOKE ALL ON FUNCTION eureka.feedback_due() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eureka.feedback_due() TO eureka_worker;
RESET ROLE;
