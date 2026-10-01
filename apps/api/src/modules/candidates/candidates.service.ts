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
  candidateActions,
  candidateTransitionAllowed,
  ownsCandidate,
  resolveScope,
  type CandidateRef,
  type EffectiveScope,
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
  CreateBatch,
  CreateCandidate,
  ProfileUpdate,
  TimelineQuery,
} from "./candidates.schemas.js";

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
  visibility: "team" | "all_teams";
  marketing_status: string;
  priority: string;
  marketing_start_date: string | null;
  technical_rating: number | null;
  row_version: number;
  batch_id: string | null;
  batch_month: string | null;
  batch_technology: string | null;
  batch_location: string | null;
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

/** Maps the batch functions' and trigger's coded errors (migration 0026) to problem details. */
function mapBatchError(err: unknown): never {
  const e = err as { message?: string; code?: string };
  const make = e.message !== undefined && e.code !== undefined ? BATCH_ERRORS[e.message] : undefined;
  if (make) throw make();
  throw err;
}


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
  }
  return `(${parts.join(" OR ")})`;
}

const toRef = (r: Pick<CandidateRow, "recruiter_id" | "team_id" | "location_id" | "visibility" | "marketing_status">): CandidateRef => ({
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
  return {
    inPersonOk: r.in_person_ok,
    ...(contact ? { marketingEmail: r.marketing_email, vitelNumber: r.vitel_number } : {}),
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
  visibility: "team" | "all_teams";
  marketing_status: string;
  priority: string;
  marketing_start_date: string | null;
  technical_rating: number | null;
  phone: string | null;
  phone_masked: boolean;
  readable: boolean;
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
           c.batch_id, b.start_month::text AS batch_month, bt.name AS batch_technology, bl.name AS batch_location
    FROM eureka.candidate c
    JOIN eureka.person p ON p.id = c.person_id
    JOIN eureka.technology t ON t.id = c.technology_id
    JOIN eureka.team tm ON tm.id = c.team_id
    JOIN eureka.location l ON l.id = c.location_id
    LEFT JOIN eureka.app_user u ON u.id = c.recruiter_id
    LEFT JOIN eureka.batch b ON b.id = c.batch_id
    LEFT JOIN eureka.technology bt ON bt.id = b.technology_id
    LEFT JOIN eureka.location bl ON bl.id = b.location_id`;

  present(access: UserAccess, r: CandidateRow) {
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
      visibility: r.visibility,
      priority: r.priority,
      team: { id: r.team_id, name: r.team_name },
      recruiter: r.recruiter_id ? { id: r.recruiter_id, name: r.recruiter_name } : null,
      location: { id: r.location_id, name: r.location_name },
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
    if (q.search) {
      params.push(`%${q.search.replace(/[%_\\]/g, "\\$&")}%`);
      where.push(`(p.first_name || ' ' || p.last_name) ILIKE $${params.length}`);
    }
    if (q.cursor) { params.push(q.cursor); where.push(`c.id > $${params.length}`); }
    params.push(q.limit + 1);
    const sql = `${this.baseSelect} WHERE ${where.join(" AND ")} ORDER BY c.id LIMIT $${params.length}`;
    const rows = await this.db.withUser(user.id, async (c) => (await c.query<CandidateRow>(sql, params)).rows);
    const page = rows.slice(0, q.limit);
    return {
      items: page.map((r) => this.present(user.access, r)),
      nextCursor: rows.length > q.limit ? page[page.length - 1]!.id : null,
    };
  }

  /**
   * Open Hot List (OD-01): served by authz.hotlist_page, which returns only list
   * columns with phones masked in SQL, so base-table RLS stays scoped. Every page
   * read is audited.
   */
  private async openHotlist(user: AuthedUser, q: CandidateListQuery) {
    const search = q.search ? `%${q.search.replace(/[%_\\]/g, "\\$&")}%` : null;
    const rows = await this.db.withUser(user.id, async (c) => {
      const r = (await c.query<HotlistRow>(
        `SELECT * FROM authz.hotlist_page($1, $2, $3, $4, $5, $6)`,
        [q.status ?? null, q.technology ?? null, q.visibility ?? null, search, q.cursor ?? null, q.limit + 1],
      )).rows;
      await this.audit.record(c, {
        actorId: user.id, action: "hotlist.read", entityType: "candidate",
        changes: { filters: { status: q.status, technology: q.technology, visibility: q.visibility, search: q.search ? true : undefined }, rows: Math.min(r.length, q.limit),
          firstId: r[0]?.id ?? null, lastId: r[Math.min(r.length, q.limit) - 1]?.id ?? null },
      });
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
          visibility: r.visibility,
          priority: r.priority,
          team: { id: r.team_id, name: r.team_name },
          recruiter: r.recruiter_id ? { id: r.recruiter_id, name: r.recruiter_name } : null,
          location: { id: r.location_id, name: r.location_name },
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
      const extra = r ? (await c.query<ProfileExtraRow>(
        `SELECT in_person_ok, marketing_email::text, vitel_number FROM eureka.candidate WHERE id = $1`, [id])).rows[0] : undefined;
      return r && extra ? { row: r, open, extra } : undefined;
    });
    if (!found) throw new NotFoundException();
    return {
      ...this.present(user.access, found.row),
      ...profileExtras(user.access, toRef(found.row), found.extra),
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
        batchId: "batch_id",
      };
      const entries = Object.entries(body).filter(([k]) => k in map);
      if (entries.length) {
        const params: unknown[] = [id];
        const sets = entries.map(([k, v]) => { params.push(v); return `${map[k]} = $${params.length}`; });
        await c.query(`UPDATE eureka.candidate SET ${sets.join(", ")} WHERE id = $1`, params).catch(mapBatchError);
        await this.audit.record(c, { actorId: user.id, action: "candidate.updated", entityType: "candidate", entityId: id, changes: body });
      }
      return { id };
    });
  }

  async setVisibility(user: AuthedUser, id: string, visibility: "team" | "all_teams") {
    return this.db.withUser(user.id, async (c) => {
      await this.loadForWrite(c, user, id, "candidate.visibility:update");
      await c.query(`UPDATE eureka.candidate SET visibility = $2 WHERE id = $1`, [id, visibility]);
      await this.audit.record(c, { actorId: user.id, action: "candidate.visibility", entityType: "candidate", entityId: id, changes: { visibility } });
      return { id, visibility };
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

  async create(user: AuthedUser, body: CreateCandidate) {
    const team = body.teamId ?? user.access.teamIds[0];
    if (!team) throw new ForbiddenException("No team to assign");
    const scope = resolveScope(user.access, "candidate:create");
    const teamAllowed = scope && (scope.all || scope.teamIds.has(team)
      || (scope.recruiterIds.has(user.id) && user.access.teamIds[0] === team));
    if (!teamAllowed) throw new ForbiddenException("Not permitted to create candidates in this team");

    // Duplicate check first (FR-CAN-09), in its own transaction so its audit
    // row stays even when the create is refused. The 409 carries no details;
    // the caller asks POST /candidates/duplicate-check for the minimal info.
    let duplicates = 0;
    if (body.email !== undefined || body.phone !== undefined) {
      duplicates = (await this.duplicates(user, body)).length;
      if (duplicates > 0 && body.confirmDuplicate !== true) throw new ConflictException("possible_duplicate");
    }

    return this.db.withUser(user.id, async (c) => {
      const recruiter = body.recruiterId === undefined
        ? (user.access.roles.some((r) => r.role === "recruiter") ? user.id : null)
        : body.recruiterId;
      // The person row becomes visible only through its candidate, so its id is
      // generated here rather than read back with RETURNING (RLS would hide it).
      const personId = randomUUID();
      await c.query(`INSERT INTO eureka.person (id, first_name, last_name, phone_e164, personal_email) VALUES ($1,$2,$3,$4,$5)`,
        [personId, body.firstName, body.lastName, body.phone ?? null, body.email ?? null]);
      const cand = await c.query<{ id: string }>(
        `INSERT INTO eureka.candidate (person_id, technology_id, team_id, recruiter_id, location_id, batch_id)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [personId, body.technologyId, team, recruiter, body.locationId, body.batchId ?? null]).catch(mapBatchError);
      await this.audit.record(c, {
        actorId: user.id, action: "candidate.created", entityType: "candidate", entityId: cand.rows[0]!.id,
        ...(duplicates > 0 ? { changes: { duplicateConfirmed: true } } : {}),
      });
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
  async duplicates(user: AuthedUser, body: Pick<CreateCandidate, "firstName" | "lastName" | "email" | "phone">) {
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
           WHERE candidate_id = $1 AND type = 'candidate.visibility_changed' AND to_value = 'all_teams'`, [id])).rows[0]?.id ?? null;
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
