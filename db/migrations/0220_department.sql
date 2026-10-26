-- Departments and sub-departments on users (docs/admin-api.md, "Departments"),
-- e.g. Sales and Sales → Interview Prep.
--   eureka.department: a name and an optional parent; two levels only (a
--   sub-department's parent is a top-level department), enforced by the
--   definer functions. Names are unique among siblings, case-insensitively.
--   app_user.department_id: the most specific department a user belongs to.
-- Descriptive only: no authz function, policy or grant reads a department, so it
-- never grants or widens access. Scope stays role + reporting line.
-- Org/reference data like team and location: no RLS (rls.int.test.ts allow-list);
-- the API role reads it and writes only through the admin definer functions in
-- db/functions/authz/admin_{create,rename}_department.sql and
-- admin_set_user_department.sql (rules 2, 4, 6).
SET ROLE eureka_owner;
SET search_path = eureka, public;

CREATE TABLE department (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  parent_id  uuid REFERENCES department(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (parent_id IS DISTINCT FROM id)
);
CREATE UNIQUE INDEX department_name_key
  ON department (coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));

ALTER TABLE app_user ADD COLUMN department_id uuid REFERENCES department(id);
CREATE INDEX app_user_department_idx ON app_user (department_id) WHERE department_id IS NOT NULL;

RESET ROLE;

GRANT SELECT ON eureka.department TO eureka_app, eureka_worker, authz_definer;
GRANT SELECT (department_id) ON eureka.app_user TO eureka_app, eureka_worker;
GRANT INSERT (name, parent_id), UPDATE (name) ON eureka.department TO authz_definer;
GRANT UPDATE (department_id) ON eureka.app_user TO authz_definer;
