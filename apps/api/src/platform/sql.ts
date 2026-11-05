/** A LIKE/ILIKE pattern matching `s` anywhere, with %, _ and \ escaped (PostgreSQL's default escape is \). */
export const likeContains = (s: string): string => `%${s.replace(/[%_\\]/g, "\\$&")}%`;

/**
 * Full name of an eureka.person / eureka.applicant row (`alias`). The GIN trigram indexes
 * person_name_trgm / applicant_name_trgm (migration 0479) are built on exactly this expression;
 * change both together or name search goes back to scanning every row.
 */
export const personName = (alias: string): string => `(${alias}.first_name || ' ' || ${alias}.last_name)`;

/**
 * Case-insensitive substring name search (R-13). `param` is the placeholder of a likeContains()
 * pattern, e.g. `$3`. authz.hotlist_page / hotlist_export write the same SQL and, running as
 * authz_definer, use the trigram index; as eureka_app the RLS security quals keep this (non-leakproof)
 * ILIKE off the index, so app-role lists add scopedNameSearch()'s id set (docs/backend-audit/perf-baseline.md).
 */
export const nameSearch = (alias: string, param: string): string => `${personName(alias)} ILIKE ${param} ESCAPE '\\'`;

/**
 * pg_trgm can serve `ILIKE '%term%'` from the index only when the term holds a run of 3+ letters or
 * digits (a full trigram); shorter terms make the index scan every entry. Below that, nameMatch() is
 * not added: the plain ILIKE with the list's LIMIT is faster for 1–2 character terms
 * (docs/backend-audit/perf-baseline.md "R-13b").
 */
export const trigramUsable = (term: string): boolean => /[\p{L}\p{N}]{3}/u.test(term);

/**
 * R-13b: the scoped, index-backed name match as an InitPlan id set (rule 3). `idExpr` is the person
 * id column (`p.id`, `e.person_id`); `param` is the placeholder of the same likeContains() pattern
 * passed to nameSearch(). authz.person_name_matches (db/functions/authz) returns the ids of the
 * matching persons the caller may read, i.e. exactly what nameSearch() keeps under person_read, so
 * `nameSearch(...) AND nameMatch(...)` returns the same rows while the planner can start from the
 * matching ids instead of walking the whole list. Keep nameSearch() too (defence in depth).
 * `= ANY ((SELECT ..)::uuid[])` rather than `IN (SELECT unnest(..))` on purpose: as a top-level AND
 * term it becomes an index condition (one primary-key probe per id); the unnest form is estimated at
 * 10 rows and was planned as a nested-loop semi-join with a linear join filter (perf-baseline.md
 * "R-13b", 416 ms vs 51 ms). Only use it ANDed, never under OR (there it would be a linear filter).
 */
export const nameMatch = (idExpr: string, param: string): string =>
  `${idExpr} = ANY ((SELECT authz.person_name_matches(${param}::text))::uuid[])`;

/** nameSearch() plus, when the term can use the trigram index, nameMatch() on `idExpr` (default `<alias>.id`). */
export const scopedNameSearch = (alias: string, param: string, term: string, idExpr = `${alias}.id`): string =>
  trigramUsable(term) ? `${nameSearch(alias, param)} AND ${nameMatch(idExpr, param)}` : nameSearch(alias, param);
