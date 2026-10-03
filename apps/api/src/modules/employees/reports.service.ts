import type pg from "pg";
import { ForbiddenException, HttpException, HttpStatus, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { resolveScope, type EffectiveScope } from "@eureka/shared";
import { AuditService } from "../../platform/audit.service.js";
import type { AuthedUser } from "../../platform/auth.guard.js";
import { DbService } from "../../platform/db.service.js";
import { RateLimiter } from "../../platform/rate-limit.js";
import { toCsv } from "../hotlist/csv.js";
import { EXPORTS_PER_WINDOW, EXPORT_ROW_CAP, EXPORT_WINDOW_MS } from "../hotlist/hotlist.service.js";
import { activityPredicate } from "../submissions/submissions.service.js";
import type { ReportPeriod } from "./employees.schemas.js";

/**
 * Joinings and exits report (FR-EMP, design B7; docs/employees-api.md).
 * Parameterized SQL over eureka.assignment under the caller's RLS, plus the
 * engine's assignment:read and report:read predicates (the same rows the
 * caller can read as assignments, so the counts match what they can list).
 * A joining is an assignment that started in the period; an exit is one that
 * ended in the period (project exit or BGC failed after joining). The export
 * is further limited to report:export, capped, rate-limited, audited.
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
  client_name: string;
  team_id: string | null;
  team_name: string | null;
  recruiter_name: string | null;
  location_name: string | null;
}

export interface ReportItem {
  kind: "joining" | "exit";
  date: string;
  assignmentId: string;
  assignmentNo: number;
  placementId: string;
  candidate: { id: string; name: string | null };
  client: string;
  team: { id: string; name: string | null } | null;
  recruiter: string | null;
  location: string | null;
  isFirstPlacement: boolean;
  endReason: string | null;
}

/** Rows returned in the JSON view (totals always cover every row). */
export const REPORT_VIEW_CAP = 1000;

const label = (s: string) => { const t = s.replace(/_/g, " "); return t.charAt(0).toUpperCase() + t.slice(1); };

@Injectable()
export class ReportsService {
  private readonly exportLimiter = new RateLimiter(EXPORTS_PER_WINDOW, EXPORT_WINDOW_MS);

  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  /** `after` runs in the same transaction (the export's audit row). */
  private async rows(user: AuthedUser, period: ReportPeriod, scopes: EffectiveScope[], limit: number,
    after?: (c: pg.PoolClient, rows: Row[]) => Promise<void>): Promise<Row[]> {
    const params: unknown[] = [period.from, period.to];
    const preds = scopes.map((s) => activityPredicate(s, params, "pl", "c"));
    const sql = `
      SELECT a.id, a.assignment_no, a.start_date::text, a.end_date::text, a.end_reason,
             pl.is_first_placement, pl.id AS placement_id, pl.candidate_id,
             CASE WHEN p.id IS NOT NULL THEN p.first_name || ' ' || p.last_name END AS candidate_name,
             cl.name AS client_name, pl.team_id, tm.name AS team_name, ru.display_name AS recruiter_name, l.name AS location_name
      FROM eureka.assignment a
      JOIN eureka.placement pl ON pl.id = a.placement_id
      JOIN eureka.client cl ON cl.id = pl.client_id
      LEFT JOIN eureka.candidate c ON c.id = pl.candidate_id
      LEFT JOIN eureka.person p ON p.id = c.person_id
      LEFT JOIN eureka.team tm ON tm.id = pl.team_id
      LEFT JOIN eureka.app_user ru ON ru.id = pl.recruiter_id
      LEFT JOIN eureka.location l ON l.id = pl.location_id
      WHERE (a.start_date BETWEEN $1::date AND $2::date OR a.end_date BETWEEN $1::date AND $2::date)
        AND ${preds.join(" AND ")}
      ORDER BY a.id
      LIMIT ${limit}`;
    return this.db.withUser(user.id, async (c) => {
      await c.query(`SET LOCAL statement_timeout = '60s'`); // design N9: org-wide reports
      let rows: Row[];
      try {
        rows = (await c.query<Row>(sql, params)).rows;
      } catch (err) {
        if ((err as { code?: string }).code === "57014") throw new ServiceUnavailableException("The report took too long. Choose a shorter period.");
        throw err;
      }
      if (after) await after(c, rows);
      return rows;
    });
  }

  private items(rows: Row[], period: ReportPeriod): ReportItem[] {
    const out: ReportItem[] = [];
    for (const r of rows) {
      const base = {
        assignmentId: r.id, assignmentNo: r.assignment_no, placementId: r.placement_id,
        candidate: { id: r.candidate_id, name: r.candidate_name }, client: r.client_name,
        team: r.team_id ? { id: r.team_id, name: r.team_name } : null, recruiter: r.recruiter_name, location: r.location_name,
        isFirstPlacement: r.is_first_placement,
      };
      if (r.start_date >= period.from && r.start_date <= period.to) out.push({ kind: "joining", date: r.start_date, endReason: null, ...base });
      if (r.end_date !== null && r.end_date >= period.from && r.end_date <= period.to) {
        out.push({ kind: "exit", date: r.end_date, endReason: r.end_reason, ...base });
      }
    }
    return out.sort((a, b) => (a.date === b.date ? a.assignmentId.localeCompare(b.assignmentId) : a.date < b.date ? 1 : -1));
  }

  private readScopes(user: AuthedUser): EffectiveScope[] {
    const assignment = resolveScope(user.access, "assignment:read");
    const report = resolveScope(user.access, "report:read");
    if (!report) throw new ForbiddenException();
    // No assignment:read: the caller can read no assignment, so the report is empty (not an error).
    return assignment ? [assignment, report] : [];
  }

  async joiningsExits(user: AuthedUser, period: ReportPeriod) {
    const scopes = this.readScopes(user);
    const rows = scopes.length ? await this.rows(user, period, scopes, EXPORT_ROW_CAP + 1) : [];
    const items = this.items(rows, period);
    const joinings = items.filter((i) => i.kind === "joining");
    const exits = items.filter((i) => i.kind === "exit");
    const exitsByReason: Record<string, number> = { completed: 0, terminated: 0, resigned: 0, bgc_failed: 0 };
    for (const e of exits) if (e.endReason) exitsByReason[e.endReason] = (exitsByReason[e.endReason] ?? 0) + 1;
    const byTeam = new Map<string, { team: ReportItem["team"]; joinings: number; exits: number }>();
    for (const i of items) {
      const key = i.team?.id ?? "";
      const g = byTeam.get(key) ?? { team: i.team, joinings: 0, exits: 0 };
      if (i.kind === "joining") g.joinings++; else g.exits++;
      byTeam.set(key, g);
    }
    return {
      from: period.from,
      to: period.to,
      totals: {
        joinings: joinings.length,
        firstPlacements: joinings.filter((j) => j.isFirstPlacement).length,
        exits: exits.length,
        exitsByReason,
      },
      byTeam: [...byTeam.values()].sort((a, b) => (b.joinings + b.exits) - (a.joinings + a.exits) || (a.team?.name ?? "~").localeCompare(b.team?.name ?? "~")),
      items: items.slice(0, REPORT_VIEW_CAP),
      truncated: items.length > REPORT_VIEW_CAP || rows.length > EXPORT_ROW_CAP,
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
    const scopes = this.readScopes(user);
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
    const rows = scopes.length
      ? await this.rows(user, period, [...scopes, exportScope], EXPORT_ROW_CAP + 1, audit)
      : await this.db.withUser(user.id, async (c) => { await audit(c, []); return [] as Row[]; });
    const truncated = truncatedOf(rows, period);
    const page = this.items(rows.slice(0, EXPORT_ROW_CAP), period).slice(0, EXPORT_ROW_CAP);
    const csv = toCsv(
      ["Event", "Date", "Candidate", "Assignment no.", "Client", "Team", "Recruiter", "Location", "First placement", "End reason"],
      page.map((i) => [
        i.kind === "joining" ? "Joining" : "Exit", i.date, i.candidate.name ?? "(not visible)", i.assignmentNo, i.client,
        i.team?.name ?? "", i.recruiter ?? "", i.location ?? "", i.isFirstPlacement ? "Yes" : "No", i.endReason ? label(i.endReason) : "",
      ]),
    );
    return { csv, rows: page.length, truncated };
  }
}
