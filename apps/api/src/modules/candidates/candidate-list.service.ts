/** Candidates list and the Hot List (scoped and open), with Hot List page auditing. */
import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  type OnModuleInit,
} from "@nestjs/common";
import type pg from "pg";
import {
  HOTLIST_STATUSES,
  HOTLIST_VISIBILITY,
  marketingStatusLabel,
  resolveScope,
  type CandidateVisibility,
  type ListSort,
} from "@eureka/shared";
import { AuditService } from "../../platform/audit.service.js";
import type { AuthedUser } from "../../platform/auth.guard.js";
import { DbService } from "../../platform/db.service.js";
import { RateLimiter } from "../../platform/rate-limit.js";
import { likeContains, scopedNameSearch } from "../../platform/sql.js";
import type { CandidateListQuery } from "./candidates.schemas.js";
import {
  FACET_KEYS, facetQuery, filterPredicates, filterSummary, hotlistMore, shapeFacets, type FacetCounts, type ListFilter,
} from "./list-filters.js";
import { CANDIDATE_SELECT, presentCandidate, scopePredicate, stayOf, type CandidateRow } from "./candidate-common.js";

/**
 * Order key of a list sort (null: id order). Paging is keyset on (key, id),
 * the cursor row's key read back by id. Mirrored by authz.hotlist_page (0290).
 */
export function sortKey(sort: ListSort | undefined, c = "c", p = "p"): string | null {
  switch (sort) {
    case "priority": return `${c}.priority`;
    case "days": return `coalesce(${c}.marketing_start_date, 'infinity'::date)`;
    case "name": return `lower(${p}.first_name || ' ' || ${p}.last_name)`;
    default: return null;
  }
}

interface HotlistRow {
  id: string;
  first_name: string;
  last_name: string;
  technology: string;
  team_id: string;
  team_name: string;
  recruiter_id: string | null;
  recruiter_name: string | null;
  location_id: string;
  location_name: string;
  visibility: CandidateVisibility;
  marketing_status: string;
  priority: string;
  marketing_start_date: string | null;
  technical_rating: number | null;
  phone: string | null;
  phone_masked: boolean;
  readable: boolean;
  visa_category: string | null;
  documents_status: string | null;
  gh_remote: boolean;
  gh_location_name: string | null;
  has_resume: boolean;
  lead_name: string | null;
  in_person_ok: boolean | null;
}

/**
 * Hot List pages per user per minute (anti-scraping; design A-threats "mass
 * export"). Counted per API task, so the effective ceiling is this times the
 * number of running tasks.
 */
export const HOTLIST_PAGES_PER_MINUTE = 60;

@Injectable()
export class CandidateListService implements OnModuleInit {
  private readonly log = new Logger(CandidateListService.name);
  private readonly hotlistLimiter = new RateLimiter(HOTLIST_PAGES_PER_MINUTE, 60_000);
  /** Facet counts have their own budget: each filter change asks for a page and its counts. */
  private readonly facetLimiter = new RateLimiter(HOTLIST_PAGES_PER_MINUTE, 60_000);
  /** The database is the source of truth for the Hot List switch (cached briefly). */
  private hotlistPolicy: "everyone" | "team" = HOTLIST_VISIBILITY;
  private hotlistPolicyAt = 0;

  private async currentHotlistPolicy(): Promise<"everyone" | "team"> {
    if (Date.now() - this.hotlistPolicyAt < 30_000) return this.hotlistPolicy;
    try {
      const { rows } = await this.db.system((c) => c.query<{ v: string }>("SELECT authz.hotlist_visibility() AS v"));
      const v = rows[0]?.v;
      this.hotlistPolicy = v === "everyone" ? "everyone" : "team"; // anything unexpected fails closed
      this.hotlistPolicyAt = Date.now();
    } catch (err) {
      this.log.warn(`Could not read Hot List policy: ${(err as Error).message}`);
    }
    return this.hotlistPolicy;
  }

  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  /** The engine reads the Hot List switch from code, RLS/functions from the database; they must agree. */
  async onModuleInit() {
    try {
      const { rows } = await this.db.system((c) => c.query<{ v: string }>("SELECT authz.hotlist_visibility() AS v"));
      if (rows[0]?.v !== HOTLIST_VISIBILITY) {
        this.log.error(`Hot List policy mismatch: code=${HOTLIST_VISIBILITY} database=${rows[0]?.v}; run migrations`);
      }
    } catch (err) {
      this.log.warn(`Could not read Hot List policy: ${(err as Error).message}`);
    }
  }

  async list(user: AuthedUser, perm: "candidate:read" | "hotlist:read", q: CandidateListQuery) {
    const scope = perm === "hotlist:read"
      ? resolveScope(user.access, perm, await this.currentHotlistPolicy())
      : resolveScope(user.access, perm);
    if (!scope) throw new ForbiddenException();
    if (perm === "hotlist:read") {
      if (!this.hotlistLimiter.take(user.id)) {
        throw new HttpException("Too many Hot List requests; try again in a minute", HttpStatus.TOO_MANY_REQUESTS);
      }
      if (scope.hotlistOpen) return this.openHotlist(user, q);
    }
    const params: unknown[] = [];
    const where = [scopePredicate(scope, params)];
    if (perm === "hotlist:read") { params.push([...HOTLIST_STATUSES]); where.push(`c.marketing_status = ANY($${params.length}::text[])`); }
    where.push(...Object.values(filterPredicates(q, params)));
    if (q.search) {
      params.push(likeContains(q.search));
      where.push(scopedNameSearch("p", `$${params.length}`, q.search));
    }
    const key = sortKey(q.sort);
    if (q.cursor) {
      params.push(q.cursor);
      const cur = `$${params.length}::uuid`;
      where.push(key
        ? `(${key}, c.id) > (SELECT ${sortKey(q.sort, "cc", "pp")}, cc.id FROM eureka.candidate cc
             JOIN eureka.person pp ON pp.id = cc.person_id WHERE cc.id = ${cur})`
        : `c.id > ${cur}`);
    }
    params.push(q.limit + 1);
    const sql = `${CANDIDATE_SELECT} WHERE ${where.join(" AND ")} ORDER BY ${key ? `${key}, ` : ""}c.id LIMIT $${params.length}`;
    const { rows, withResume } = await this.db.withUser(user.id, async (c) => {
      const r = (await c.query<CandidateRow>(sql, params)).rows;
      const ids = r.slice(0, q.limit).map((x) => x.id);
      const flags = (await c.query<{ ids: string[] }>(`SELECT authz.resume_flags($1::uuid[]) AS ids`, [ids])).rows[0]!.ids;
      // Every Hot List page is audited, whichever policy serves it (anti-scraping).
      if (perm === "hotlist:read") await this.auditHotlistPage(c, user, q, r);
      return { rows: r, withResume: new Set(flags) };
    });
    const page = rows.slice(0, q.limit);
    return {
      items: page.map((r) => ({
        ...presentCandidate(user.access, r, r.resume_link || withResume.has(r.id)),
        // Rows here come from candidate:read's own scope (RLS), so every profile opens.
        canOpenProfile: true,
      })),
      nextCursor: rows.length > q.limit ? page[page.length - 1]!.id : null,
    };
  }

  /**
   * Facet counts for the list filters: per filter, how many candidates in the caller's list carry
   * each value when every other filter applies. Same scope as `list` (the open Hot List through
   * authz.hotlist_facets). Aggregates only, so not audited per read; the Hot List's are rate-limited.
   */
  async facets(user: AuthedUser, perm: "candidate:read" | "hotlist:read", q: ListFilter): Promise<FacetCounts> {
    const scope = perm === "hotlist:read"
      ? resolveScope(user.access, perm, await this.currentHotlistPolicy())
      : resolveScope(user.access, perm);
    if (!scope) throw new ForbiddenException();
    const keys = perm === "hotlist:read" ? FACET_KEYS.filter((k) => k !== "batchId") : FACET_KEYS;
    const search = q.search ? likeContains(q.search) : null;
    if (perm === "hotlist:read") {
      if (!this.facetLimiter.take(user.id)) {
        throw new HttpException("Too many Hot List requests; try again in a minute", HttpStatus.TOO_MANY_REQUESTS);
      }
      if (scope.hotlistOpen) {
        const rows = await this.db.withUser(user.id, async (c) => (await c.query<{ facet: string; value: string | null; n: string }>(
          `SELECT * FROM authz.hotlist_facets($1, $2, $3, $4)`,
          [search, q.resume === undefined ? null : q.resume === "yes", q.stay ?? null, hotlistMore(q)])).rows);
        return shapeFacets(rows, keys);
      }
    }
    const params: unknown[] = [];
    const where = [scopePredicate(scope, params)];
    if (perm === "hotlist:read") { params.push([...HOTLIST_STATUSES]); where.push(`c.marketing_status = ANY($${params.length}::text[])`); }
    // Same name predicate as `list` (index-backed scoped match plus the ILIKE; identical results).
    if (search && q.search) { params.push(search); where.push(scopedNameSearch("p", `$${params.length}`, q.search)); }
    const sql = facetQuery(where, filterPredicates(q, params), keys);
    const rows = await this.db.withUser(user.id, async (c) =>
      (await c.query<{ facet: string; value: string | null; n: string }>(sql, params)).rows);
    return shapeFacets(rows, keys);
  }

  /** Audit row of one Hot List page: who, filter summary (free text as a flag only, rule 5), row count and id range. */
  private async auditHotlistPage(c: pg.PoolClient, user: AuthedUser, q: CandidateListQuery, r: { id: string }[]) {
    const n = Math.min(r.length, q.limit);
    await this.audit.record(c, {
      actorId: user.id, action: "hotlist.read", entityType: "candidate",
      changes: {
        filters: filterSummary(q),
        rows: n, firstId: r[0]?.id ?? null, lastId: r[n - 1]?.id ?? null,
      },
    });
  }

  /**
   * Open Hot List (OD-01): served by authz.hotlist_page, which returns only list
   * columns with phones masked in SQL, so base-table RLS stays scoped. Every page
   * read is audited.
   */
  private async openHotlist(user: AuthedUser, q: CandidateListQuery) {
    const search = q.search ? likeContains(q.search) : null;
    const rows = await this.db.withUser(user.id, async (c) => {
      const r = (await c.query<HotlistRow>(
        `SELECT * FROM authz.hotlist_page(NULL, NULL, NULL, $1, $2, $3, NULL, NULL, NULL, $4, $5, $6)`,
        [search, q.cursor ?? null, q.limit + 1, q.resume === undefined ? null : q.resume === "yes", q.stay ?? null, hotlistMore(q)],
      )).rows;
      await this.auditHotlistPage(c, user, q, r);
      return r;
    });
    const page = rows.slice(0, q.limit);
    return {
      items: page.map((r) => {
        const days = r.marketing_start_date
          ? Math.floor((Date.now() - Date.parse(r.marketing_start_date)) / 86_400_000)
          : null;
        return {
          id: r.id,
          name: `${r.first_name} ${r.last_name}`,
          technology: r.technology,
          status: r.marketing_status,
          statusLabel: marketingStatusLabel(r.marketing_status, r.visibility, r.gh_remote),
          visibility: r.visibility,
          priority: r.priority,
          team: { id: r.team_id, name: r.team_name, lead: r.lead_name },
          inPersonOk: r.in_person_ok,
          recruiter: r.recruiter_id ? { id: r.recruiter_id, name: r.recruiter_name } : null,
          location: { id: r.location_id, name: r.location_name },
          ghLocation: r.gh_location_name ? { name: r.gh_location_name } : null,
          stay: stayOf(r),
          visaCategory: r.visa_category,
          documentsStatus: r.documents_status,
          hasResume: r.has_resume,
          marketingStartDate: r.marketing_start_date,
          daysInMarket: days,
          technicalRating: r.technical_rating,
          phone: r.phone,
          phoneMasked: r.phone_masked,
          dobMasked: null,
          canOpenProfile: r.readable,
        };
      }),
      nextCursor: rows.length > q.limit ? page[page.length - 1]!.id : null,
    };
  }
}
