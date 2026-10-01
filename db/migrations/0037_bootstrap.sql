-- First-admin bootstrap (infra/README.md "First admin"; CLI apps/api/src/db/bootstrap.ts).
--
-- A fresh stack has the role catalog and no users, so nobody can sign in or
-- administer it. authz.bootstrap_admins creates the first org_admin user(s)
-- for Google accounts in the hosted domain, once:
--   * it refuses ('admin_exists') while any active user holds org_admin, so
--     it cannot be used later to add an administrator past the second-approver
--     rule (AD-3); re-running with exactly the current admins changes nothing
--     and reports 'unchanged' (idempotent);
--   * it serialises with admin removals (authz.assert_admin_remains) on the
--     same advisory lock;
--   * the admins get org_admin only (rule 7, AD-3a): an existing account is
--     reused only if it is active and holds no role;
--   * each grant writes an audit_event in the same transaction with no actor
--     (system) and no email (rule 5);
--   * the user is linked to Google on first sign-in by email, exactly like an
--     admin-created user (google_sub stays NULL until then, design A6.1).
-- Why a migration: on Amazon RDS the migration user is not a superuser, and
-- audit_event forces RLS with insert policies for the app and worker roles
-- only, so the CLI could not audit the grant in the same transaction. This
-- adds a narrow insert policy for authz_definer that admits system bootstrap
-- rows only.
--
-- Who can execute: no GRANT. Only the owner (authz_definer) and its members,
-- i.e. the migration user (0001 grants it authz_definer), which the one-off
-- migrate ECS task logs in as. eureka_app, eureka_worker and eureka_import
-- cannot, so the API can never reach it.
SET ROLE eureka_owner;

GRANT INSERT (actor_id, action, entity_type, entity_id, changes) ON eureka.audit_event TO authz_definer;
-- audit_event_stamp (0019) assigns seq with nextval as the inserting role.
GRANT USAGE ON SEQUENCE eureka.audit_event_seq_seq TO authz_definer;
CREATE POLICY audit_bootstrap_insert ON eureka.audit_event FOR INSERT TO authz_definer
  WITH CHECK (actor_id IS NULL AND action IN ('admin.bootstrap', 'admin.bootstrap_demo'));

RESET ROLE;
SET ROLE authz_definer;

CREATE FUNCTION authz.bootstrap_admins(p_emails text[], p_names text[], p_domain text)
RETURNS TABLE (user_id uuid, outcome text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  dom      text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_domain, '')));
  n        integer := coalesce(pg_catalog.cardinality(p_emails), 0);
  wanted   text[];
  existing text[];
  i        integer;
  e        text;
  nm       text;
  uid      uuid;
  st       text;
  created  boolean;
BEGIN
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
                                          'userCreated', created, 'admins', n));
    user_id := uid;
    outcome := CASE WHEN created THEN 'created' ELSE 'existing_user' END;
    RETURN NEXT;
  END LOOP;
END $$;

RESET ROLE;
REVOKE ALL ON FUNCTION authz.bootstrap_admins(text[], text[], text) FROM PUBLIC;
