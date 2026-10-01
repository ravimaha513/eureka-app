-- Bootstrap review follow-ups (0037; independent review 2026-10-01).
--
-- A1. authz.bootstrap_admins and authz.assert_admin_remains decide on the
--     admin count after an advisory lock. Under REPEATABLE READ/SERIALIZABLE
--     the snapshot is taken before the lock, so two concurrent callers could
--     both see "no admin" (four admins were created in a test). Both now
--     refuse unless the transaction is READ COMMITTED, where each statement
--     after the lock sees what the previous holder committed. The API uses
--     READ COMMITTED (the default) everywhere it can reach assert_admin_remains.
-- A5. The bootstrap is break-glass: it refuses while an active org_admin
--     exists, and once any bootstrap has happened (an 'admin.bootstrap' audit
--     row exists) it also refuses with no admin left unless p_recover is true
--     (CLI --recover), so a lock-out recovery is a deliberate, audited act.
-- A6. Actor-less bootstrap audit rows can only come from the bootstrap: the
--     app and worker insert policy now rejects actions 'admin.bootstrap%'.
SET ROLE eureka_owner;

ALTER POLICY audit_insert ON eureka.audit_event
  WITH CHECK (coalesce(action, '') NOT LIKE 'admin.bootstrap%');

-- The bootstrap reads whether an earlier bootstrap happened (action only).
GRANT SELECT (action) ON eureka.audit_event TO authz_definer;
CREATE POLICY audit_bootstrap_read ON eureka.audit_event FOR SELECT TO authz_definer
  USING (action = 'admin.bootstrap');

RESET ROLE;
SET ROLE authz_definer;

CREATE OR REPLACE FUNCTION authz.assert_admin_remains() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN
    RAISE EXCEPTION 'read_committed_required' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  -- Serialise concurrent admin removals explicitly (not via incidental row locks).
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('eureka.org_admin_count'));
  IF NOT EXISTS (
      SELECT 1 FROM eureka.user_role ur JOIN eureka.app_user u ON u.id = ur.user_id
      WHERE ur.role_key = 'org_admin' AND ur.valid @> pg_catalog.now() AND u.status = 'active') THEN
    RAISE EXCEPTION 'last_admin' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
END $$;

DROP FUNCTION authz.bootstrap_admins(text[], text[], text);

CREATE FUNCTION authz.bootstrap_admins(p_emails text[], p_names text[], p_domain text, p_recover boolean DEFAULT false)
RETURNS TABLE (user_id uuid, outcome text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  dom      text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_domain, '')));
  n        integer := coalesce(pg_catalog.cardinality(p_emails), 0);
  recover  boolean := coalesce(p_recover, false);
  wanted   text[];
  existing text[];
  i        integer;
  e        text;
  nm       text;
  uid      uuid;
  st       text;
  created  boolean;
BEGIN
  -- A1: the snapshot must be taken after the lock (READ COMMITTED only).
  IF pg_catalog.current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN
    RAISE EXCEPTION 'read_committed_required' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  -- Same lock as authz.assert_admin_remains: one admin-count decision at a time.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('eureka.org_admin_count'));

  IF dom = '' OR dom !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' THEN
    RAISE EXCEPTION 'bootstrap_domain_invalid' USING ERRCODE = 'check_violation';
  END IF;
  IF n < 1 OR n > 2 OR coalesce(pg_catalog.cardinality(p_names), 0) <> n THEN
    RAISE EXCEPTION 'bootstrap_admin_count' USING ERRCODE = 'check_violation';
  END IF;
  SELECT pg_catalog.array_agg(DISTINCT pg_catalog.lower(pg_catalog.btrim(x)) ORDER BY pg_catalog.lower(pg_catalog.btrim(x)))
    INTO wanted FROM pg_catalog.unnest(p_emails) x;
  IF coalesce(pg_catalog.cardinality(wanted), 0) <> n THEN
    RAISE EXCEPTION 'bootstrap_duplicate_email' USING ERRCODE = 'check_violation';
  END IF;
  FOR i IN 1..n LOOP
    e := wanted[i];
    IF e IS NULL OR e !~ '^[^@[:space:]]+@[^@[:space:]]+$' OR pg_catalog.split_part(e, '@', 2) IS DISTINCT FROM dom THEN
      RAISE EXCEPTION 'email_domain' USING ERRCODE = 'check_violation';
    END IF;
    nm := pg_catalog.btrim(coalesce(p_names[i], ''));
    IF nm = '' OR pg_catalog.length(nm) > 200 THEN
      RAISE EXCEPTION 'bootstrap_name_invalid' USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;

  SELECT coalesce(pg_catalog.array_agg(pg_catalog.lower(u.email::text) ORDER BY pg_catalog.lower(u.email::text)), '{}')
    INTO existing
    FROM eureka.app_user u
   WHERE u.status = 'active'
     AND EXISTS (SELECT 1 FROM eureka.user_role ur WHERE ur.user_id = u.id
                 AND ur.role_key = 'org_admin' AND ur.valid @> pg_catalog.now());
  IF pg_catalog.cardinality(existing) > 0 THEN
    IF existing = wanted THEN
      RETURN QUERY SELECT u.id, 'unchanged'::text FROM eureka.app_user u
        WHERE pg_catalog.lower(u.email::text) = ANY (wanted) ORDER BY pg_catalog.lower(u.email::text);
      RETURN;
    END IF;
    RAISE EXCEPTION 'admin_exists' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  -- A5: a second bootstrap (no admin left) is a deliberate recovery.
  IF NOT recover AND EXISTS (SELECT 1 FROM eureka.audit_event a WHERE a.action = 'admin.bootstrap') THEN
    RAISE EXCEPTION 'bootstrap_used' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  FOR i IN 1..n LOOP
    e := pg_catalog.lower(pg_catalog.btrim(p_emails[i]));
    nm := pg_catalog.btrim(p_names[i]);
    SELECT u.id, u.status INTO uid, st FROM eureka.app_user u
      WHERE pg_catalog.lower(u.email::text) = e FOR UPDATE;
    created := NOT FOUND;
    IF created THEN
      INSERT INTO eureka.app_user (email, display_name) VALUES (e, nm) RETURNING id INTO uid;
    ELSE
      IF st IS DISTINCT FROM 'active' THEN
        RAISE EXCEPTION 'user_inactive' USING ERRCODE = 'check_violation';
      END IF;
      -- Separation of duties (AD-3a): an admin holds no business role.
      IF EXISTS (SELECT 1 FROM eureka.user_role ur WHERE ur.user_id = uid AND ur.valid @> pg_catalog.now()) THEN
        RAISE EXCEPTION 'separation_of_duties' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    INSERT INTO eureka.user_role (user_id, role_key) VALUES (uid, 'org_admin');
    INSERT INTO eureka.audit_event (actor_id, action, entity_type, entity_id, changes)
    VALUES (NULL, 'admin.bootstrap', 'app_user', uid,
            pg_catalog.jsonb_build_object('actor', 'system:bootstrap', 'role', 'org_admin',
                                          'userCreated', created, 'admins', n, 'recover', recover));
    user_id := uid;
    outcome := CASE WHEN created THEN 'created' ELSE 'existing_user' END;
    RETURN NEXT;
  END LOOP;
END $$;

RESET ROLE;
-- No GRANT: only the owner (authz_definer) and its members (the migration user) may execute it (0037).
REVOKE ALL ON FUNCTION authz.bootstrap_admins(text[], text[], text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION authz.assert_admin_remains() FROM PUBLIC;
