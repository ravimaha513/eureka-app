-- Restricted documents open without step-up (owner decision on security
-- review B-01 / roadmap R-06, option B: accept the risk with compensating
-- controls; commit cd4d82e, migration 0350). This adds the database-side
-- control: a per-user cap on restricted opens in any rolling 24 hours,
-- counted across candidate documents (eureka.document_access,
-- classification 'restricted') and DataHub (eureka.datahub_access, effective
-- level 'restricted'), enforced inside authz.document_download and
-- authz.datahub_download (db/functions/authz/*.sql) before the access row is
-- written. Over the cap: 'too_many_restricted_opens' (check_violation; the
-- API answers 429). docs/documents-api.md, docs/datahub-api.md.
--
--   * The cap is authz.policy_setting 'restricted_opens_per_day' (default
--     200, seeded here; 1..99999). Like the other policy settings it is not
--     writable by the app: change it as the migration owner with
--     UPDATE authz.policy_setting SET value = '<n>' WHERE key = 'restricted_opens_per_day'.
--   * Both download functions return the caller's count after this open and
--     the cap (NULL for non-restricted files), so the API can log a warning
--     when a user crosses 80 % of the cap (ids only). Their return type
--     changes, so they are dropped here and the db/functions files create
--     them again (db/functions/README.md).
--   * authz.restricted_open_take: internal (owner only), serialised per user
--     with an advisory lock so parallel opens cannot overshoot the cap.

SET ROLE authz_definer;
ALTER TABLE authz.policy_setting
  ADD CONSTRAINT policy_setting_restricted_opens CHECK (key <> 'restricted_opens_per_day' OR value ~ '^[1-9][0-9]{0,4}$');
INSERT INTO authz.policy_setting (key, value) VALUES ('restricted_opens_per_day', '200') ON CONFLICT (key) DO NOTHING;
RESET ROLE;

SET ROLE eureka_owner;
-- The cap counts one user's restricted opens of the last 24 hours on every restricted open.
CREATE INDEX document_access_user_restricted ON eureka.document_access (user_id, at) WHERE classification = 'restricted';
CREATE INDEX datahub_access_user_restricted ON eureka.datahub_access (user_id, at) WHERE level = 'restricted';
RESET ROLE;

SET ROLE authz_definer;

DROP FUNCTION authz.document_download(uuid, bytea);
DROP FUNCTION authz.datahub_download(uuid, bytea);

-- Called by authz.document_download / authz.datahub_download for a restricted open, before the access row is written:
-- refuses the open when the caller already has `cap` restricted opens in the last 24 hours; otherwise returns the
-- count including this open and the cap. Internal.
CREATE FUNCTION authz.restricted_open_take() RETURNS TABLE (opens integer, cap integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE me uuid := authz.current_user_id(); c integer; n integer;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('restricted_open:' || me::text, 0));
  SELECT s.value::integer INTO c FROM authz.policy_setting s WHERE s.key = 'restricted_opens_per_day';
  c := coalesce(c, 200);
  SELECT (SELECT pg_catalog.count(*) FROM eureka.document_access a
           WHERE a.user_id = me AND a.classification = 'restricted' AND a.at > pg_catalog.now() - interval '24 hours')
       + (SELECT pg_catalog.count(*) FROM eureka.datahub_access a
           WHERE a.user_id = me AND a.level = 'restricted' AND a.at > pg_catalog.now() - interval '24 hours')
    INTO n;
  IF coalesce(n, 0) >= c THEN
    RAISE EXCEPTION 'too_many_restricted_opens' USING ERRCODE = 'check_violation';
  END IF;
  RETURN QUERY SELECT coalesce(n, 0) + 1, c;
END $$;
REVOKE ALL ON FUNCTION authz.restricted_open_take() FROM PUBLIC;

RESET ROLE;
