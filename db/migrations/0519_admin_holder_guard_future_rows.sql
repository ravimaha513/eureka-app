-- Security gate (wave 3), "admin is only admin" under concurrency. The role_permission admin-holder
-- guard (0510) and authz.role_separation counted a user's roles with `valid @> now()`. now() is the
-- transaction START, so a grant edit that began before a concurrent admin approval (and waited on
-- its lock) saw the newly granted row's lower bound in its future and missed the new admin holder.
-- Both now count holdings valid now OR LATER (`valid && tstzrange(now(), NULL)`); role_separation is
-- changed in its db/functions file. Same body otherwise.

SET ROLE eureka_owner;

CREATE OR REPLACE FUNCTION eureka.role_permission_admin_holder_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF EXISTS (
       SELECT 1
         FROM (SELECT DISTINCT a.role_key FROM added a JOIN eureka.permission p ON p.key = a.permission
                WHERE NOT p.is_admin_compatible) n
         JOIN eureka.role r ON r.key = n.role_key AND NOT r.is_system AND NOT r.is_admin
        WHERE NOT EXISTS (
                SELECT 1 FROM eureka.role_permission rp JOIN eureka.permission p ON p.key = rp.permission
                 WHERE rp.role_key = n.role_key AND NOT p.is_admin_compatible
                   AND NOT EXISTS (SELECT 1 FROM added a WHERE a.role_key = rp.role_key AND a.permission = rp.permission))
          AND EXISTS (
                SELECT 1 FROM eureka.user_role ur
                  JOIN eureka.user_role ar ON ar.user_id = ur.user_id AND ar.valid && pg_catalog.tstzrange(pg_catalog.now(), NULL)
                  JOIN eureka.role ad ON ad.key = ar.role_key AND ad.is_admin
                 WHERE ur.role_key = n.role_key AND ur.valid && pg_catalog.tstzrange(pg_catalog.now(), NULL))) THEN
    RAISE EXCEPTION 'role_held_by_admin' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION eureka.role_permission_admin_holder_guard() FROM PUBLIC;

RESET ROLE;
