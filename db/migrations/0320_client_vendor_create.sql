-- Every Sales role (client:create, vendor:create) can add a client or vendor
-- from the submission pickers (docs/lookups-api.md). Like technologies before
-- 0250, clients and vendors had no write path: rows came only from dev seeds,
-- so staging had none and "Log submission" could not pick a client.
-- authz.create_client / authz.create_vendor (db/functions/authz/) are the one
-- write path; this grants what they need.

GRANT SELECT (id, name), INSERT (name) ON eureka.client TO authz_definer;
GRANT SELECT (id, name), INSERT (name) ON eureka.vendor TO authz_definer;
