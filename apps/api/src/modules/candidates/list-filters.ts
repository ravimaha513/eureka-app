import { z } from "zod";
import {
  CANDIDATE_VISIBILITIES, DOCUMENTS_FILTERS, LIST_SORTS, STAY_FILTERS, VISA_CATEGORY_LIST,
} from "@eureka/shared";

/**
 * Candidate list filters (Candidates list, Hot List, saved views, export, facet counts).
 *
 * Every "pick from a list" filter takes one or more values: repeat the query parameter
 * (`status=active&status=bench`) or, in a saved view / export body, send an array (a single
 * string is still accepted, so views saved before this change keep working). `not` names the
 * filters to invert (`not=status` = status is none of the values). Resume, stay and in person
 * stay single-valued: each has only two choices.
 */
export const MULTI_KEYS = [
  "status", "technology", "visibility", "batchId", "locationId", "visa", "documents",
  "priority", "teamId", "recruiterId", "ghLocationId",
] as const;
export type MultiKey = (typeof MULTI_KEYS)[number];
/** Every filter that has facet counts. */
export const FACET_KEYS = [...MULTI_KEYS, "resume", "stay", "inPerson"] as const;
export type FacetKey = (typeof FACET_KEYS)[number];

/** Most values one filter may carry. */
export const MAX_VALUES = 50;

const uuid = z.string().uuid();

/** One or more values: a lone value, an array, or (query string) the parameter repeated. Duplicates dropped. */
export const many = <T extends z.ZodTypeAny>(item: T) =>
  z.preprocess(
    (v) => (v === undefined || v === null || v === "" ? undefined : Array.isArray(v) ? v : [v]),
    z.array(item).min(1).max(MAX_VALUES).transform((a) => [...new Set(a)] as z.infer<T>[]).optional(),
  );

/** The filter fields shared by the list queries, saved views and export (`statuses` = the allowed status values). */
export const listFilterFields = <S extends readonly [string, ...string[]]>(statuses: S) => ({
  status: many(z.enum(statuses)),
  technology: many(z.string().trim().min(1).max(80)),
  visibility: many(z.enum(CANDIDATE_VISIBILITIES)),
  locationId: many(uuid),
  visa: many(z.enum(VISA_CATEGORY_LIST as [string, ...string[]])),
  documents: many(z.enum(DOCUMENTS_FILTERS)),
  resume: z.enum(["yes", "no"]).optional(),
  stay: z.enum(STAY_FILTERS).optional(),
  priority: many(z.enum(["P1", "P2", "P3"])),
  teamId: many(uuid),
  recruiterId: many(uuid),
  inPerson: z.enum(["yes", "no"]).optional(),
  ghLocationId: many(uuid),
  not: many(z.enum(MULTI_KEYS)),
  /** Row order; paging stays keyset (sort key, id). */
  sort: z.enum(LIST_SORTS).optional(),
});

/** The parsed filters, as every caller sees them. */
export interface ListFilter {
  status?: string[]; technology?: string[]; visibility?: string[]; batchId?: string[];
  locationId?: string[]; visa?: string[]; documents?: string[]; priority?: string[];
  teamId?: string[]; recruiterId?: string[]; ghLocationId?: string[];
  resume?: "yes" | "no"; stay?: string; inPerson?: "yes" | "no";
  not?: MultiKey[]; search?: string; sort?: (typeof LIST_SORTS)[number];
}

/** Column of each multi-value filter on eureka.candidate (`c`) / eureka.technology (`t`), and its SQL array type. */
const COLUMN: Record<MultiKey, [col: (c: string, t: string) => string, type: "text" | "uuid"]> = {
  status: [(c) => `${c}.marketing_status`, "text"],
  technology: [(_c, t) => `${t}.name`, "text"],
  visibility: [(c) => `${c}.visibility`, "text"],
  batchId: [(c) => `${c}.batch_id`, "uuid"],
  locationId: [(c) => `${c}.location_id`, "uuid"],
  visa: [(c) => `${c}.visa_category`, "text"],
  documents: [(c) => `${c}.documents_status`, "text"],
  priority: [(c) => `${c}.priority`, "text"],
  teamId: [(c) => `${c}.team_id`, "uuid"],
  recruiterId: [(c) => `${c}.recruiter_id`, "uuid"],
  ghLocationId: [(c) => `${c}.gh_location_id`, "uuid"],
};

/**
 * One parameterized boolean per filter in effect, keyed by filter (search and sort are the
 * caller's). A NULL column never matches a value list, so "is none of" keeps it. The resume
 * filter reads authz.resume_candidate_ids once per statement (InitPlan, rule 3).
 */
export function filterPredicates(f: ListFilter, params: unknown[], c = "c", t = "t"): Partial<Record<FacetKey, string>> {
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  const out: Partial<Record<FacetKey, string>> = {};
  const not = new Set(f.not ?? []);
  for (const k of MULTI_KEYS) {
    const vals = f[k];
    if (!vals?.length) continue;
    const [col, type] = COLUMN[k];
    const arr = `${p(vals)}::${type}[]`;
    const hit = k === "documents"
      ? `coalesce(${col(c, t)} = ANY(${arr}) OR (${col(c, t)} IS NULL AND 'none' = ANY(${arr})), false)`
      : `coalesce(${col(c, t)} = ANY(${arr}), false)`;
    out[k] = not.has(k) ? `NOT ${hit}` : hit;
  }
  if (f.resume) {
    const has = `(${c}.resume_url IS NOT NULL OR ${c}.id IN (SELECT pg_catalog.unnest((SELECT authz.resume_candidate_ids()))))`;
    out.resume = f.resume === "yes" ? has : `NOT ${has}`;
  }
  if (f.stay === "remote") out.stay = `${c}.gh_remote`;
  if (f.stay === "guest_house") out.stay = `${c}.gh_location_id IS NOT NULL`;
  if (f.inPerson) out.inPerson = `${c}.in_person_ok IS ${f.inPerson === "yes" ? "TRUE" : "FALSE"}`;
  return out;
}

/**
 * The `p_more` argument of authz.hotlist_page / hotlist_export / hotlist_facets: the sort, the
 * multi-value filters under `f` and the inverted ones under `not`. The single-valued resume and
 * stay keep their own positional arguments; inPerson stays a top-level key (0290).
 */
export function hotlistMore(f: ListFilter) {
  const vals: Record<string, string[]> = {};
  for (const k of MULTI_KEYS) if (k !== "batchId" && f[k]?.length) vals[k] = f[k]!;
  return { sort: f.sort ?? null, inPerson: f.inPerson ?? null, f: vals, not: (f.not ?? []).filter((k) => vals[k]) };
}

/**
 * Audit-safe summary (rule 5): ids and fixed choices as given, free text (name search,
 * technology names) only as a flag.
 */
export function filterSummary(f: ListFilter) {
  return {
    status: f.status, technology: f.technology ? true : undefined, visibility: f.visibility,
    search: f.search ? true : undefined, batchId: f.batchId, locationId: f.locationId, visa: f.visa, documents: f.documents,
    resume: f.resume, stay: f.stay, priority: f.priority, teamId: f.teamId, recruiterId: f.recruiterId,
    inPerson: f.inPerson, ghLocationId: f.ghLocationId, not: f.not?.length ? f.not : undefined, sort: f.sort,
  };
}
