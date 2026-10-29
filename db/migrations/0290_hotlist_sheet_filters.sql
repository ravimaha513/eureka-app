-- 0290: Hot List filters from the company sheet (priority, team, recruiter,
-- in-person, guest house), a sort, and the team lead / in-person columns.
--
-- authz.hotlist_page and authz.hotlist_export gain a trailing p_more jsonb and
-- two result columns, which CREATE OR REPLACE cannot do: drop the old
-- signatures here; db/functions/authz/hotlist_page.sql and hotlist_export.sql
-- create the new ones (db/functions/README.md). Nothing else calls them.

SET ROLE authz_definer;
DROP FUNCTION authz.hotlist_page(text, text, text, text, uuid, integer, uuid, text, text, boolean, text);
DROP FUNCTION authz.hotlist_export(text, text, text, text, integer, uuid, text, text, boolean, text);
RESET ROLE;
