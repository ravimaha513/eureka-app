-- Restricted documents and restricted DataHub files open on role and scope
-- alone: authz.document_download and authz.datahub_download (now in
-- db/functions/authz) record a step-up grant when the session holds one but
-- no longer require it. Google gives unverified apps no auth_time, so Google
-- users could never complete a step-up. The access logs keep every opening;
-- step_up_grant_id is NULL when none was held.
SET ROLE eureka_owner;

ALTER TABLE eureka.document_access DROP CONSTRAINT document_access_step_up;
ALTER TABLE eureka.datahub_access DROP CONSTRAINT datahub_access_step_up;

RESET ROLE;
