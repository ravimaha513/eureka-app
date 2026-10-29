-- Any signed-in user can add a technology (docs/lookups-api.md). Technologies
-- had no write path: eureka_app has SELECT only and rows came from seed scripts
-- or 0140, which only topped up databases that already had some, so a database
-- built from scratch (staging, 2026-10-15) had none and every technology picker
-- was empty. authz.create_technology (db/functions/authz/create_technology.sql)
-- is the one write path; this grants what it needs.

GRANT SELECT (id, name, active), INSERT (name) ON eureka.technology TO authz_definer;
