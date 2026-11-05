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
 * ILIKE off the index, so app-role lists still scan (docs/backend-audit/perf-baseline.md).
 */
export const nameSearch = (alias: string, param: string): string => `${personName(alias)} ILIKE ${param} ESCAPE '\\'`;
