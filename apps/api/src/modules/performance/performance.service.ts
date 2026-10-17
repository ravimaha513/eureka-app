import {
  ForbiddenException, HttpException, HttpStatus, Injectable, NotFoundException, ServiceUnavailableException, UnprocessableEntityException,
} from "@nestjs/common";
import type pg from "pg";
import { z } from "zod";
import { SALES_ROLES, resolveScope, type EffectiveScope, type Permission, type UserAccess } from "@eureka/shared";
import { AuditService } from "../../platform/audit.service.js";
import type { AuthedUser } from "../../platform/auth.guard.js";
import { DbService, EXPORT_STATEMENT_TIMEOUT } from "../../platform/db.service.js";
import { RateLimiter } from "../../platform/rate-limit.js";
import { scopePredicate } from "../candidates/candidates.service.js";
import { activityPredicate } from "../submissions/submissions.service.js";
import type { ActiveCandidatesQuery, ActivityKind, ActivityQuery, PeriodQuery, SetTarget, TargetListQuery } from "./performance.schemas.js";

const DAY_MS = 86_400_000;
/** Default period when the request names none (PF-1). */
export const DEFAULT_PERIOD_DAYS = 30;
/** Longest period one request may cover. */
export const MAX_PERIOD_DAYS = 366;
/** Report requests per user per minute (per API task, like the dashboard limit). */
export const PERFORMANCE_REQUESTS_PER_MINUTE = 30;
/** Rows of the active-candidates list and the targets list (the total is always exact). */
export const LIST_LIMIT = 500;
/** Target periods are calendar days in the zone the business runs on (as the worker's reminder jobs). */
export const TARGET_TIME_ZONE = "America/New_York";

/** People whose performance is reported: the Sales line below the CEO. */
const SUBJECT_ROLES = SALES_ROLES.filter((r) => r !== "ceo");

/** Interviews that happen (or happened): not cancelled, rescheduled or without an invite (as the dashboard). */
const LIVE_INTERVIEW_SQL = `NOT IN ('cancelled', 'rescheduled', 'no_invite')`;

/** Each count is made of rows the caller could list with this read permission (list predicate and RLS). */
const READ_PERM: Record<ActivityKind, Permission> = {
  submissions: "submission:read",
  interviews: "interview:read",
  interviewsCleared: "interview:read",
  placements: "placement:read",
  joined: "placement:read",
};

type Params = unknown[];
const bind = (params: Params) => (v: unknown) => { params.push(v); return `$${params.length}`; };

export interface Counts { submissions: number; interviews: number; interviewsCleared: number; placements: number; joined: number }
export interface Ratios { submissionToInterview: number | null; interviewToPlacement: number | null; placement: number | null }

const ratio = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 1000) / 1000 : null);

/** PF-3: submission → interview, interview → placement, and the overall placement ratio (placements per submission). */
export function ratios(c: Counts): Ratios {
  return {
    submissionToInterview: ratio(c.interviews, c.submissions),
    interviewToPlacement: ratio(c.placements, c.interviews),
    placement: ratio(c.placements, c.submissions),
  };
}

/** Normalizes the period: default the last DEFAULT_PERIOD_DAYS; from < to; at most MAX_PERIOD_DAYS. */
export function resolvePeriod(q: Pick<PeriodQuery, "from" | "to">, now = Date.now()): { from: Date; to: Date } {
  const to = q.to ? new Date(q.to) : new Date(now);
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - DEFAULT_PERIOD_DAYS * DAY_MS);
  if (!(from.getTime() < to.getTime())) throw new z.ZodError([{ code: "custom", path: ["to"], message: "to must be after from" }]);
  if (to.getTime() - from.getTime() > MAX_PERIOD_DAYS * DAY_MS) {
    throw new z.ZodError([{ code: "custom", path: ["from"], message: `the period can cover at most ${MAX_PERIOD_DAYS} days` }]);
  }
  return { from, to };
}

interface Scopes {
  /** performance:read: whose activity is reported (the actor snapshot of each row). */
  perf: EffectiveScope;
  read: Partial<Record<Permission, EffectiveScope>>;
}

/** The actor snapshot of an activity row is in the caller's performance:read scope. */
const perfActorSql = (perf: EffectiveScope, params: Params, alias: string) =>
  perf.all ? "true" : scopePredicate({ ...perf, allTeams: false, hotlistOpen: false }, params, alias);

/** WHERE fragment for an activity alias (candidate joined as `c`): listable with `perm`, and in performance scope. */
function activityWhere(s: Scopes, perm: Permission, params: Params, alias: string): string | null {
  const read = s.read[perm];
  if (!read) return null;
  return `${activityPredicate(read, params, alias, "c")} AND ${perfActorSql(s.perf, params, alias)}`;
}

/** The SQL of one activity kind: alias, table, timestamp and extra condition. */
const KIND_SQL: Record<ActivityKind, { alias: string; table: string; ts: string; extra: string }> = {
  submissions: { alias: "s", table: "eureka.submission", ts: "s.submitted_at", extra: "true" },
  interviews: { alias: "i", table: "eureka.interview", ts: "i.starts_at", extra: `i.call_status ${LIVE_INTERVIEW_SQL}` },
  interviewsCleared: { alias: "i", table: "eureka.interview", ts: "i.cleared_at", extra: "i.cleared" },
  placements: { alias: "pl", table: "eureka.placement", ts: "pl.created_at", extra: "true" },
  joined: { alias: "pl", table: "eureka.placement", ts: "pl.joined_at", extra: "pl.joined_at IS NOT NULL" },
};
const KINDS = Object.keys(KIND_SQL) as ActivityKind[];

const zero = (): Counts => ({ submissions: 0, interviews: 0, interviewsCleared: 0, placements: 0, joined: 0 });

interface TargetRow {
  id: string; user_id: string; user_name: string | null; period_kind: string; period_start: string; period_end: string;
  submissions: number | null; interviews: number | null; placements: number | null;
  a_sub: number | null; a_int: number | null; a_pl: number | null; ended: boolean;
  set_by: string; set_by_name: string | null; updated_at: Date;
}

/** The last calendar day of a period whose exclusive end is `end` ("YYYY-MM-DD"). */
function lastDay(end: string): string {
  const d = new Date(`${end}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Recruiter performance (docs/performance-api.md PF-1..PF-8; migrations
 * 0110-0112). Reads run as the caller under RLS, each count narrowed to the
 * list predicate of its read permission and to the caller's performance:read
 * scope over the row's actor snapshot (recruiter, team, location), exactly as
 * the dashboard narrows to report:read. Targets are written only through the
 * definer functions, which re-check performance.target:manage.
 */
@Injectable()
export class PerformanceService {
  private readonly limiter = new RateLimiter(PERFORMANCE_REQUESTS_PER_MINUTE, 60_000);

  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  private scopes(access: UserAccess): Scopes {
    const perf = resolveScope(access, "performance:read");
    if (!perf) throw new ForbiddenException();
    const read: Scopes["read"] = {};
    for (const perm of new Set(Object.values(READ_PERM))) {
      const s = resolveScope(access, perm);
      if (s) read[perm] = s;
    }
    return { perf, read };
  }

  private take(user: AuthedUser): void {
    if (!this.limiter.take(user.id)) {
      throw new HttpException("Too many performance requests; try again in a minute", HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  /** Runs a report as the user; a statement timeout becomes 503 (as the dashboard). */
  private async report<T>(user: AuthedUser, all: boolean, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    try {
      return await this.db.withUser(user.id, async (c) => {
        if (all) await c.query(`SET LOCAL statement_timeout = '${EXPORT_STATEMENT_TIMEOUT}'`);
        return fn(c);
      });
    } catch (err) {
      if ((err as { code?: string }).code === "57014") {
        throw new ServiceUnavailableException("The report took too long; narrow the period and try again");
      }
      throw err;
    }
  }

  /** People (active Sales users) the caller's performance:read grant covers. */
  private async subjects(c: pg.PoolClient, perf: EffectiveScope): Promise<string[]> {
    const { rows } = await c.query<{ id: string }>(
      `SELECT u.id FROM eureka.app_user u
        WHERE u.status = 'active'
          AND EXISTS (SELECT 1 FROM eureka.user_role ur WHERE ur.user_id = u.id AND ur.role_key = ANY ($1::text[])
                       AND ur.valid @> now())
          AND ($2::boolean OR u.id = ANY ((SELECT authz.scope_user_ids('performance:read'))::uuid[]))`,
      [SUBJECT_ROLES, perf.all]);
    return rows.map((r) => r.id);
  }

  private async people(c: pg.PoolClient, ids: string[]) {
    if (!ids.length) return [];
    const { rows } = await c.query<{ id: string; name: string; designation: string | null; status: string; team_id: string | null; team_name: string | null }>(
      `SELECT u.id, u.display_name AS name, u.designation, u.status, tt.id AS team_id, tt.name AS team_name
         FROM eureka.app_user u
         LEFT JOIN LATERAL (
           SELECT t.id, t.name FROM eureka.team t
            WHERE t.lead_id = u.id
               OR t.id IN (SELECT tm.team_id FROM eureka.team_member tm WHERE tm.user_id = u.id AND tm.valid @> now())
            ORDER BY (t.lead_id = u.id), t.name, t.id LIMIT 1) tt ON true
        WHERE u.id = ANY ($1::uuid[])
        ORDER BY u.display_name, u.id`, [ids]);
    return rows;
  }

  // ---------- PF-1..PF-3: counts per person ----------

  async summary(user: AuthedUser, q: PeriodQuery) {
    const s = this.scopes(user.access);
    const { from, to } = resolvePeriod(q);
    this.take(user);
    return this.report(user, s.perf.all, async (c) => {
      const params: Params = [];
      const p = bind(params);
      const $from = p(from.toISOString());
      const $to = p(to.toISOString());
      const branches: string[] = [];
      for (const kind of KINDS) {
        const k = KIND_SQL[kind];
        const where = activityWhere(s, READ_PERM[kind], params, k.alias);
        if (!where) continue;
        branches.push(`SELECT '${kind}'::text AS m, ${k.alias}.recruiter_id AS k FROM ${k.table} ${k.alias}
          LEFT JOIN eureka.candidate c ON c.id = ${k.alias}.candidate_id
          WHERE ${where} AND ${k.extra} AND ${k.ts} >= ${$from}::timestamptz AND ${k.ts} < ${$to}::timestamptz`);
      }
      const counted = branches.length
        ? (await c.query<{ m: ActivityKind; k: string; n: number }>(
          `SELECT m, k, count(*)::int AS n FROM (${branches.join("\nUNION ALL\n")}) x GROUP BY m, k`, params)).rows
        : [];
      const ids = new Set(await this.subjects(c, s.perf));
      for (const r of counted) ids.add(r.k);
      const byUser = new Map<string, Counts>();
      const totals = zero();
      for (const r of counted) {
        const cnt = byUser.get(r.k) ?? zero();
        cnt[r.m] += r.n;
        totals[r.m] += r.n;
        byUser.set(r.k, cnt);
      }
      const people = (await this.people(c, [...ids])).map((u) => {
        const counts = byUser.get(u.id) ?? zero();
        return {
          user: { id: u.id, name: u.name, designation: u.designation, active: u.status === "active" },
          team: u.team_id ? { id: u.team_id, name: u.team_name } : null,
          counts,
          ratios: ratios(counts),
        };
      });
      return {
        period: { from: from.toISOString(), to: to.toISOString() },
        /** Kinds the caller can list; the others are always zero. */
        kinds: KINDS.filter((k) => s.read[READ_PERM[k]]),
        totals: { counts: totals, ratios: ratios(totals) },
        people,
      };
    });
  }

  // ---------- PF-2: drill-down rows ----------

  async activity(user: AuthedUser, q: ActivityQuery) {
    const s = this.scopes(user.access);
    const { from, to } = resolvePeriod(q);
    this.take(user);
    const k = KIND_SQL[q.kind];
    return this.report(user, s.perf.all, async (c) => {
      const params: Params = [];
      const where = activityWhere(s, READ_PERM[q.kind], params, k.alias);
      if (!where) return { kind: q.kind, period: { from: from.toISOString(), to: to.toISOString() }, total: 0, items: [] };
      const p = bind(params);
      const conds = [where, k.extra, `${k.ts} >= ${p(from.toISOString())}::timestamptz`, `${k.ts} < ${p(to.toISOString())}::timestamptz`];
      if (q.userId) conds.push(`${k.alias}.recruiter_id = ${p(q.userId)}::uuid`);
      const a = k.alias;
      const detail = q.kind === "submissions"
        ? `s.status AS status, s.job_title AS d1, NULL::text AS d2, NULL::text AS d3`
        : q.kind === "interviews" || q.kind === "interviewsCleared"
          ? `i.call_status AS status, i.round AS d1, CASE WHEN i.cleared THEN 'yes' ELSE 'no' END AS d2, NULL::text AS d3`
          : `pl.status AS status, v.name AS d1, pl.tentative_start::text AS d2, pl.placement_type AS d3`;
      const joins = q.kind === "placements" || q.kind === "joined" ? `LEFT JOIN eureka.vendor v ON v.id = pl.vendor_id` : "";
      const sql = `SELECT ${a}.id, ${k.ts} AS at, ${a}.candidate_id,
          CASE WHEN pp.id IS NOT NULL THEN pp.first_name || ' ' || pp.last_name END AS candidate_name,
          ${a}.recruiter_id, ru.display_name AS recruiter_name, tm.name AS team_name, cl.name AS client, ${detail},
          count(*) OVER ()::int AS total
        FROM ${k.table} ${a}
        LEFT JOIN eureka.candidate c ON c.id = ${a}.candidate_id
        LEFT JOIN eureka.person pp ON pp.id = c.person_id
        LEFT JOIN eureka.app_user ru ON ru.id = ${a}.recruiter_id
        LEFT JOIN eureka.team tm ON tm.id = ${a}.team_id
        LEFT JOIN eureka.client cl ON cl.id = ${a}.client_id
        ${joins}
        WHERE ${conds.join(" AND ")}
        ORDER BY ${k.ts} DESC, ${a}.id
        LIMIT ${p(q.limit)} OFFSET ${p(q.offset)}`;
      type Row = {
        id: string; at: Date; candidate_id: string; candidate_name: string | null; recruiter_id: string; recruiter_name: string | null;
        team_name: string | null; client: string | null; status: string; d1: string | null; d2: string | null; d3: string | null; total: number;
      };
      const { rows } = await c.query<Row>(sql, params);
      const total = rows[0]?.total ?? (q.offset > 0
        ? (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${k.table} ${a} LEFT JOIN eureka.candidate c ON c.id = ${a}.candidate_id
             WHERE ${conds.join(" AND ")}`, params.slice(0, params.length - 2))).rows[0]!.n
        : 0);
      return {
        kind: q.kind,
        period: { from: from.toISOString(), to: to.toISOString() },
        total,
        items: rows.map((r) => ({
          id: r.id,
          at: r.at.toISOString(),
          candidate: { id: r.candidate_id, name: r.candidate_name },
          recruiter: { id: r.recruiter_id, name: r.recruiter_name },
          team: r.team_name,
          client: r.client,
          status: r.status,
          detail: q.kind === "submissions" ? { jobTitle: r.d1 }
            : q.kind === "interviews" || q.kind === "interviewsCleared" ? { round: r.d1, cleared: r.d2 }
              : { vendor: r.d1, tentativeStart: r.d2, placementType: r.d3 },
        })),
      };
    });
  }

  // ---------- PF-5: active candidates on end-client projects ----------

  async activeCandidates(user: AuthedUser, q: ActiveCandidatesQuery) {
    const s = this.scopes(user.access);
    const { from, to } = resolvePeriod(q);
    this.take(user);
    const tz = q.tz ?? TARGET_TIME_ZONE;
    return this.report(user, s.perf.all, async (c) => {
      const params: Params = [];
      const where = activityWhere(s, "placement:read", params, "pl");
      const period = { from: from.toISOString(), to: to.toISOString() };
      if (!where) return { period, total: 0, truncated: false, items: [] };
      const p = bind(params);
      const $tz = p(tz);
      const fromDay = `(${p(from.toISOString())}::timestamptz AT TIME ZONE ${$tz}::text)::date`;
      const lastDayExpr = `((${p(to.toISOString())}::timestamptz - interval '1 microsecond') AT TIME ZONE ${$tz}::text)::date`;
      const conds = [where, `a.start_date <= ${lastDayExpr}`, `(a.end_date IS NULL OR a.end_date >= ${fromDay})`];
      if (q.userId) conds.push(`pl.recruiter_id = ${p(q.userId)}::uuid`);
      type Row = {
        placement_id: string; assignment_id: string; start_date: string; end_date: string | null; candidate_id: string; candidate_name: string | null;
        client: string; vendor: string | null; partner: string | null; work_mode: string; recruiter_id: string; recruiter_name: string | null;
        team_name: string | null; location_name: string | null; total: number;
      };
      const { rows } = await c.query<Row>(
        `SELECT pl.id AS placement_id, a.id AS assignment_id, a.start_date::text AS start_date, a.end_date::text AS end_date,
                pl.candidate_id, CASE WHEN pp.id IS NOT NULL THEN pp.first_name || ' ' || pp.last_name END AS candidate_name,
                cl.name AS client, v.name AS vendor, ip.name AS partner, pl.work_mode,
                pl.recruiter_id, ru.display_name AS recruiter_name, tm.name AS team_name, l.name AS location_name,
                count(*) OVER ()::int AS total
           FROM eureka.assignment a
           JOIN eureka.placement pl ON pl.id = a.placement_id
           LEFT JOIN eureka.candidate c ON c.id = pl.candidate_id
           LEFT JOIN eureka.person pp ON pp.id = c.person_id
           JOIN eureka.client cl ON cl.id = pl.client_id
           LEFT JOIN eureka.vendor v ON v.id = pl.vendor_id
           LEFT JOIN eureka.implementation_partner ip ON ip.id = pl.implementation_partner_id
           LEFT JOIN eureka.app_user ru ON ru.id = pl.recruiter_id
           LEFT JOIN eureka.team tm ON tm.id = pl.team_id
           LEFT JOIN eureka.location l ON l.id = pl.location_id
          WHERE ${conds.join(" AND ")}
          ORDER BY a.start_date DESC, a.id
          LIMIT ${p(LIST_LIMIT)}`, params);
      const total = rows[0]?.total ?? 0;
      return {
        period,
        total,
        truncated: total > rows.length,
        items: rows.map((r) => ({
          placementId: r.placement_id,
          assignmentId: r.assignment_id,
          candidate: { id: r.candidate_id, name: r.candidate_name },
          client: r.client,
          vendor: r.vendor,
          implementationPartner: r.partner,
          workMode: r.work_mode,
          joiningDate: r.start_date,
          endDate: r.end_date,
          recruiter: { id: r.recruiter_id, name: r.recruiter_name },
          team: r.team_name,
          location: r.location_name,
        })),
      };
    });
  }

  // ---------- PF-4: targets ----------

  /** Users the caller may set targets for (null: everyone), from the database's own scope function. */
  private async manageable(c: pg.PoolClient, access: UserAccess): Promise<Set<string> | null | undefined> {
    const scope = resolveScope(access, "performance.target:manage");
    if (!scope) return undefined;
    if (scope.all) return null;
    const { rows } = await c.query<{ ids: string[] }>(`SELECT authz.scope_user_ids('performance.target:manage') AS ids`);
    return new Set(rows[0]!.ids);
  }

  private async targetRows(c: pg.PoolClient, s: Scopes, filter: { id?: string; from?: string; through?: string; userId?: string }): Promise<TargetRow[]> {
    const params: Params = [];
    const p = bind(params);
    const $tz = p(TARGET_TIME_ZONE);
    const lo = `(t.period_start::timestamp AT TIME ZONE ${$tz}::text)`;
    const hi = `(t.period_end::timestamp AT TIME ZONE ${$tz}::text)`;
    const actual = (kind: ActivityKind, col: string) => {
      const k = KIND_SQL[kind];
      const read = s.read[READ_PERM[kind]];
      if (!read) return "NULL::int";
      return `CASE WHEN t.${col} IS NOT NULL THEN (SELECT count(*)::int FROM ${k.table} ${k.alias}
          LEFT JOIN eureka.candidate c ON c.id = ${k.alias}.candidate_id
         WHERE ${k.alias}.recruiter_id = t.user_id AND ${activityPredicate(read, params, k.alias, "c")} AND ${k.extra}
           AND ${k.ts} >= ${lo} AND ${k.ts} < ${hi}) END`;
    };
    const conds = ["true"];
    if (filter.id) conds.push(`t.id = ${p(filter.id)}::uuid`);
    if (filter.from) conds.push(`t.period_end > ${p(filter.from)}::date`);
    if (filter.through) conds.push(`t.period_start <= ${p(filter.through)}::date`);
    if (filter.userId) conds.push(`t.user_id = ${p(filter.userId)}::uuid`);
    const sql = `SELECT t.id, t.user_id, u.display_name AS user_name, t.period_kind, t.period_start::text AS period_start,
        t.period_end::text AS period_end, t.submissions, t.interviews, t.placements,
        ${actual("submissions", "submissions")} AS a_sub, ${actual("interviews", "interviews")} AS a_int,
        ${actual("placements", "placements")} AS a_pl,
        t.period_end <= (now() AT TIME ZONE ${$tz}::text)::date AS ended,
        t.set_by, sb.display_name AS set_by_name, t.updated_at
      FROM eureka.performance_target t
      JOIN eureka.app_user u ON u.id = t.user_id
      LEFT JOIN eureka.app_user sb ON sb.id = t.set_by
      WHERE ${conds.join(" AND ")}
      ORDER BY t.period_start DESC, u.display_name, t.period_kind, t.id
      LIMIT ${p(LIST_LIMIT + 1)}`;
    return (await c.query<TargetRow>(sql, params)).rows;
  }

  private presentTarget(r: TargetRow, manage: Set<string> | null | undefined, me: string) {
    const metrics = [[r.submissions, r.a_sub], [r.interviews, r.a_int], [r.placements, r.a_pl]] as const;
    const below = metrics.some(([t, a]) => t !== null && a !== null && a < t);
    const met = metrics.every(([t, a]) => t === null || (a !== null && a >= t));
    return {
      id: r.id,
      user: { id: r.user_id, name: r.user_name },
      periodKind: r.period_kind,
      periodStart: r.period_start,
      /** Last day of the period (inclusive). */
      periodEnd: lastDay(r.period_end),
      targets: { submissions: r.submissions, interviews: r.interviews, placements: r.placements },
      actuals: { submissions: r.a_sub, interviews: r.a_int, placements: r.a_pl },
      /** met: every target reached; below: the period ended short of one; inProgress: still running and not yet met. */
      status: met ? "met" : r.ended && below ? "below" : r.ended ? "unknown" : "inProgress",
      setBy: { id: r.set_by, name: r.set_by_name },
      updatedAt: r.updated_at.toISOString(),
      canManage: manage !== undefined && r.user_id !== me && (manage === null || manage.has(r.user_id)),
    };
  }

  async listTargets(user: AuthedUser, q: TargetListQuery) {
    const s = this.scopes(user.access);
    return this.db.withUser(user.id, async (c) => {
      const manage = await this.manageable(c, user.access);
      const rows = await this.targetRows(c, s, q);
      return {
        truncated: rows.length > LIST_LIMIT,
        items: rows.slice(0, LIST_LIMIT).map((r) => this.presentTarget(r, manage, user.id)),
      };
    });
  }

  /** Read before write: 404 for an unknown user, 403 for themself or outside the manage scope. */
  private async assertManageable(c: pg.PoolClient, user: AuthedUser, targetUser: string) {
    const exists = (await c.query(`SELECT 1 FROM eureka.app_user WHERE id = $1`, [targetUser])).rowCount;
    if (!exists) throw new NotFoundException();
    if (targetUser === user.id) throw new ForbiddenException("self_change");
    const manage = await this.manageable(c, user.access);
    if (manage === undefined) throw new ForbiddenException("not_permitted");
    if (manage !== null && !manage.has(targetUser)) throw new ForbiddenException("not_in_scope");
  }

  private mapTargetError(err: unknown): never {
    const e = err as { code?: string; message?: string };
    if (e.code === "P0002") throw new NotFoundException();
    if (e.code === "42501") throw new ForbiddenException(e.message === "self_change" || e.message === "not_in_scope" ? e.message : "not_permitted");
    if (e.code === "23514") throw new UnprocessableEntityException(e.message === "user_inactive" ? "user_inactive" : "invalid_target");
    throw err;
  }

  async setTarget(user: AuthedUser, body: SetTarget) {
    const s = this.scopes(user.access);
    return this.db.withUser(user.id, async (c) => {
      await this.assertManageable(c, user, body.userId);
      let row: { target_id: string; created: boolean };
      try {
        row = (await c.query<{ target_id: string; created: boolean }>(
          `SELECT * FROM authz.performance_target_set($1, $2, $3::date, $4, $5, $6)`,
          [body.userId, body.periodKind, body.periodStart, body.submissions, body.interviews, body.placements])).rows[0]!;
      } catch (err) {
        this.mapTargetError(err);
      }
      await this.audit.record(c, {
        actorId: user.id, action: row.created ? "performance.target_created" : "performance.target_updated",
        entityType: "performance_target", entityId: row.target_id,
        changes: {
          userId: body.userId, periodKind: body.periodKind, periodStart: body.periodStart,
          submissions: body.submissions, interviews: body.interviews, placements: body.placements,
        },
      });
      const manage = await this.manageable(c, user.access);
      const r = (await this.targetRows(c, s, { id: row.target_id }))[0];
      // Visible under the manage policy even when performance:read is narrower.
      if (!r) throw new NotFoundException();
      return { created: row.created, target: this.presentTarget(r, manage, user.id) };
    });
  }

  async deleteTarget(user: AuthedUser, id: string) {
    return this.db.withUser(user.id, async (c) => {
      const t = (await c.query<{ user_id: string; period_kind: string; period_start: string }>(
        `SELECT user_id, period_kind, period_start::text AS period_start FROM eureka.performance_target WHERE id = $1`, [id])).rows[0];
      if (!t) throw new NotFoundException();
      await this.assertManageable(c, user, t.user_id);
      try {
        await c.query(`SELECT authz.performance_target_delete($1)`, [id]);
      } catch (err) {
        this.mapTargetError(err);
      }
      await this.audit.record(c, {
        actorId: user.id, action: "performance.target_deleted", entityType: "performance_target", entityId: id,
        changes: { userId: t.user_id, periodKind: t.period_kind, periodStart: t.period_start },
      });
    });
  }

  // ---------- PF-7: people and what the caller may do for each ----------

  async peopleList(user: AuthedUser) {
    const s = this.scopes(user.access);
    return this.db.withUser(user.id, async (c) => {
      const ids = await this.subjects(c, s.perf);
      const rows = await this.people(c, ids);
      const manage = await this.manageable(c, user.access);
      const designation = resolveScope(user.access, "designation:change");
      const designationIds = designation && !designation.all
        ? new Set((await c.query<{ ids: string[] }>(`SELECT authz.scope_user_ids('designation:change') AS ids`)).rows[0]!.ids)
        : null;
      const move = resolveScope(user.access, "team:move_member");
      const moveTeams = move
        ? (await c.query<{ id: string; name: string }>(
          `SELECT id, name FROM eureka.team WHERE $1::boolean OR id = ANY ($2::uuid[]) ORDER BY name, id`,
          [move.all, [...move.teamIds]])).rows
        : [];
      const movable = new Set(moveTeams.map((t) => t.id));
      // Only a current member (not the lead) can be moved; the move needs the membership's team.
      const memberOf = new Map((await c.query<{ user_id: string; team_id: string }>(
        `SELECT user_id, team_id FROM eureka.team_member WHERE user_id = ANY ($1::uuid[]) AND valid @> now() ORDER BY team_id`, [ids])).rows
        .map((r) => [r.user_id, r.team_id]));
      return {
        people: rows.map((r) => {
          const self = r.id === user.id;
          const fromTeam = memberOf.get(r.id) ?? null;
          return {
            id: r.id,
            name: r.name,
            designation: r.designation,
            team: r.team_id ? { id: r.team_id, name: r.team_name } : null,
            memberOfTeamId: fromTeam,
            canSetTarget: !self && manage !== undefined && (manage === null || manage.has(r.id)),
            canChangeDesignation: !self && designation !== null && (designation.all || designationIds!.has(r.id)),
            canMoveTeam: !self && fromTeam !== null && movable.has(fromTeam) && moveTeams.length > 1,
          };
        }),
        moveTeams,
      };
    });
  }
}
