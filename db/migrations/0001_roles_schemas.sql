-- Cluster roles and schemas (design B4.5, B4.8).
-- Run as a superuser (or rds_superuser) once per database cluster.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eureka_owner') THEN
    CREATE ROLE eureka_owner NOLOGIN;              -- owns tables; never used by the app
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authz_definer') THEN
    CREATE ROLE authz_definer NOLOGIN;             -- owns authz functions; reads via explicit policies (0009)
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eureka_app') THEN
    CREATE ROLE eureka_app LOGIN;                  -- API; no BYPASSRLS, owns nothing
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eureka_worker') THEN
    CREATE ROLE eureka_worker LOGIN;               -- worker; no BYPASSRLS
  END IF;
END $$;

-- On Amazon RDS the migration user is rds_superuser, not a true superuser.
-- PostgreSQL 16 does not let a non-superuser act as roles it created unless
-- granted explicitly. The migration user administers the owner roles only
-- (it needs their ownership rights to run DDL); it never joins the app roles.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    EXECUTE format('GRANT eureka_owner, authz_definer TO %I WITH SET TRUE, INHERIT TRUE', current_user);
  END IF;
END $$;

-- Worker may act for a user with SET LOCAL ROLE eureka_app (design B4.8, N9).
GRANT eureka_app TO eureka_worker WITH INHERIT FALSE, SET TRUE;

CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS eureka AUTHORIZATION eureka_owner;
CREATE SCHEMA IF NOT EXISTS authz AUTHORIZATION authz_definer;

REVOKE ALL ON SCHEMA eureka FROM PUBLIC;
REVOKE ALL ON SCHEMA authz FROM PUBLIC;
GRANT USAGE ON SCHEMA eureka TO eureka_app, eureka_worker, authz_definer;
GRANT USAGE ON SCHEMA authz TO eureka_app, eureka_worker, eureka_owner;
-- Functions are not executable by default; each one is granted explicitly.
ALTER DEFAULT PRIVILEGES FOR ROLE authz_definer IN SCHEMA authz REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE eureka_owner IN SCHEMA eureka REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
