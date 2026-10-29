-- Rename a location after it is created (docs/admin-api.md, Locations). The
-- definer function authz.admin_rename_location lives in
-- db/functions/authz/admin_rename_location.sql; this only lets its owner write
-- the column. Names stay unique (location_name_key).
GRANT UPDATE (name) ON eureka.location TO authz_definer;
