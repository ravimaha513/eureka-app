import { randomUUID } from "node:crypto";
import { ForbiddenException, HttpException, HttpStatus, Injectable, Logger, NotFoundException, type OnModuleInit } from "@nestjs/common";
import type pg from "pg";
import {
  HOTLIST_STATUSES,
  HOTLIST_VISIBILITY,
  MARKETABLE_STATUSES,
  applyCandidateFieldPolicy,
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
import type { CandidateListQuery, CreateCandidate, ProfileUpdate } from "./candidates.schemas.js";

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

/** Hot List pages per user per minute (anti-scraping; design A-threats "mass export"). */
export const HOTLIST_PAGES_PER_MINUTE = 60;

@Injectable()
export class CandidatesService implements OnModuleInit {
  private readonly log = new Logger(CandidatesService.name);
  private readonly hotlistLimiter = new RateLimiter(HOTLIST_PAGES_PER_MINUTE, 60_000);

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
           c.marketing_start_date::text, c.technical_rating, c.row_version
    FROM eureka.candidate c
    JOIN eureka.person p ON p.id = c.person_id
    JOIN eureka.technology t ON t.id = c.technology_id
    JOIN eureka.team tm ON tm.id = c.team_id
    JOIN eureka.location l ON l.id = c.location_id
    LEFT JOIN eureka.app_user u ON u.id = c.recruiter_id`;

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
    };
  }

  async list(user: AuthedUser, perm: "candidate:read" | "hotlist:read", q: CandidateListQuery) {
    const scope = resolveScope(user.access, perm);
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
        changes: { filters: { status: q.status, technology: q.technology, visibility: q.visibility, search: q.search ? true : undefined }, rows: Math.min(r.length, q.limit) },
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
    const row = await this.db.withUser(user.id, async (c) =>
      (await c.query<CandidateRow>(`${this.baseSelect} WHERE c.id = $1 AND ${scopePredicate(scope, params)}`, params)).rows[0]);
    if (!row) throw new NotFoundException();
    return this.present(user.access, row);
  }

  async updateProfile(user: AuthedUser, id: string, body: ProfileUpdate) {
    return this.db.withUser(user.id, async (c) => {
      await this.loadForWrite(c, user, id, "candidate:update");
      const map: Record<string, string> = {
        priority: "priority", marketingEmail: "marketing_email", vitelNumber: "vitel_number",
        marketingStartDate: "marketing_start_date", inPersonOk: "in_person_ok", technologyId: "technology_id",
      };
      const entries = Object.entries(body).filter(([k]) => k in map);
      if (entries.length) {
        const params: unknown[] = [id];
        const sets = entries.map(([k, v]) => { params.push(v); return `${map[k]} = $${params.length}`; });
        await c.query(`UPDATE eureka.candidate SET ${sets.join(", ")} WHERE id = $1`, params);
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
      await this.loadForWrite(c, user, id, "candidate:update");
      const { rows } = await c.query<{ s: string }>(`SELECT authz.transition_candidate($1, $2) AS s`, [id, to]);
      await this.audit.record(c, { actorId: user.id, action: "candidate.transition", entityType: "candidate", entityId: id, changes: { to } });
      return { id, status: rows[0]!.s };
    });
  }

  async create(user: AuthedUser, body: CreateCandidate) {
    return this.db.withUser(user.id, async (c) => {
      const team = body.teamId ?? user.access.teamIds[0];
      if (!team) throw new ForbiddenException("No team to assign");
      const scope = resolveScope(user.access, "candidate:create");
      const teamAllowed = scope && (scope.all || scope.teamIds.has(team)
        || (scope.recruiterIds.has(user.id) && user.access.teamIds[0] === team));
      if (!teamAllowed) throw new ForbiddenException("Not permitted to create candidates in this team");
      const recruiter = body.recruiterId === undefined
        ? (user.access.roles.some((r) => r.role === "recruiter") ? user.id : null)
        : body.recruiterId;
      // The person row becomes visible only through its candidate, so its id is
      // generated here rather than read back with RETURNING (RLS would hide it).
      const personId = randomUUID();
      await c.query(`INSERT INTO eureka.person (id, first_name, last_name, phone_e164) VALUES ($1,$2,$3,$4)`,
        [personId, body.firstName, body.lastName, body.phone ?? null]);
      const cand = await c.query<{ id: string }>(
        `INSERT INTO eureka.candidate (person_id, technology_id, team_id, recruiter_id, location_id)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [personId, body.technologyId, team, recruiter, body.locationId]);
      await this.audit.record(c, { actorId: user.id, action: "candidate.created", entityType: "candidate", entityId: cand.rows[0]!.id });
      return { id: cand.rows[0]!.id };
    });
  }
}
