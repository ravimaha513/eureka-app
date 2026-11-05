-- Index-backed name search (R-13; docs/backend-audit/performance-review.md G-04, A-05, B-06;
-- measurements in docs/backend-audit/perf-baseline.md).
--
-- Every person / applicant name search is `(x.first_name || ' ' || x.last_name) ILIKE '%term%'`
-- (escaped by likeContains, written once by nameSearch() in apps/api/src/platform/sql.ts and in
-- authz.hotlist_page / authz.hotlist_export). A leading-wildcard ILIKE cannot use a B-tree, so each
-- search scanned every visible person row. A GIN trigram index on the SAME expression serves ILIKE
-- directly (pg_trgm folds case), so the predicates and their matching semantics stay as they were.
-- The index expression must stay byte-for-byte the expression the queries use (no lower(), no
-- coalesce: first_name and last_name are NOT NULL on both tables), or the planner will not match it.
--
-- pg_trgm is a trusted extension (PG 13+): the database owner creates it without superuser, as
-- CI's RDS-like run and RDS itself allow (rule 7). Schema pinned to public, beside btree_gist,
-- citext and pgcrypto (0001): earlier migrations leave the session search_path on eureka.
-- Terms shorter than 3 characters yield no trigram; the planner then falls back to the scan it did
-- before (no minimum length is imposed on the API).
--
-- Measured limit (perf-baseline.md): the index serves the queries authz.hotlist_page / hotlist_export
-- run as authz_definer. Queries run as eureka_app cannot use it: ILIKE is not LEAKPROOF, so under the
-- person/applicant RLS security quals the planner may not turn it into an index condition. Making
-- those list endpoints index-backed needs a scoped definer search (follow-up, security review).

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

SET ROLE eureka_owner;
CREATE INDEX person_name_trgm ON eureka.person USING gin ((first_name || ' ' || last_name) public.gin_trgm_ops);
CREATE INDEX applicant_name_trgm ON eureka.applicant USING gin ((first_name || ' ' || last_name) public.gin_trgm_ops);
RESET ROLE;
