-- Rename a team after it is created (docs/admin-api.md, Teams). The definer
-- function authz.admin_rename_team lives in db/functions/authz/admin_rename_team.sql;
-- this only lets its owner write the column.
GRANT UPDATE (name) ON eureka.team TO authz_definer;
