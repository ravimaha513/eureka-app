import { randomUUID } from "node:crypto";
import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
  type OnModuleInit,
} from "@nestjs/common";
import type pg from "pg";
import {
  HOTLIST_STATUSES,
  HOTLIST_VISIBILITY,
  MARKETABLE_STATUSES,
  applyCandidateFieldPolicy,
  canCreateBatch,
  marketingStatusLabel,
  candidateActions,
  candidateTransitionAllowed,
  ownsCandidate,
  hasTrait,
  resolveScope,
  type CandidateCompanyLink,
  type CandidateRef,
  type CandidateVisibility,
  type EffectiveScope,
  type ListSort,
  type Permission,
  type UserAccess,
} from "@eureka/shared";
import { AuditService } from "../../platform/audit.service.js";
import type { AuthedUser } from "../../platform/auth.guard.js";
import { DbService } from "../../platform/db.service.js";
import { RateLimiter } from "../../platform/rate-limit.js";
import type {
  BatchListQuery,
  BatchStatus,
  CandidateListQuery,
  ComplianceUpdate,
  CreateBatch,
  CreateCandidate,
  DuplicateCheck,
  ProfileUpdate,
  TimelineQuery,
} from "./candidates.schemas.js";
import { likeContains } from "../../platform/sql.js";
import { dbErrorMapper } from "../../platform/errors.js";

interface CandidateRow {
  id: string;
  first_name: string;
  last_name: string;
  phone_e164: string | null;
  dob_year: number | null;
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
  row_version: number;
  batch_id: string | null;
  batch_month: string | null;
  batch_technology: string | null;
  batch_location: string | null;
  visa_category: string | null;
  documents_status: string | null;
  gh_remote: boolean;
  gh_location_id: string | null;
  gh_location_name: string | null;
  team_assigned_at: Date;
  lead_name: string | null;
  in_person_ok: boolean | null;
  /** A resume link is recorded (the link itself is owner-only, profileExtras). */
  resume_link: boolean;
}

/** Guest house or remote (Hot List "stay"), from the two columns behind it. */
const stayOf = (r: { gh_remote: boolean; gh_location_name: string | null }) =>
  r.gh_remote ? "remote" : r.gh_location_name !== null ? "guest_house" : null;

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

/** "Java · Dallas · Nov 2026" from a batch's technology, location and start month (YYYY-MM-DD). */
export function batchLabel(technology: string, location: string, startMonth: string): string {
  const month = new Date(`${startMonth.slice(0, 7)}-01T00:00:00Z`)
    .toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
  return `${technology} · ${location} · ${month}`;
}

/**
 * Duplicate checks per user per minute (design N11). Counted per API task;
 * going over is logged as a warning (high-volume alert).
 */
export const DUPLICATE_CHECKS_PER_MINUTE = 20;

const BATCH_ERRORS: Record<string, () => HttpException> = {
  invalid_batch: () => new UnprocessableEntityException("invalid_batch"),
  batch_exists: () => new ConflictException("batch_exists"),
  batch_not_allowed: () => new UnprocessableEntityException("batch_not_allowed"),
  location_not_in_scope: () => new ForbiddenException("location_not_in_scope"),
  batch_not_found: () => new NotFoundException(),
  invalid_transition: () => new UnprocessableEntityException("invalid_transition"),
};

/** Profile write errors: batch codes (0026), an unknown guest house location (FK). */
function mapProfileError(err: unknown): never {
  const e = err as { code?: string; constraint?: string };
  if (e.code === "23503" && e.constraint === "candidate_gh_location_id_fkey") throw new UnprocessableEntityException("invalid_location");
  return mapBatchError(err);
}

/**
 * Audit summary of a profile update (rule 5): links and marketing locations
 * are free text, recorded as "changed" flags only; the rest are keys and ids.
 */
export function auditSafeProfile(body: ProfileUpdate): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body };
  for (const k of ["linkedinUrl", "resumeUrl", "marketingLocations", "marketingEmail", "vitelNumber"] as const) {
    if (k in out) out[k] = true;
  }
  return out;
}

/** Maps the batch functions' and trigger's coded errors (migration 0026) to problem details. */
const mapBatchError: (err: unknown) => never = dbErrorMapper(BATCH_ERRORS);

/** Create errors: batch codes, and a contact another candidate took meanwhile (0260). */
const mapCreateError: (err: unknown) => never = dbErrorMapper({
  ...BATCH_ERRORS,
  duplicate_email: () => new ConflictException("duplicate_contact"),
  duplicate_phone: () => new ConflictException("duplicate_contact"),
});


/**
 * Application-layer scope predicate (design B4.4). Parameterized; RLS applies
 * the same rule independently in the database.
 */
export function scopePredicate(scope: EffectiveScope, params: unknown[], alias = "c"): string {
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  if (scope.all || scope.hotlistOpen) {
    // hotlistOpen: every Hot List candidate (the caller filters by HOTLIST_STATUSES).
    return scope.all ? "true" : `${alias}.marketing_status = ANY(${p([...HOTLIST_STATUSES])}::text[])`;
  }
  const parts = [
    `${alias}.recruiter_id = ANY(${p([...scope.recruiterIds])}::uuid[])`,
    `${alias}.team_id = ANY(${p([...scope.teamIds])}::uuid[])`,
    `${alias}.location_id = ANY(${p([...scope.locationIds])}::uuid[])`,
  ];
  if (scope.allTeams) {
    parts.push(`(${alias}.visibility = 'all_teams' AND ${alias}.marketing_status = ANY(${p([...MARKETABLE_STATUSES])}::text[]))`);
    // "Selected teams" (0240): the set is already limited to marketable, selected_teams candidates.
    if (scope.sharedCandidateIds.size > 0) parts.push(`${alias}.id = ANY(${p([...scope.sharedCandidateIds])}::uuid[])`);
  }
  return `(${parts.join(" OR ")})`;
}

const toRef = (r: Pick<CandidateRow, "id" | "recruiter_id" | "team_id" | "location_id" | "visibility" | "marketing_status">): CandidateRef => ({
  id: r.id,
  recruiterId: r.recruiter_id,
  teamId: r.team_id,
  locationId: r.location_id,
  visibility: r.visibility,
  marketingStatus: r.marketing_status,
});

interface ProfileExtraRow {
  in_person_ok: boolean | null;
  marketing_email: string | null;
  vitel_number: string | null;
  linkedin_url: string | null;
  resume_url: string | null;
  marketing_locations: string[] | null;
  eligibility: string[] | null;
}

/**
 * Profile-only fields of GET /candidates/:id (FR-CAN-04..06), so what Edit
 * profile saves can be read back. `inPersonOk` goes to every profile reader.
 * The marketing contact details follow the phone rule (design B4.6):
 * `candidate.phone:read` over a candidate the caller owns, never through the
 * Open-to-all-teams rule; otherwise both keys are omitted.
 */
export function profileExtras(access: UserAccess, ref: CandidateRef, r: ProfileExtraRow) {
  const phoneScope = resolveScope(access, "candidate.phone:read");
  const contact = phoneScope !== null && ownsCandidate(phoneScope, ref);
  // LinkedIn and the resume link follow the uploaded-resume rule: owners of
  // the candidate (candidate:read through ownership, team, hierarchy, location
  // or org), never through Open to all teams.
  const readScope = resolveScope(access, "candidate:read");
  const owner = readScope !== null && ownsCandidate(readScope, ref);
  return {
    inPersonOk: r.in_person_ok,
    eligibility: r.eligibility ?? [],
    marketingLocations: r.marketing_locations ?? [],
    ...(contact ? { marketingEmail: r.marketing_email, vitelNumber: r.vitel_number } : {}),
    ...(owner ? { linkedinUrl: r.linkedin_url, resumeUrl: r.resume_url } : {}),
  };
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
export class CandidatesService implements OnModuleInit {
  private readonly log = new Logger(CandidatesService.name);
  private readonly hotlistLimiter = new RateLimiter(HOTLIST_PAGES_PER_MINUTE, 60_000);
  private readonly duplicateLimiter = new RateLimiter(DUPLICATE_CHECKS_PER_MINUTE, 60_000);
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

  private baseSelect = `
    SELECT c.id, p.first_name, p.last_name, p.phone_e164, p.dob_year, t.name AS technology,
           c.team_id, tm.name AS team_name, c.recruiter_id, u.display_name AS recruiter_name,
           c.location_id, l.name AS location_name, c.visibility, c.marketing_status, c.priority,
           c.marketing_start_date::text, c.technical_rating, c.row_version,
           c.batch_id, b.start_month::text AS batch_month, bt.name AS batch_technology, bl.name AS batch_location,
           c.visa_category, c.documents_status, c.gh_remote, c.gh_location_id, gl.name AS gh_location_name,
           c.team_assigned_at, (c.resume_url IS NOT NULL) AS resume_link,
           lu.display_name AS lead_name, c.in_person_ok
    FROM eureka.candidate c
    JOIN eureka.person p ON p.id = c.person_id
    JOIN eureka.technology t ON t.id = c.technology_id
    JOIN eureka.team tm ON tm.id = c.team_id
    JOIN eureka.location l ON l.id = c.location_id
    LEFT JOIN eureka.app_user u ON u.id = c.recruiter_id
    LEFT JOIN eureka.app_user lu ON lu.id = tm.lead_id
    LEFT JOIN eureka.batch b ON b.id = c.batch_id
    LEFT JOIN eureka.technology bt ON bt.id = b.technology_id
    LEFT JOIN eureka.location bl ON bl.id = b.location_id
    LEFT JOIN eureka.location gl ON gl.id = c.gh_location_id`;

  present(access: UserAccess, r: CandidateRow, hasResume?: boolean) {
    const ref = toRef(r);
    const fields = applyCandidateFieldPolicy(access, ref, {
      phone: r.phone_e164,
      dob: null, // DOB is encrypted; decrypted only for candidate.dob:read (Phase 3)
    });
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
      teamAssignedAt: r.team_assigned_at.toISOString(),
      inPersonOk: r.in_person_ok,
      recruiter: r.recruiter_id ? { id: r.recruiter_id, name: r.recruiter_name } : null,
      location: { id: r.location_id, name: r.location_name },
      ghLocation: r.gh_location_id && r.gh_location_name ? { id: r.gh_location_id, name: r.gh_location_name } : null,
      stay: stayOf(r),
      visaCategory: r.visa_category,
      documentsStatus: r.documents_status,
      ...(hasResume === undefined ? {} : { hasResume }),
      marketingStartDate: r.marketing_start_date,
      daysInMarket: days,
      technicalRating: r.technical_rating,
      phone: fields.phone,
      phoneMasked: fields.phoneMasked,
      dobMasked: r.dob_year ? `•• / •• / ${r.dob_year}` : null,
      rowVersion: r.row_version,
      batch: r.batch_id && r.batch_month
        ? { id: r.batch_id, label: batchLabel(r.batch_technology ?? "", r.batch_location ?? "", r.batch_month) }
        : null,
    };
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
      where.push(`(p.first_name || ' ' || p.last_name) ILIKE $${params.length}`);
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
    const sql = `${this.baseSelect} WHERE ${where.join(" AND ")} ORDER BY ${key ? `${key}, ` : ""}c.id LIMIT $${params.length}`;
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
        ...this.present(user.access, r, r.resume_link || withResume.has(r.id)),
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

  /** Read-before-write rule (design B3): 404 if not visible, 403 if visible but not permitted. */
  private async loadForWrite(c: pg.PoolClient, user: AuthedUser, id: string, perm: Permission): Promise<CandidateRow> {
    const readScope = resolveScope(user.access, "candidate:read");
    if (!readScope) throw new NotFoundException();
    const params: unknown[] = [id];
    const { rows } = await c.query<CandidateRow>(
      `${this.baseSelect} WHERE c.id = $1 AND ${scopePredicate(readScope, params)}`, params);
    const row = rows[0];
    if (!row) throw new NotFoundException();
    const scope = resolveScope(user.access, perm);
    if (!scope || !ownsCandidate(scope, toRef(row))) throw new ForbiddenException("Not permitted");
    return row;
  }

  async get(user: AuthedUser, id: string) {
    const scope = resolveScope(user.access, "candidate:read");
    if (!scope) throw new NotFoundException();
    const params: unknown[] = [id];
    const found = await this.db.withUser(user.id, async (c) => {
      const r = (await c.query<CandidateRow>(`${this.baseSelect} WHERE c.id = $1 AND ${scopePredicate(scope, params)}`, params)).rows[0];
      // Only a candidate in confirmation can have an open placement (PL-5).
      const open = r?.marketing_status === "confirmation"
        ? (await c.query<{ o: boolean }>(`SELECT authz.candidate_has_open_placement($1) AS o`, [id])).rows[0]!.o
        : false;
      // Profile-only fields (not on list rows), read under the same RLS.
      const extra = r ? (await c.query<ProfileExtraRow & { confirmations: number }>(
        `SELECT in_person_ok, marketing_email::text, vitel_number, linkedin_url, resume_url, marketing_locations, eligibility,
                -- Times the candidate reached confirmation (candidate_event, readable with the candidate).
                (SELECT count(*)::int FROM eureka.candidate_event e
                  WHERE e.candidate_id = candidate.id AND e.type = 'candidate.status_changed' AND e.to_value = 'confirmation') AS confirmations
         FROM eureka.candidate WHERE id = $1`, [id])).rows[0] : undefined;
      // Linked company names (authz.candidate_companies re-checks ownership or candidate.compliance:update).
      const companies = r ? (await c.query<{ link: CandidateCompanyLink; company_id: string; company_name: string }>(
        `SELECT * FROM authz.candidate_companies($1)`, [id])).rows : [];
      const uploaded = r ? (await c.query<{ ids: string[] }>(`SELECT authz.resume_flags(ARRAY[$1]::uuid[]) AS ids`, [id])).rows[0]!.ids : [];
      // "Selected teams" picks (0240), readable with the candidate.
      const sharedTeams = r?.visibility === "selected_teams" ? (await c.query<{ id: string; name: string }>(
        `SELECT t.id, t.name FROM eureka.candidate_team_share s JOIN eureka.team t ON t.id = s.team_id
          WHERE s.candidate_id = $1 ORDER BY t.name, t.id`, [id])).rows : [];
      return r && extra ? { row: r, open, extra, companies, sharedTeams, hasResume: r.resume_link || uploaded.length > 0 } : undefined;
    });
    if (!found) throw new NotFoundException();
    const ref = toRef(found.row);
    const readScope = resolveScope(user.access, "candidate:read");
    const complianceScope = resolveScope(user.access, "candidate.compliance:update");
    const canCompliance = complianceScope !== null && ownsCandidate(complianceScope, ref);
    const showCompanies = canCompliance || (readScope !== null && ownsCandidate(readScope, ref));
    const link = (k: CandidateCompanyLink) => {
      const x = found.companies.find((cmp) => cmp.link === k);
      return x ? { id: x.company_id, name: x.company_name } : null;
    };
    return {
      ...this.present(user.access, found.row, found.hasResume),
      ...profileExtras(user.access, ref, found.extra),
      confirmations: found.extra.confirmations,
      /** Owners and compliance editors only (E-Verify, offer letter and 1099 companies). */
      ...(showCompanies ? { companies: { everify: link("everify"), offerLetter: link("offerLetter"), form1099: link("form1099") } } : {}),
      canEditCompliance: canCompliance,
      /** Owners only: the teams a "Selected teams" candidate is shared with. */
      ...(readScope !== null && ownsCandidate(readScope, ref) ? { sharedTeams: found.sharedTeams } : {}),
      /** Hints for the UI (docs/placements-api.md); every write is checked again. */
      actions: candidateActions(user.access, toRef(found.row), found.open),
    };
  }

  async updateProfile(user: AuthedUser, id: string, body: ProfileUpdate) {
    return this.db.withUser(user.id, async (c) => {
      await this.loadForWrite(c, user, id, "candidate:update");
      const map: Record<string, string> = {
        priority: "priority", marketingEmail: "marketing_email", vitelNumber: "vitel_number",
        marketingStartDate: "marketing_start_date", inPersonOk: "in_person_ok", technologyId: "technology_id",
        batchId: "batch_id", marketingLocations: "marketing_locations", linkedinUrl: "linkedin_url",
        resumeUrl: "resume_url", eligibility: "eligibility", visaCategory: "visa_category",
      };
      const empty = (v: unknown) => (Array.isArray(v) && v.length === 0 ? null : v); // one spelling of "none"
      const entries: [string, unknown][] = Object.entries(body).filter(([k]) => k in map).map(([k, v]) => [map[k]!, empty(v)]);
      if (body.ghLocation !== undefined) {
        entries.push(["gh_location_id", body.ghLocation === "remote" ? null : body.ghLocation]);
        entries.push(["gh_remote", body.ghLocation === "remote"]);
      }
      if (entries.length) {
        const params: unknown[] = [id];
        const sets = entries.map(([col, v]) => { params.push(v); return `${col} = $${params.length}`; });
        await c.query(`UPDATE eureka.candidate SET ${sets.join(", ")} WHERE id = $1`, params).catch(mapProfileError);
        await this.audit.record(c, {
          actorId: user.id, action: "candidate.updated", entityType: "candidate", entityId: id, changes: auditSafeProfile(body),
        });
      }
      return { id };
    });
  }

  /**
   * Company links and documents status (candidate.compliance:update) through
   * authz.set_candidate_compliance, which re-checks scope and that a changed
   * link names an active company. Read-before-write: 404 if the candidate is
   * not readable, 403 if readable but not covered.
   */
  async setCompliance(user: AuthedUser, id: string, body: ComplianceUpdate) {
    return this.db.withUser(user.id, async (c) => {
      await this.loadForWrite(c, user, id, "candidate.compliance:update");
      const cur = (await c.query<{ e: string | null; o: string | null; f: string | null; d: string | null }>(
        `SELECT everify_company_id AS e, offer_letter_company_id AS o, form1099_company_id AS f, documents_status AS d
         FROM eureka.candidate WHERE id = $1`, [id])).rows[0]!;
      const next = {
        e: body.everifyCompanyId === undefined ? cur.e : body.everifyCompanyId,
        o: body.offerLetterCompanyId === undefined ? cur.o : body.offerLetterCompanyId,
        f: body.form1099CompanyId === undefined ? cur.f : body.form1099CompanyId,
        d: body.documentsStatus === undefined ? cur.d : body.documentsStatus,
      };
      let rowVersion: number;
      try {
        rowVersion = (await c.query<{ v: number }>(`SELECT authz.set_candidate_compliance($1, $2, $3, $4, $5) AS v`,
          [id, next.e, next.o, next.f, next.d])).rows[0]!.v;
      } catch (err) {
        if ((err as { message?: string }).message === "invalid_company") throw new UnprocessableEntityException("invalid_company");
        throw err;
      }
      // Ids and the status key only: no names or free text (rule 5).
      await this.audit.record(c, { actorId: user.id, action: "candidate.compliance", entityType: "candidate", entityId: id, changes: body });
      return {
        id, rowVersion,
        everifyCompanyId: next.e, offerLetterCompanyId: next.o, form1099CompanyId: next.f, documentsStatus: next.d,
      };
    });
  }

  /** Active companies for the compliance picker; empty for callers without candidate.compliance:update. */
  async complianceCompanies(user: AuthedUser) {
    if (!resolveScope(user.access, "candidate.compliance:update")) throw new ForbiddenException();
    const rows = await this.db.withUser(user.id, async (c) => (await c.query<{ id: string; name: string; location_name: string }>(
      `SELECT * FROM authz.compliance_company_options()`)).rows);
    return { items: rows.map((r) => ({ id: r.id, name: r.name, location: r.location_name })) };
  }

  /** Every team, with its lead, for the "Selected teams" picker; callers without candidate.visibility:update get 403. */
  async shareTeams(user: AuthedUser) {
    if (!resolveScope(user.access, "candidate.visibility:update")) throw new ForbiddenException();
    const rows = await this.db.withUser(user.id, async (c) => (await c.query<{ id: string; name: string; lead_name: string | null }>(
      `SELECT t.id, t.name, u.display_name AS lead_name
         FROM eureka.team t LEFT JOIN eureka.app_user u ON u.id = t.lead_id
        ORDER BY lower(t.name), t.id`)).rows);
    return { items: rows.map((r) => ({ id: r.id, name: r.name, lead: r.lead_name })) };
  }

  async setVisibility(user: AuthedUser, id: string, visibility: CandidateVisibility, teamIds: string[] = []) {
    return this.db.withUser(user.id, async (c) => {
      await this.loadForWrite(c, user, id, "candidate.visibility:update");
      try {
        // authz.set_candidate_visibility (0240) re-checks and replaces the "Selected teams" picks.
        await c.query(`SELECT authz.set_candidate_visibility($1, $2, $3::uuid[])`, [id, visibility, visibility === "selected_teams" ? teamIds : []]);
      } catch (err) {
        const m = (err as { message?: string }).message;
        if (m === "teams_required" || m === "invalid_team" || m === "too_many_teams") throw new UnprocessableEntityException(m);
        throw err;
      }
      // Ids only (rule 5).
      await this.audit.record(c, { actorId: user.id, action: "candidate.visibility", entityType: "candidate", entityId: id,
        changes: visibility === "selected_teams" ? { visibility, teamIds } : { visibility } });
      return { id, visibility, ...(visibility === "selected_teams" ? { teamIds } : {}) };
    });
  }

  async setRating(user: AuthedUser, id: string, rating: number) {
    return this.db.withUser(user.id, async (c) => {
      await this.loadForWrite(c, user, id, "candidate.rating:update");
      await c.query(`UPDATE eureka.candidate SET technical_rating = $2 WHERE id = $1`, [id, rating]);
      await this.audit.record(c, { actorId: user.id, action: "candidate.rating", entityType: "candidate", entityId: id, changes: { rating } });
      return { id, technicalRating: rating };
    });
  }

  async transition(user: AuthedUser, id: string, to: string) {
    return this.db.withUser(user.id, async (c) => {
      const row = await this.loadForWrite(c, user, id, "candidate:update");
      if (!candidateTransitionAllowed(row.marketing_status, to)) throw new UnprocessableEntityException("invalid_transition");
      let rows: { s: string }[];
      try {
        rows = (await c.query<{ s: string }>(`SELECT authz.transition_candidate($1, $2) AS s`, [id, to])).rows;
      } catch (err) {
        // The placement drives the candidate until it joins or backs out (migration 0022).
        if ((err as { message?: string }).message === "placement_open") throw new UnprocessableEntityException("placement_open");
        throw err;
      }
      await this.audit.record(c, { actorId: user.id, action: "candidate.transition", entityType: "candidate", entityId: id, changes: { from: row.marketing_status, to } });
      return { id, status: rows[0]!.s };
    });
  }

  /**
   * `then` runs in the same transaction after the candidate row exists (jobs-portal:
   * linking the hired application), so both commit or neither does.
   */
  async create(user: AuthedUser, body: CreateCandidate, then?: (c: pg.PoolClient, candidateId: string) => Promise<void>) {
    const team = body.teamId ?? user.access.teamIds[0];
    if (!team) throw new ForbiddenException("No team to assign");
    const scope = resolveScope(user.access, "candidate:create");
    const teamAllowed = scope && (scope.all || scope.teamIds.has(team)
      || (scope.recruiterIds.has(user.id) && user.access.teamIds[0] === team));
    if (!teamAllowed) throw new ForbiddenException("Not permitted to create candidates in this team");

    // Email and phone are each unique across candidates (CA-6). The check runs
    // in its own transaction so its audit row stays when the create is refused;
    // the 409 carries no details, the caller asks POST /candidates/duplicate-check
    // for the minimal info. authz.candidate_contact_unique (0260) is the
    // race-safe backstop.
    if (!body.email) throw new UnprocessableEntityException("email_required");
    if (!body.phone) throw new UnprocessableEntityException("phone_required");
    if ((await this.duplicates(user, body)).length > 0) throw new ConflictException("duplicate_contact");

    return this.db.withUser(user.id, async (c) => {
      const recruiter = body.recruiterId === undefined
        ? (hasTrait(user.access, "recruiter") ? user.id : null)
        : body.recruiterId;
      // The person row becomes visible only through its candidate, so its id is
      // generated here rather than read back with RETURNING (RLS would hide it).
      const personId = randomUUID();
      await c.query(`INSERT INTO eureka.person (id, first_name, last_name, phone_e164, personal_email) VALUES ($1,$2,$3,$4,$5)`,
        [personId, body.firstName, body.lastName, body.phone, body.email]);
      const cand = await c.query<{ id: string }>(
        `INSERT INTO eureka.candidate (person_id, technology_id, team_id, recruiter_id, location_id, batch_id)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [personId, body.technologyId, team, recruiter, body.locationId, body.batchId ?? null]).catch(mapCreateError);
      await this.audit.record(c, { actorId: user.id, action: "candidate.created", entityType: "candidate", entityId: cand.rows[0]!.id });
      if (then) await then(c, cand.rows[0]!.id);
      return { id: cand.rows[0]!.id };
    });
  }

  /**
   * Duplicate check (design B3, N11) through authz.candidate_duplicates: only
   * that a likely duplicate exists, which supplied identifier matched, the
   * owning team and its lead as the contact, and the candidate id when the
   * caller can read it. Rate-limited per user; every call is audited without
   * the values checked.
   */
  async duplicates(user: AuthedUser, body: DuplicateCheck) {
    if (!this.duplicateLimiter.take(user.id)) {
      this.log.warn(`Duplicate check rate limit exceeded by user ${user.id}`);
      throw new HttpException("Too many duplicate checks; try again in a minute", HttpStatus.TOO_MANY_REQUESTS);
    }
    return this.db.withUser(user.id, async (c) => {
      const { rows } = await c.query<{ candidate_id: string | null; team_name: string; contact_name: string | null; matched_on: string[] }>(
        `SELECT * FROM authz.candidate_duplicates($1, $2, $3, $4)`,
        [body.firstName, body.lastName, body.email ?? null, body.phone ?? null]);
      await this.audit.record(c, {
        actorId: user.id, action: "candidate.duplicate_check", entityType: "candidate",
        changes: { checked: [body.email !== undefined && "email", body.phone !== undefined && "phone"].filter(Boolean), matches: rows.length },
      });
      return rows.map((r) => ({
        candidateId: r.candidate_id,
        team: r.team_name,
        contact: r.contact_name,
        matchedOn: r.matched_on,
      }));
    });
  }

  /**
   * Timeline (FR-CAN-10). The candidate must be readable (404 otherwise).
   * Events about a submission, interview or placement are listed only when
   * that record is readable too; the query applies the engine's rule and RLS
   * (candidate_event_read, migration 0026) applies it again.
   */
  async timeline(user: AuthedUser, id: string, q: TimelineQuery) {
    const readScope = resolveScope(user.access, "candidate:read");
    if (!readScope) throw new NotFoundException();
    return this.db.withUser(user.id, async (c) => {
      const params: unknown[] = [id];
      const row = (await c.query<CandidateRow>(`${this.baseSelect} WHERE c.id = $1 AND ${scopePredicate(readScope, params)}`, params)).rows[0];
      if (!row) throw new NotFoundException();
      const ref = toRef(row);
      // A viewer who sees the candidate only through Open to all teams (another
      // team, D-02) gets no actor names and nothing from before the candidate
      // was last opened to all teams.
      const owner = ownsCandidate(readScope, ref);
      let since: string | null = null;
      if (!owner) {
        since = (await c.query<{ id: string | null }>(
          `SELECT max(id)::text AS id FROM eureka.candidate_event
           WHERE candidate_id = $1 AND type = 'candidate.visibility_changed' AND to_value IN ('all_teams', 'selected_teams')`, [id])).rows[0]?.id ?? null;
      }
      const ep: unknown[] = [id, q.cursor ?? null, q.limit + 1, since];
      const activity = (table: string, alias: string, perm: Permission) => {
        const s = resolveScope(user.access, perm);
        if (!s) return "false";
        if (s.all || ownsCandidate(s, ref)) return "true";
        const p = (v: unknown) => { ep.push(v); return `$${ep.length}`; };
        return `EXISTS (SELECT 1 FROM eureka.${table} ${alias} WHERE ${alias}.id = e.ref_id AND (
          ${alias}.recruiter_id = ANY(${p([...s.recruiterIds])}::uuid[])
          OR ${alias}.team_id = ANY(${p([...s.teamIds])}::uuid[])
          OR ${alias}.location_id = ANY(${p([...s.locationIds])}::uuid[])))`;
      };
      const visible = `CASE e.ref_type
        WHEN 'submission' THEN ${activity("submission", "s", "submission:read")}
        WHEN 'interview' THEN ${activity("interview", "i", "interview:read")}
        WHEN 'placement' THEN ${activity("placement", "pl", "placement:read")}
        ELSE true END`;
      const { rows } = await c.query<{
        id: string; type: string; at: Date; actor_id: string | null; actor_name: string | null;
        ref_type: string | null; ref_id: string | null; from_value: string | null; to_value: string | null;
        team_name: string | null; batch_month: string | null; batch_technology: string | null; batch_location: string | null;
      }>(
        `SELECT e.id::text, e.type, e.at, e.actor_id, u.display_name AS actor_name, e.ref_type, e.ref_id,
                e.from_value, e.to_value, tm.name AS team_name,
                b.start_month::text AS batch_month, bt.name AS batch_technology, bl.name AS batch_location
         FROM eureka.candidate_event e
         LEFT JOIN eureka.app_user u ON u.id = e.actor_id
         LEFT JOIN eureka.team tm ON e.ref_type = 'team' AND tm.id = e.ref_id
         LEFT JOIN eureka.batch b ON e.ref_type = 'batch' AND b.id = e.ref_id
         LEFT JOIN eureka.technology bt ON bt.id = b.technology_id
         LEFT JOIN eureka.location bl ON bl.id = b.location_id
         WHERE e.candidate_id = $1 AND ($2::bigint IS NULL OR e.id < $2::bigint)
           AND ($4::bigint IS NULL OR e.id >= $4::bigint) AND ${visible}
         ORDER BY e.id DESC LIMIT $3`, ep);
      const page = rows.slice(0, q.limit);
      return {
        items: page.map((e) => ({
          id: e.id,
          type: e.type,
          at: e.at.toISOString(),
          actor: owner && e.actor_id ? { id: e.actor_id, name: e.actor_name } : null,
          ref: e.ref_type ? {
            type: e.ref_type,
            id: e.ref_id,
            label: e.ref_type === "team" ? e.team_name
              : e.ref_type === "batch" && e.batch_month ? batchLabel(e.batch_technology ?? "", e.batch_location ?? "", e.batch_month)
              : null,
          } : null,
          from: e.from_value,
          to: e.to_value,
        })),
        nextCursor: rows.length > q.limit ? page[page.length - 1]!.id : null,
      };
    });
  }

  /** Batches (FR-CAN-02), readable by every candidate:read holder; `canCreate` is a UI hint. */
  async batches(user: AuthedUser, q: BatchListQuery) {
    const params: unknown[] = [];
    const where: string[] = ["true"];
    if (q.locationId) { params.push(q.locationId); where.push(`b.location_id = $${params.length}`); }
    if (q.technologyId) { params.push(q.technologyId); where.push(`b.technology_id = $${params.length}`); }
    if (q.status) { params.push(q.status); where.push(`b.status = $${params.length}`); }
    const rows = await this.db.withUser(user.id, async (c) => (await c.query<{
      id: string; start_month: string; size_planned: number | null; status: string;
      location_id: string; location_name: string; technology_id: string; technology_name: string; candidates: number;
    }>(
      `SELECT b.id, b.start_month::text, b.size_planned, b.status,
              b.location_id, l.name AS location_name, b.technology_id, t.name AS technology_name,
              (SELECT count(*)::int FROM eureka.candidate c WHERE c.batch_id = b.id) AS candidates
       FROM eureka.batch b
       JOIN eureka.location l ON l.id = b.location_id
       JOIN eureka.technology t ON t.id = b.technology_id
       WHERE ${where.join(" AND ")}
       ORDER BY b.start_month DESC, l.name, t.name, b.id
       LIMIT 200`, params)).rows);
    return {
      items: rows.map((b) => ({
        id: b.id,
        label: batchLabel(b.technology_name, b.location_name, b.start_month),
        location: { id: b.location_id, name: b.location_name },
        technology: { id: b.technology_id, name: b.technology_name },
        startMonth: b.start_month.slice(0, 7),
        sizePlanned: b.size_planned,
        status: b.status,
        /** Candidates in this batch that the caller can read. */
        candidatesInScope: b.candidates,
      })),
      canCreate: canCreateBatch(user.access),
    };
  }

  /** The body is parsed only after the permission check, so callers without it always get 403. */
  async createBatch(user: AuthedUser, parse: () => CreateBatch) {
    if (!canCreateBatch(user.access)) throw new ForbiddenException("Not permitted");
    const body = parse();
    return this.db.withUser(user.id, async (c) => {
      const { rows } = await c.query<{ id: string }>(`SELECT authz.create_batch($1, $2, $3::date, $4) AS id`,
        [body.locationId, body.technologyId, `${body.startMonth}-01`, body.sizePlanned ?? null]).catch(mapBatchError);
      const id = rows[0]!.id;
      await this.audit.record(c, { actorId: user.id, action: "batch.created", entityType: "batch", entityId: id, changes: { ...body } });
      return { id };
    });
  }

  /**
   * Batch status (planned -> in_training -> completed; cancel before completion)
   * through authz.set_batch_status: same permission as create, batch location
   * in the caller's scope. Read-before-write: 404 if not visible, then 403.
   */
  async setBatchStatus(user: AuthedUser, id: string, to: BatchStatus) {
    return this.db.withUser(user.id, async (c) => {
      const b = (await c.query<{ status: string }>(`SELECT status FROM eureka.batch WHERE id = $1`, [id])).rows[0];
      if (!b) throw new NotFoundException();
      if (!canCreateBatch(user.access)) throw new ForbiddenException("Not permitted");
      await c.query(`SELECT authz.set_batch_status($1, $2)`, [id, to]).catch(mapBatchError);
      await this.audit.record(c, { actorId: user.id, action: "batch.status", entityType: "batch", entityId: id, changes: { from: b.status, to } });
      return { id, status: to };
    });
  }
}
