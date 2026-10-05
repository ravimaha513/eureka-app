import { createHash } from "node:crypto";
import {
  BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus, Injectable, NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import type pg from "pg";
import {
  can, creatableJobKinds, jobAllowed, resolveScope, type JobKind, type JobRef, type RichDoc, type UserAccess,
} from "@eureka/shared";
import { AuditService } from "../../platform/audit.service.js";
import type { AuthedUser } from "../../platform/auth.guard.js";
import { DbService } from "../../platform/db.service.js";
import { IdempotencyKey } from "../placements/placements.schemas.js";
import { fromMicros, splitCursor, toMicros } from "../submissions/pipeline.js";
import type { CreateJob, JobListQuery, UpdateJob } from "./jobs.schemas.js";

/**
 * Jobs (docs/jobs-portal-api.md JP-1..JP-9, migration 0060). Reads run under
 * the caller's RLS (job_read); writes are read-before-write (404 when not
 * readable, 403 when readable but not manageable) and the database checks the
 * same rule again in the job_insert / job_update policies.
 */

export interface JobRow {
  id: string;
  kind: JobKind;
  title: string;
  category: string;
  experience_level: string;
  employment_type: string;
  work_mode: string;
  status: string;
  deadline: string | null;
  work_hours: number | null;
  pay_amount: string | null;
  pay_frequency: string | null;
  pay_currency: string | null;
  client_id: string | null;
  client_name: string | null;
  company_id: string | null;
  location: string | null;
  skills: string[];
  requirements: RichDoc | null;
  description: RichDoc | null;
  hiring_manager_id: string | null;
  hiring_manager_name: string | null;
  published_to_portal: boolean;
  owner_id: string;
  owner_name: string | null;
  team_id: string | null;
  team_name: string | null;
  row_version: number;
  created_at: Date;
  updated_at: Date;
  posted_at: Date | null;
  applicants: number;
  k: string;
}

/**
 * The job columns plus display names and an "applicants" count: submissions
 * that name a client requirement, applications to an internal opening, both
 * counted under the caller's RLS (only what the caller may see).
 */
export const JOB_SELECT = `
  SELECT j.id, j.kind, j.title, j.category, j.experience_level, j.employment_type, j.work_mode, j.status,
         j.deadline::text, j.work_hours, j.pay_amount::text, j.pay_frequency, j.pay_currency,
         j.client_id, cl.name AS client_name, j.company_id, j.location, j.skills, j.requirements, j.description,
         j.hiring_manager_id, hm.display_name AS hiring_manager_name, j.published_to_portal,
         j.owner_id, ow.display_name AS owner_name, j.team_id, tm.name AS team_name,
         j.row_version, j.created_at, j.updated_at, j.posted_at, ${toMicros("j.created_at")} AS k,
         CASE WHEN j.kind = 'client_requirement'
              THEN (SELECT count(*) FROM eureka.submission s WHERE s.job_id = j.id)
              ELSE (SELECT count(*) FROM eureka.job_application a WHERE a.job_id = j.id) END::int AS applicants
  FROM eureka.job j
  LEFT JOIN eureka.client cl ON cl.id = j.client_id
  LEFT JOIN eureka.app_user hm ON hm.id = j.hiring_manager_id
  LEFT JOIN eureka.app_user ow ON ow.id = j.owner_id
  LEFT JOIN eureka.team tm ON tm.id = j.team_id`;


/**
 * Display names of the companies of the given jobs (id -> name), through the
 * definer batch function of migration 0062 (one call per page): it returns
 * only the name, only for jobs the caller may read, and nothing else of the
 * company. `portal` selects the applicant's variant (eureka_portal).
 */
export async function companyNames(c: pg.PoolClient, jobIds: (string | null)[], portal = false): Promise<Map<string, string>> {
  const ids = [...new Set(jobIds.filter((x): x is string => x !== null))];
  const out = new Map<string, string>();
  if (!ids.length) return out;
  const fn = portal ? "authz.portal_job_company_names" : "authz.job_company_names";
  const r = await c.query<{ job_id: string; name: string }>(`SELECT job_id, name FROM ${fn}($1::uuid[])`, [ids]);
  for (const x of r.rows) out.set(x.job_id, x.name);
  return out;
}

export const jobRef = (r: Pick<JobRow, "kind" | "owner_id" | "team_id" | "hiring_manager_id">): JobRef => ({
  kind: r.kind, ownerId: r.owner_id, teamId: r.team_id, hiringManagerId: r.hiring_manager_id,
});

/**
 * Pay of a client requirement is a rate (design B4.6): shown to callers who
 * manage the job or hold rate:read over its owner or team. Internal openings
 * show pay to every reader.
 */
function payVisible(access: UserAccess, r: JobRow): boolean {
  if (r.kind === "internal_opening") return true;
  if (jobAllowed(access, "job:manage", jobRef(r))) return true;
  const s = resolveScope(access, "rate:read");
  return s !== null && (s.all || s.recruiterIds.has(r.owner_id) || (r.team_id !== null && s.teamIds.has(r.team_id)));
}

const ENDPOINT = "POST /api/v1/jobs";

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

const CODES: Record<string, () => HttpException> = {
  invalid_skill: () => new UnprocessableEntityException("invalid_skill"),
  invalid_hiring_manager: () => new UnprocessableEntityException("invalid_hiring_manager"),
  server_managed_field: () => new UnprocessableEntityException("server_managed_field"),
};

/** Maps the job guard's coded errors and constraint violations (migration 0060) to problem details. */
export function mapJobError(err: unknown): never {
  const e = err as { message?: string; code?: string; constraint?: string };
  const make = e.message !== undefined && e.code !== undefined ? CODES[e.message] : undefined;
  if (make) throw make();
  if (e.code === "23503" && e.constraint === "job_client_id_fkey") throw new UnprocessableEntityException("invalid_client");
  if (e.code === "23503" && e.constraint === "job_company_id_fkey") throw new UnprocessableEntityException("invalid_company");
  if (e.code === "23503" && e.constraint === "job_hiring_manager_id_fkey") throw new UnprocessableEntityException("invalid_hiring_manager");
  if (e.code === "23514" && e.constraint === "job_kind_ref") throw new UnprocessableEntityException("invalid_job_reference");
  if (e.code === "23514" && e.constraint === "job_portal") throw new UnprocessableEntityException("portal_internal_only");
  throw err;
}

@Injectable()
export class JobsService {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  present(access: UserAccess, r: JobRow, companies?: ReadonlyMap<string, string>) {
    const pay = r.pay_amount !== null && payVisible(access, r)
      ? { amount: Number(r.pay_amount), frequency: r.pay_frequency, currency: r.pay_currency } : null;
    return {
      id: r.id,
      kind: r.kind,
      title: r.title,
      category: r.category,
      experienceLevel: r.experience_level,
      employmentType: r.employment_type,
      workMode: r.work_mode,
      status: r.status,
      deadline: r.deadline,
      workHours: r.work_hours,
      pay,
      payHidden: r.pay_amount !== null && pay === null,
      client: r.client_id ? { id: r.client_id, name: r.client_name } : null,
      company: r.company_id ? { id: r.company_id, name: companies?.get(r.id) ?? null } : null,
      location: r.location,
      skills: r.skills,
      requirements: r.requirements,
      description: r.description,
      hiringManager: r.hiring_manager_id ? { id: r.hiring_manager_id, name: r.hiring_manager_name } : null,
      publishedToPortal: r.published_to_portal,
      owner: { id: r.owner_id, name: r.owner_name },
      team: r.team_id ? { id: r.team_id, name: r.team_name } : null,
      applicants: r.applicants,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      postedAt: r.posted_at,
      rowVersion: r.row_version,
      actions: { edit: jobAllowed(access, "job:manage", jobRef(r)) },
    };
  }

  async list(user: AuthedUser, q: JobListQuery) {
    const params: unknown[] = [];
    const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
    const where: string[] = ["true"];
    if (q.kind) where.push(`j.kind = ${p(q.kind)}`);
    if (q.status) where.push(`j.status = ${p(q.status)}`);
    if (q.clientId) where.push(`j.client_id = ${p(q.clientId)}::uuid`);
    if (q.mine) where.push(`j.hiring_manager_id = ${p(user.id)}::uuid`);
    if (q.search) where.push(`j.title ILIKE ${p(`%${q.search.replace(/[%_\\]/g, "\\$&")}%`)} ESCAPE '\\'`);
    if (q.cursor) {
      const [t, id] = splitCursor(q.cursor);
      where.push(`(j.created_at, j.id) < (${fromMicros(p(t))}, ${p(id)}::uuid)`);
    }
    const sql = `${JOB_SELECT} WHERE ${where.join(" AND ")} ORDER BY j.created_at DESC, j.id DESC LIMIT ${p(q.limit + 1)}`;
    const { rows, names } = await this.db.withUser(user.id, async (c) => {
      const rs = (await c.query<JobRow>(sql, params)).rows;
      return { rows: rs, names: await companyNames(c, rs.slice(0, q.limit).map((r) => r.company_id ? r.id : null)) };
    });
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => this.present(user.access, r, names)),
      nextCursor: rows.length > q.limit && last ? `${last.k}.${last.id}` : null,
    };
  }

  async load(c: pg.PoolClient, id: string): Promise<JobRow | undefined> {
    return (await c.query<JobRow>(`${JOB_SELECT} WHERE j.id = $1`, [id])).rows[0];
  }

  async get(user: AuthedUser, id: string) {
    return this.db.withUser(user.id, async (c) => {
      const r = await this.load(c, id);
      if (!r) throw new NotFoundException();
      return this.present(user.access, r, await companyNames(c, [r.company_id ? r.id : null]));
    });
  }

  /**
   * Company picker for internal openings (id and name only, active companies):
   * callers who may create internal openings (HR) get every company, through
   * authz.company_options(); eureka.company itself stays scoped to company:read.
   */
  async companyOptions(user: AuthedUser) {
    if (!creatableJobKinds(user.access).includes("internal_opening")) throw new ForbiddenException("Not permitted");
    return this.db.withUser(user.id, async (c) => ({
      companies: (await c.query<{ id: string; name: string }>(`SELECT id, name FROM authz.company_options()`)).rows,
    }));
  }

  /** Pickers for the job form: kinds the caller may create, clients (client requirements), staff (hiring manager). */
  async options(user: AuthedUser) {
    const kinds = creatableJobKinds(user.access);
    return this.db.withUser(user.id, async (c) => ({
      kinds,
      clients: kinds.includes("client_requirement")
        ? (await c.query(`SELECT id, name FROM eureka.client ORDER BY name, id`)).rows : [],
      staff: (await c.query(`SELECT id, display_name AS name FROM eureka.app_user WHERE status = 'active' ORDER BY display_name, id`)).rows,
    }));
  }

  private checkKind(user: AuthedUser, kind: JobKind) {
    if (!creatableJobKinds(user.access).includes(kind)) throw new ForbiddenException("Not permitted to create this kind of job");
  }

  async create(user: AuthedUser, body: CreateJob, idempotencyKey: string | undefined) {
    this.checkKind(user, body.kind);
    let key: string | null = null;
    if (idempotencyKey !== undefined) {
      const k = IdempotencyKey.safeParse(idempotencyKey);
      if (!k.success) throw new BadRequestException("invalid_idempotency_key");
      key = k.data;
    }
    const hash = createHash("sha256").update(canonical(body)).digest("hex");
    return this.db.withUser(user.id, async (c) => {
      if (key !== null) {
        const claimed = await c.query(
          `INSERT INTO eureka.idempotency_key (key, user_id, endpoint, request_hash) VALUES ($1,$2,$3,$4)
           ON CONFLICT DO NOTHING RETURNING key`, [key, user.id, ENDPOINT, hash]);
        if (claimed.rowCount === 0) {
          const prior = (await c.query<{ request_hash: string; response: unknown }>(
            `SELECT request_hash, response FROM eureka.idempotency_key WHERE user_id = $1 AND endpoint = $2 AND key = $3`,
            [user.id, ENDPOINT, key])).rows[0];
          if (!prior || prior.request_hash !== hash || prior.response === null) throw new ConflictException("idempotency_key_reused");
          return prior.response as { id: string; rowVersion: number };
        }
      }
      const id = await this.insert(c, body);
      const result = { id, rowVersion: 1 };
      if (key !== null) {
        await c.query(`UPDATE eureka.idempotency_key SET response = $4 WHERE user_id = $1 AND endpoint = $2 AND key = $3`,
          [user.id, ENDPOINT, key, result]);
      }
      // Ids and codes only (rule 5): no titles, pay or free text.
      await this.audit.record(c, {
        actorId: user.id, action: "job.created", entityType: "job", entityId: id,
        changes: { kind: body.kind, status: body.status, clientId: body.clientId ?? null, companyId: body.companyId ?? null,
          hiringManagerId: body.hiringManagerId ?? null, publishedToPortal: body.publishedToPortal },
      });
      return result;
    });
  }

  private async insert(c: pg.PoolClient, b: CreateJob): Promise<string> {
    try {
      const r = await c.query<{ id: string }>(
        `INSERT INTO eureka.job (kind, title, category, experience_level, employment_type, work_mode, status, deadline,
           work_hours, pay_amount, pay_frequency, pay_currency, client_id, company_id, location, skills, requirements,
           description, hiring_manager_id, published_to_portal)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18::jsonb,$19,$20) RETURNING id`,
        [b.kind, b.title, b.category, b.experienceLevel, b.employmentType, b.workMode, b.status, b.deadline ?? null,
          b.workHours ?? null, b.pay?.amount ?? null, b.pay?.frequency ?? null, b.pay?.currency ?? null,
          b.clientId ?? null, b.companyId ?? null, b.location ?? null, b.skills,
          b.requirements ? JSON.stringify(b.requirements) : null, b.description ? JSON.stringify(b.description) : null,
          b.hiringManagerId ?? null, b.publishedToPortal]);
      return r.rows[0]!.id;
    } catch (err) {
      mapJobError(err);
    }
  }

  /** PATCH with optimistic concurrency (If-Match: the rowVersion the client saw; 428 without it, 412 when stale). */
  async update(user: AuthedUser, id: string, expected: number | null, parse: () => UpdateJob) {
    if (expected === null) throw new HttpException("if_match_required", HttpStatus.PRECONDITION_REQUIRED);
    return this.db.withUser(user.id, async (c) => {
      const cur = await this.load(c, id);
      if (!cur) throw new NotFoundException();
      if (!jobAllowed(user.access, "job:manage", jobRef(cur))) throw new ForbiddenException("Not permitted");
      const b = parse();
      if (expected !== cur.row_version) throw new HttpException("stale", HttpStatus.PRECONDITION_FAILED);
      const kind = cur.kind;
      if (kind === "client_requirement" && (b.companyId != null || b.clientId === null)) throw new UnprocessableEntityException("invalid_job_reference");
      if (kind === "internal_opening" && b.clientId != null) throw new UnprocessableEntityException("client_not_allowed");
      if (kind === "client_requirement" && b.publishedToPortal === true) throw new UnprocessableEntityException("portal_internal_only");
      const sets: string[] = [];
      const params: unknown[] = [];
      const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
      const col: Record<string, string> = {
        title: "title", category: "category", experienceLevel: "experience_level", employmentType: "employment_type",
        workMode: "work_mode", status: "status", workHours: "work_hours", clientId: "client_id", companyId: "company_id",
        location: "location", skills: "skills", hiringManagerId: "hiring_manager_id", publishedToPortal: "published_to_portal",
      };
      for (const [k, v] of Object.entries(b)) {
        if (k in col) sets.push(`${col[k]} = ${p(v)}`);
      }
      if (b.deadline !== undefined) sets.push(`deadline = ${p(b.deadline)}::date`);
      if (b.requirements !== undefined) sets.push(`requirements = ${p(b.requirements === null ? null : JSON.stringify(b.requirements))}::jsonb`);
      if (b.description !== undefined) sets.push(`description = ${p(b.description === null ? null : JSON.stringify(b.description))}::jsonb`);
      if (b.pay !== undefined) {
        sets.push(`pay_amount = ${p(b.pay?.amount ?? null)}`, `pay_frequency = ${p(b.pay?.frequency ?? null)}`, `pay_currency = ${p(b.pay?.currency ?? null)}`);
      }
      let rowVersion: number;
      try {
        const r = await c.query<{ row_version: number }>(
          `UPDATE eureka.job SET ${sets.join(", ")} WHERE id = ${p(id)} AND row_version = ${p(expected)} RETURNING row_version`, params);
        if (r.rowCount === 0) throw new HttpException("stale", HttpStatus.PRECONDITION_FAILED);
        rowVersion = r.rows[0]!.row_version;
      } catch (err) {
        if (err instanceof HttpException) throw err;
        mapJobError(err);
      }
      const changed = Object.keys(b).sort();
      await this.audit.record(c, {
        actorId: user.id, action: "job.updated", entityType: "job", entityId: id,
        changes: {
          fields: changed,
          ...(b.status !== undefined && b.status !== cur.status ? { status: { from: cur.status, to: b.status } } : {}),
          ...(b.publishedToPortal !== undefined ? { publishedToPortal: b.publishedToPortal } : {}),
          ...(b.hiringManagerId !== undefined ? { hiringManagerId: b.hiringManagerId } : {}),
        },
      });
      const fresh = (await this.load(c, id))!;
      return this.present(user.access, fresh, await companyNames(c, [fresh.company_id ? fresh.id : null]));
    });
  }

  /** For the web app's navigation and pickers: may the caller see the Jobs screen at all? */
  static canList(access: UserAccess) { return can(access, "job:read"); }
}
