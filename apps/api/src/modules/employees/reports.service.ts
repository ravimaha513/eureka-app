import type pg from "pg";
import { ForbiddenException, HttpException, HttpStatus, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { resolveScope, type EffectiveScope, type UserAccess } from "@eureka/shared";
import { AuditService } from "../../platform/audit.service.js";
import type { AuthedUser } from "../../platform/auth.guard.js";
import { DbService } from "../../platform/db.service.js";
import { RateLimiter } from "../../platform/rate-limit.js";
import { toCsv } from "../hotlist/csv.js";
import { EXPORTS_PER_WINDOW, EXPORT_ROW_CAP, EXPORT_WINDOW_MS } from "../hotlist/hotlist.service.js";
import { activityPredicate } from "../submissions/submissions.service.js";
import type { ActiveEmployeesQuery, ReportPeriod } from "./employees.schemas.js";

/**
 * Joinings and exits report (FR-EMP, design B7; docs/employees-api.md) and the
 * active-employee count (0150). Parameterized SQL over eureka.assignment under
 * the caller's RLS, plus the engine's assignment:read and report:read
 * predicates (the same rows the caller can read as assignments, so the counts
 * match what they can list). A joining is an assignment that started in the
 * period; an exit is one that ended in the period (project exit or BGC failed
 * after joining). The export is further limited to report:export, capped,
 * rate-limited, audited.
 *
 * 0150: callers with employee:read, assignment:read and report:read at org
 * scope but no placement scope (Immigration) read the same assignments through
 * authz.employment_movements (ids, dates, reasons, payroll company: what their
 * employment history already shows), without client or recruiter.
 */

interface Row {
  id: string;
  assignment_no: number;
  start_date: string;
  end_date: string | null;
  end_reason: string | null;
  is_first_placement: boolean;
  placement_id: string;
  candidate_id: string;
  candidate_name: string | null;
  client_name: string | null;
  team_id: string | null;
  team_name: string | null;
  recruiter_name: string | null;
  location_name: string | null;
  technology_name: string | null;
  payroll_company_id: string | null;
  payroll_company_name: string | null;
}

export interface ReportItem {
  kind: "joining" | "exit";
  date: string;
  assignmentId: string;
  assignmentNo: number;
  placementId: string;
  candidate: { id: string; name: string | null };
  /** null when the caller cannot read the placement (employee-only readers). */
  client: string | null;
  team: { id: string; name: string | null } | null;
  recruiter: string | null;
  location: string | null;
  isFirstPlacement: boolean;
  /** 0150: the person's first assignment (assignment no. 1) vs a later one. */
  isFirstAssignment: boolean;
  technology: string | null;
  payrollCompany: { id: string; name: string | null } | null;
  endReason: string | null;
}

/** Rows returned in the JSON view (totals always cover every matching assignment). */
export const REPORT_VIEW_CAP = 1000;
/** JSON report requests per user per minute (org-wide reports are expensive; design A6.5). */
export const REPORT_VIEWS_PER_MINUTE = 30;

interface GroupCount {
  team_id: string | null; team_name: string | null; company_id: string | null; company_name: string | null;
  joinings: number; first_placements: number; first_assignments: number; exits: number;
  completed: number; terminated: number; resigned: number; bgc_failed: number;
}

/** Where the caller's rows come from: their RLS-visible assignments, the employee-reader definer, or nothing. */
type Source = { kind: "rls"; scopes: EffectiveScope[] } | { kind: "employee" } | { kind: "none" };
type Mode = "movements" | "active";

async function timed<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if ((err as { code?: string }).code === "57014") throw new ServiceUnavailableException("The report took too long. Choose a shorter period.");
    throw err;
  }
}

const label = (s: string) => { const t = s.replace(/_/g, " "); return t.charAt(0).toUpperCase() + t.slice(1); };
const ref = (id: string | null, name: string | null) => (id ? { id, name } : null);

/** First and last day of a YYYY-MM month. */
export function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}

/**
 * Base rows (one per assignment) for a period: params $1 = from, $2 = to.
 * Columns: id, person_id, assignment_no, start_date, end_date, end_reason,
 * is_first_placement, placement_id, candidate_id, team_id, location_id,
 * recruiter_id, client_id, client_name, payroll_company_id.
 */
function baseSql(src: Exclude<Source, { kind: "none" }>, params: unknown[], mode: Mode, clientId?: string): string {
  if (src.kind === "employee") {
    // No client is visible to these callers: a client filter matches nothing.
    return `SELECT m.assignment_id AS id, m.person_id, m.assignment_no, m.start_date, m.end_date, m.end_reason,
                   m.is_first_placement, m.placement_id, m.candidate_id, m.team_id, m.location_id,
                   NULL::uuid AS recruiter_id, NULL::uuid AS client_id, NULL::text AS client_name, m.payroll_company_id
            FROM authz.employment_movements($1::date, $2::date, ${mode === "active"}) m
            ${clientId ? "WHERE false" : ""}`;
  }
  const preds = src.scopes.map((s) => activityPredicate(s, params, "pl", "c"));
  const period = mode === "active"
    ? `a.start_date <= $2::date AND (a.end_date IS NULL OR a.end_date >= $1::date)`
    : `(a.start_date BETWEEN $1::date AND $2::date OR a.end_date BETWEEN $1::date AND $2::date)`;
  if (clientId) { params.push(clientId); preds.push(`pl.client_id = $${params.length}::uuid`); }
  return `SELECT a.id, a.person_id, a.assignment_no, a.start_date, a.end_date, a.end_reason,
                 pl.is_first_placement, pl.id AS placement_id, pl.candidate_id, pl.team_id, pl.location_id,
                 pl.recruiter_id, pl.client_id, cl.name AS client_name, ae.payroll_company_id
          FROM eureka.assignment a
          JOIN eureka.placement pl ON pl.id = a.placement_id
          JOIN eureka.client cl ON cl.id = pl.client_id
          LEFT JOIN eureka.candidate c ON c.id = pl.candidate_id
          LEFT JOIN eureka.assignment_employment ae ON ae.assignment_id = a.id
          WHERE ${period} AND ${preds.join(" AND ")}`;
}

/** The group's companies once per statement (definer, names only). */
const PC = `pc AS MATERIALIZED (SELECT id, name FROM authz.payroll_companies())`;

@Injectable()
export class ReportsService {
  private readonly exportLimiter = new RateLimiter(EXPORTS_PER_WINDOW, EXPORT_WINDOW_MS);
  private readonly viewLimiter = new RateLimiter(REPORT_VIEWS_PER_MINUTE, 60_000);

  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  /** `after` runs in the same transaction (the export's audit row). */
  private async rows(user: AuthedUser, period: ReportPeriod, src: Exclude<Source, { kind: "none" }>, limit: number,
    after?: (c: pg.PoolClient, rows: Row[]) => Promise<void>): Promise<Row[]> {
    const params: unknown[] = [period.from, period.to];
    const sql = `
      WITH b AS (${baseSql(src, params, "movements")}), ${PC}
      SELECT b.id, b.assignment_no, b.start_date::text, b.end_date::text, b.end_reason,
             b.is_first_placement, b.placement_id, b.candidate_id,
             CASE WHEN p.id IS NOT NULL THEN p.first_name || ' ' || p.last_name END AS candidate_name,
             b.client_name, b.team_id, tm.name AS team_name, ru.display_name AS recruiter_name, l.name AS location_name,
             t.name AS technology_name, b.payroll_company_id, pc.name AS payroll_company_name
      FROM b
      LEFT JOIN eureka.candidate c ON c.id = b.candidate_id
      LEFT JOIN eureka.person p ON p.id = c.person_id
      LEFT JOIN eureka.technology t ON t.id = c.technology_id
      LEFT JOIN eureka.team tm ON tm.id = b.team_id
      LEFT JOIN eureka.app_user ru ON ru.id = b.recruiter_id
      LEFT JOIN eureka.location l ON l.id = b.location_id
      LEFT JOIN pc ON pc.id = b.payroll_company_id
      ORDER BY greatest(CASE WHEN b.end_date BETWEEN $1::date AND $2::date THEN b.end_date END,
                        CASE WHEN b.start_date BETWEEN $1::date AND $2::date THEN b.start_date END) DESC, b.id
      LIMIT ${limit}`;
    return this.db.withUserExport(user.id, async (c) => {
      const rows = await timed(() => c.query<Row>(sql, params)).then((r) => r.rows);
      if (after) await after(c, rows);
      return rows;
    });
  }

  /**
   * Counts per team and payroll company over every matching assignment
   * (independent of any row cap), from the same rows as rows().
   */
  private async totals(user: AuthedUser, period: ReportPeriod, src: Exclude<Source, { kind: "none" }>): Promise<GroupCount[]> {
    const params: unknown[] = [period.from, period.to];
    const inP = (col: string) => `${col} BETWEEN $1::date AND $2::date`;
    const sql = `
      WITH b AS (${baseSql(src, params, "movements")}), ${PC}
      SELECT b.team_id, tm.name AS team_name, b.payroll_company_id AS company_id, pc.name AS company_name,
             count(*) FILTER (WHERE ${inP("b.start_date")})::int AS joinings,
             count(*) FILTER (WHERE ${inP("b.start_date")} AND b.is_first_placement)::int AS first_placements,
             count(*) FILTER (WHERE ${inP("b.start_date")} AND b.assignment_no = 1)::int AS first_assignments,
             count(*) FILTER (WHERE ${inP("b.end_date")})::int AS exits,
             count(*) FILTER (WHERE ${inP("b.end_date")} AND b.end_reason = 'completed')::int AS completed,
             count(*) FILTER (WHERE ${inP("b.end_date")} AND b.end_reason = 'terminated')::int AS terminated,
             count(*) FILTER (WHERE ${inP("b.end_date")} AND b.end_reason = 'resigned')::int AS resigned,
             count(*) FILTER (WHERE ${inP("b.end_date")} AND b.end_reason = 'bgc_failed')::int AS bgc_failed
      FROM b
      LEFT JOIN eureka.team tm ON tm.id = b.team_id
      LEFT JOIN pc ON pc.id = b.payroll_company_id
      GROUP BY b.team_id, tm.name, b.payroll_company_id, pc.name`;
    return this.db.withUserExport(user.id, async (c) => {
      return (await timed(() => c.query<GroupCount>(sql, params))).rows;
    });
  }

  private items(rows: Row[], period: ReportPeriod): ReportItem[] {
    const out: ReportItem[] = [];
    for (const r of rows) {
      const base = {
        assignmentId: r.id, assignmentNo: r.assignment_no, placementId: r.placement_id,
        candidate: { id: r.candidate_id, name: r.candidate_name }, client: r.client_name,
        team: r.team_id ? { id: r.team_id, name: r.team_name } : null, recruiter: r.recruiter_name, location: r.location_name,
        isFirstPlacement: r.is_first_placement, isFirstAssignment: r.assignment_no === 1,
        technology: r.technology_name, payrollCompany: ref(r.payroll_company_id, r.payroll_company_name),
      };
      if (r.start_date >= period.from && r.start_date <= period.to) out.push({ kind: "joining", date: r.start_date, endReason: null, ...base });
      if (r.end_date !== null && r.end_date >= period.from && r.end_date <= period.to) {
        out.push({ kind: "exit", date: r.end_date, endReason: r.end_reason, ...base });
      }
    }
    return out.sort((a, b) => (a.date === b.date ? a.assignmentId.localeCompare(b.assignmentId) : a.date < b.date ? 1 : -1));
  }

  /**
   * The caller's rows: assignment:read and report:read predicates under RLS;
   * employee readers without placement scope through the definer (0150);
   * no assignment:read: nothing (an empty report, not an error).
   */
  private source(access: UserAccess, extra: EffectiveScope[] = []): Source {
    const report = resolveScope(access, "report:read");
    if (!report) throw new ForbiddenException();
    const assignment = resolveScope(access, "assignment:read");
    if (!assignment) return { kind: "none" };
    if (!resolveScope(access, "placement:read") && resolveScope(access, "employee:read")?.all && report.all && assignment.all
        && extra.every((s) => s.all)) {
      return { kind: "employee" };
    }
    return { kind: "rls", scopes: [assignment, report, ...extra] };
  }

  private takeView(user: AuthedUser) {
    if (!this.viewLimiter.take(user.id)) {
      throw new HttpException("Too many report requests; try again in a minute", HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  async joiningsExits(user: AuthedUser, period: ReportPeriod) {
    const src = this.source(user.access);
    this.takeView(user);
    const groups = src.kind !== "none" ? await this.totals(user, period, src) : [];
    const rows = src.kind !== "none" ? await this.rows(user, period, src, REPORT_VIEW_CAP + 1) : [];
    const items = this.items(rows.slice(0, REPORT_VIEW_CAP), period);
    const sum = (k: keyof GroupCount, gs = groups) => gs.reduce((n, g) => n + (g[k] as number), 0);
    const byKey = <K extends string>(key: (g: GroupCount) => K | null, name: (g: GroupCount) => string | null) => {
      const m = new Map<K | null, { id: K | null; name: string | null; joinings: number; exits: number; firstAssignments: number }>();
      for (const g of groups) {
        const k = key(g);
        const cur = m.get(k) ?? { id: k, name: name(g), joinings: 0, exits: 0, firstAssignments: 0 };
        cur.joinings += g.joinings; cur.exits += g.exits; cur.firstAssignments += g.first_assignments;
        m.set(k, cur);
      }
      return [...m.values()].sort((a, b) => (b.joinings + b.exits) - (a.joinings + a.exits) || (a.name ?? "~").localeCompare(b.name ?? "~"));
    };
    const joinings = sum("joinings");
    const firstAssignments = sum("first_assignments");
    return {
      from: period.from,
      to: period.to,
      totals: {
        joinings,
        firstPlacements: sum("first_placements"),
        firstAssignments,
        laterAssignments: joinings - firstAssignments,
        exits: sum("exits"),
        exitsByReason: { completed: sum("completed"), terminated: sum("terminated"), resigned: sum("resigned"), bgc_failed: sum("bgc_failed") },
      },
      byTeam: byKey((g) => g.team_id, (g) => g.team_name)
        .map((g) => ({ team: g.id ? { id: g.id, name: g.name } : null, joinings: g.joinings, exits: g.exits })),
      byCompany: byKey((g) => g.company_id, (g) => g.company_name)
        .map((g) => ({ company: g.id ? { id: g.id, name: g.name } : null, joinings: g.joinings, firstAssignments: g.firstAssignments,
          laterAssignments: g.joinings - g.firstAssignments, exits: g.exits })),
      items: items.slice(0, REPORT_VIEW_CAP),
      truncated: rows.length > REPORT_VIEW_CAP || items.length > REPORT_VIEW_CAP,
    };
  }

  /**
   * 0150: distinct employees with an assignment running on any day of the
   * month (started on or before its last day, not ended before its first),
   * from the same rows as the joinings/exits report, in total, per client and
   * per payroll company; optionally one client.
   */
  async activeEmployees(user: AuthedUser, q: ActiveEmployeesQuery) {
    const src = this.source(user.access);
    this.takeView(user);
    const { from, to } = monthRange(q.month);
    const empty = { month: q.month, from, to, total: 0, byClient: [], byCompany: [] };
    if (src.kind === "none") return empty;
    const params: unknown[] = [from, to];
    const base = baseSql(src, params, "active", q.clientId);
    const out = await this.db.withUserExport(user.id, async (c) => {
      const sql = `
        WITH b AS MATERIALIZED (${base}), ${PC}
        SELECT 'total' AS g, NULL::uuid AS id, NULL::text AS name, count(DISTINCT b.person_id)::int AS n FROM b
        UNION ALL
        SELECT 'client', b.client_id, b.client_name, count(DISTINCT b.person_id)::int FROM b GROUP BY b.client_id, b.client_name
        UNION ALL
        SELECT 'company', b.payroll_company_id, pc.name, count(DISTINCT b.person_id)::int
        FROM b LEFT JOIN pc ON pc.id = b.payroll_company_id GROUP BY b.payroll_company_id, pc.name`;
      return (await timed(() => c.query<{ g: string; id: string | null; name: string | null; n: number }>(sql, params))).rows;
    });
    const order = (a: { count: number; name: string | null }, b: { count: number; name: string | null }) =>
      b.count - a.count || (a.name ?? "~").localeCompare(b.name ?? "~");
    return {
      ...empty,
      total: out.find((r) => r.g === "total")?.n ?? 0,
      byClient: out.filter((r) => r.g === "client" && r.n > 0)
        .map((r) => ({ client: ref(r.id, r.name), count: r.n, name: r.name })).sort(order).map(({ name: _n, ...r }) => r),
      byCompany: out.filter((r) => r.g === "company" && r.n > 0)
        .map((r) => ({ company: ref(r.id, r.name), count: r.n, name: r.name })).sort(order).map(({ name: _n, ...r }) => r),
    };
  }

  /**
   * CSV of the report limited to the caller's report:export scope as well,
   * capped at EXPORT_ROW_CAP lines, rate-limited, audited in the same request
   * (period and row count only). No phone, email, rate or reason text exists in it.
   */
  async exportCsv(user: AuthedUser, period: ReportPeriod): Promise<{ csv: string; rows: number; truncated: boolean }> {
    const exportScope = resolveScope(user.access, "report:export");
    if (!exportScope) throw new ForbiddenException();
    const src = this.source(user.access, [exportScope]);
    if (!this.exportLimiter.take(user.id)) {
      throw new HttpException("Too many exports; try again in a few minutes", HttpStatus.TOO_MANY_REQUESTS);
    }
    const truncatedOf = (rows: Row[], p: ReportPeriod) =>
      rows.length > EXPORT_ROW_CAP || this.items(rows.slice(0, EXPORT_ROW_CAP), p).length > EXPORT_ROW_CAP;
    const audit = async (c: pg.PoolClient, rows: Row[]) => {
      const n = Math.min(this.items(rows.slice(0, EXPORT_ROW_CAP), period).length, EXPORT_ROW_CAP);
      await this.audit.record(c, {
        actorId: user.id, action: "report.export", entityType: "assignment",
        changes: { report: "joinings_exits", from: period.from, to: period.to, rows: n, truncated: truncatedOf(rows, period), cap: EXPORT_ROW_CAP },
      });
    };
    const rows = src.kind !== "none"
      ? await this.rows(user, period, src, EXPORT_ROW_CAP + 1, audit)
      : await this.db.withUserExport(user.id, async (c) => { await audit(c, []); return [] as Row[]; });
    const truncated = truncatedOf(rows, period);
    const page = this.items(rows.slice(0, EXPORT_ROW_CAP), period).slice(0, EXPORT_ROW_CAP);
    const csv = toCsv(
      ["Event", "Date", "Candidate", "Assignment no.", "Client", "Team", "Recruiter", "Location", "First placement", "End reason",
        "Assignment", "Technology", "Payroll company"],
      page.map((i) => [
        i.kind === "joining" ? "Joining" : "Exit", i.date, i.candidate.name ?? "(not visible)", i.assignmentNo, i.client ?? "",
        i.team?.name ?? "", i.recruiter ?? "", i.location ?? "", i.isFirstPlacement ? "Yes" : "No", i.endReason ? label(i.endReason) : "",
        i.isFirstAssignment ? "First" : "Later", i.technology ?? "", i.payrollCompany?.name ?? "",
      ]),
    );
    return { csv, rows: page.length, truncated };
  }
}
