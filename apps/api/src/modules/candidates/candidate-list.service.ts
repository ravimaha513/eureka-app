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
import { CANDIDATE_SELECT, presentCandidate, scopePredicate, stayOf, type CandidateRow } from "./candidate-common.js";

/**
 * Hot List / Candidates list filters added for the Eureka App 4 spec, as
 * parameterized predicates (the open Hot List applies the same in
 * authz.hotlist_page). The resume filter reads authz.resume_candidate_ids once
 * per statement (InitPlan feeding a hashed SubPlan, rule 3).
 */
export function extraFilterPredicates(q: CandidateListQuery, params: unknown[], alias = "c"): string[] {
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  const where: string[] = [];
  if (q.locationId) where.push(`${alias}.location_id = ${p(q.locationId)}`);
  if (q.visa) where.push(`${alias}.visa_category = ${p(q.visa)}`);
  if (q.documents === "none") where.push(`${alias}.documents_status IS NULL`);
  else if (q.documents) where.push(`${alias}.documents_status = ${p(q.documents)}`);
  if (q.resume) {
    const has = `(${alias}.resume_url IS NOT NULL OR ${alias}.id IN (SELECT pg_catalog.unnest((SELECT authz.resume_candidate_ids()))))`;
    where.push(q.resume === "yes" ? has : `NOT ${has}`);
  }
  if (q.stay === "remote") where.push(`${alias}.gh_remote`);
  if (q.stay === "guest_house") where.push(`${alias}.gh_location_id IS NOT NULL`);
  if (q.priority) where.push(`${alias}.priority = ${p(q.priority)}`);
  if (q.teamId) where.push(`${alias}.team_id = ${p(q.teamId)}`);
  if (q.recruiterId) where.push(`${alias}.recruiter_id = ${p(q.recruiterId)}`);
  if (q.inPerson) where.push(`${alias}.in_person_ok IS ${q.inPerson === "yes" ? "TRUE" : "FALSE"}`);
  if (q.ghLocationId) where.push(`${alias}.gh_location_id = ${p(q.ghLocationId)}`);
  return where;
}

/** The 0290 filters and sort for authz.hotlist_page / hotlist_export (one jsonb argument, so new keys need no new signature). */
export function moreFilters(q: Pick<CandidateListQuery, "priority" | "teamId" | "recruiterId" | "inPerson" | "ghLocationId" | "sort">) {
  return {
    priority: q.priority ?? null, teamId: q.teamId ?? null, recruiterId: q.recruiterId ?? null,
    inPerson: q.inPerson ?? null, ghLocationId: q.ghLocationId ?? null, sort: q.sort ?? null,
  };
}

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
    if (q.status) { params.push(q.status); where.push(`c.marketing_status = $${params.length}`); }
    if (q.technology) { params.push(q.technology); where.push(`t.name = $${params.length}`); }
    if (q.visibility) { params.push(q.visibility); where.push(`c.visibility = $${params.length}`); }
    if (q.batchId) { params.push(q.batchId); where.push(`c.batch_id = $${params.length}`); }
    where.push(...extraFilterPredicates(q, params));
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

  /** Audit row of one Hot List page: who, filter summary (free text as a flag only, rule 5), row count and id range. */
  private async auditHotlistPage(c: pg.PoolClient, user: AuthedUser, q: CandidateListQuery, r: { id: string }[]) {
    const n = Math.min(r.length, q.limit);
    await this.audit.record(c, {
      actorId: user.id, action: "hotlist.read", entityType: "candidate",
      changes: {
        filters: {
          status: q.status, technology: q.technology, visibility: q.visibility, search: q.search ? true : undefined,
          locationId: q.locationId, visa: q.visa, documents: q.documents, resume: q.resume, stay: q.stay,
          priority: q.priority, teamId: q.teamId, recruiterId: q.recruiterId, inPerson: q.inPerson,
          ghLocationId: q.ghLocationId, sort: q.sort,
        },
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
        `SELECT * FROM authz.hotlist_page($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [q.status ?? null, q.technology ?? null, q.visibility ?? null, search, q.cursor ?? null, q.limit + 1,
          q.locationId ?? null, q.visa ?? null, q.documents ?? null, q.resume === undefined ? null : q.resume === "yes",
          q.stay ?? null, moreFilters(q)],
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
