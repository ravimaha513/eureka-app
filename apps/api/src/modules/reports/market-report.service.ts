import { ForbiddenException, HttpException, HttpStatus, Injectable, ServiceUnavailableException } from "@nestjs/common";
import type pg from "pg";
import {
  IN_MARKET_STATUSES, MARKET_REPORT_STATUSES, MARKET_REPORT_TIME_ZONE, PLACED_STATUSES, resolveScope,
  type CandidateStatus, type MarketReportGroup,
} from "@eureka/shared";
import { AuditService } from "../../platform/audit.service.js";
import type { AuthedUser } from "../../platform/auth.guard.js";
import { DbService } from "../../platform/db.service.js";
import { RateLimiter } from "../../platform/rate-limit.js";
import { toCsv } from "../hotlist/csv.js";
import { EXPORTS_PER_WINDOW, EXPORT_WINDOW_MS } from "../hotlist/hotlist.service.js";
import type { MarketReportQuery } from "./market-report.schemas.js";

/**
 * CEO market reports (gap L3, docs/market-reports-api.md). Point-in-time
 * candidate counts per group and marketing status, from authz.market_report
 * (migration 0120): it runs as the caller under RLS and narrows to the
 * caller's report.market:read ownership (and report:export for the CSV) in
 * the database. Only counts and group labels leave it.
 */

/** JSON report requests per user per minute (org-wide scans; design A6.5). */
export const MARKET_REPORT_VIEWS_PER_MINUTE = 30;

interface Row { group_id: string | null; group_name: string | null; marketing_status: string; candidates: number; placed_in_period: number | null }

export interface MarketCounts {
  candidates: number;
  inMarket: number;
  placed: number;
  /** null when no "placed between" period was asked for. */
  placedInPeriod: number | null;
  byStatus: Record<CandidateStatus, number>;
}
export interface MarketGroup extends MarketCounts { id: string | null; name: string | null }

const IN_MARKET = new Set<string>(IN_MARKET_STATUSES);
const PLACED = new Set<string>(PLACED_STATUSES);

const GROUP_LABEL: Record<MarketReportGroup, string> = {
  technology: "Technology", batch: "Batch", location: "Location", team: "Team", lead: "Lead", recruiter: "Recruiter",
};
/** Shown for candidates without a value for the grouping (recruiter and batch are optional). */
const NO_VALUE: Record<MarketReportGroup, string> = {
  technology: "No technology", batch: "No batch", location: "No location", team: "No team", lead: "No lead", recruiter: "Unassigned",
};
const statusLabel = (s: string) => { const t = s.replace(/_/g, " "); return t.charAt(0).toUpperCase() + t.slice(1); };

function zero(withPeriod: boolean): MarketCounts {
  return {
    candidates: 0, inMarket: 0, placed: 0, placedInPeriod: withPeriod ? 0 : null,
    byStatus: Object.fromEntries(MARKET_REPORT_STATUSES.map((s) => [s, 0])) as Record<CandidateStatus, number>,
  };
}

function add(into: MarketCounts, r: Row) {
  into.candidates += r.candidates;
  if (IN_MARKET.has(r.marketing_status)) into.inMarket += r.candidates;
  if (PLACED.has(r.marketing_status)) into.placed += r.candidates;
  if (into.placedInPeriod !== null) into.placedInPeriod += r.placed_in_period ?? 0;
  const k = r.marketing_status as CandidateStatus;
  if (k in into.byStatus) into.byStatus[k] += r.candidates;
}

@Injectable()
export class MarketReportService {
  private readonly viewLimiter = new RateLimiter(MARKET_REPORT_VIEWS_PER_MINUTE, 60_000);
  private readonly exportLimiter = new RateLimiter(EXPORTS_PER_WINDOW, EXPORT_WINDOW_MS);

  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  private async rows(user: AuthedUser, q: MarketReportQuery, forExport: boolean,
    after?: (c: pg.PoolClient, rows: Row[]) => Promise<void>): Promise<Row[]> {
    try {
      return await this.db.withUserExport(user.id, async (c) => {
        const rows = (await c.query<Row>(
          `SELECT group_id, group_name, marketing_status, candidates, placed_in_period FROM authz.market_report($1, $2, $3, $4)`,
          [q.groupBy, q.placedFrom ?? null, q.placedTo ?? null, forExport])).rows;
        if (after) await after(c, rows);
        return rows;
      });
    } catch (err) {
      if ((err as { code?: string }).code === "57014") throw new ServiceUnavailableException("The report took too long. Try again later.");
      throw err;
    }
  }

  private build(q: MarketReportQuery, rows: Row[]) {
    const withPeriod = q.placedFrom !== undefined || q.placedTo !== undefined;
    const totals = zero(withPeriod);
    const groups = new Map<string | null, MarketGroup>();
    for (const r of rows) {
      add(totals, r);
      let g = groups.get(r.group_id);
      if (!g) { g = { id: r.group_id, name: r.group_name, ...zero(withPeriod) }; groups.set(r.group_id, g); }
      add(g, r);
    }
    const list = [...groups.values()].sort((a, b) =>
      a.id === null ? 1 : b.id === null ? -1
        : b.candidates - a.candidates || (a.name ?? "~").localeCompare(b.name ?? "~") || a.id.localeCompare(b.id));
    return { withPeriod, totals, groups: list };
  }

  async get(user: AuthedUser, q: MarketReportQuery) {
    if (!resolveScope(user.access, "report.market:read")) throw new ForbiddenException();
    if (!this.viewLimiter.take(user.id)) {
      throw new HttpException("Too many report requests; try again in a minute", HttpStatus.TOO_MANY_REQUESTS);
    }
    const { withPeriod, totals, groups } = this.build(q, await this.rows(user, q, false));
    return {
      asOf: new Date().toISOString(),
      groupBy: q.groupBy,
      placedBetween: withPeriod ? { from: q.placedFrom ?? null, to: q.placedTo ?? null, timeZone: MARKET_REPORT_TIME_ZONE } : null,
      inMarketStatuses: [...IN_MARKET_STATUSES],
      placedStatuses: [...PLACED_STATUSES],
      statuses: [...MARKET_REPORT_STATUSES],
      totals,
      groups,
    };
  }

  /**
   * CSV of the same table limited to report:export as well, rate-limited like
   * the Hot List export and audited in the same transaction (grouping, period
   * and row count; no candidate data). One line per group plus a total line.
   */
  async exportCsv(user: AuthedUser, q: MarketReportQuery): Promise<{ csv: string; rows: number; truncated: boolean }> {
    if (!resolveScope(user.access, "report.market:read") || !resolveScope(user.access, "report:export")) throw new ForbiddenException();
    if (!this.exportLimiter.take(user.id)) {
      throw new HttpException("Too many exports; try again in a few minutes", HttpStatus.TOO_MANY_REQUESTS);
    }
    let built: ReturnType<MarketReportService["build"]> | undefined;
    await this.rows(user, q, true, async (c, rows) => {
      built = this.build(q, rows);
      await this.audit.record(c, {
        actorId: user.id, action: "report.export", entityType: "candidate",
        changes: {
          report: "market", groupBy: q.groupBy, placedFrom: q.placedFrom ?? null, placedTo: q.placedTo ?? null,
          rows: built.groups.length, candidates: built.totals.candidates, truncated: false,
        },
      });
    });
    const { withPeriod, totals, groups } = built!;
    const header = [GROUP_LABEL[q.groupBy], "Candidates", "In market", "Placed (on project)",
      ...(withPeriod ? [`Placed ${q.placedFrom ?? "…"} to ${q.placedTo ?? "…"}`] : []),
      ...MARKET_REPORT_STATUSES.map(statusLabel)];
    const line = (name: string, g: MarketCounts) => [name, g.candidates, g.inMarket, g.placed,
      ...(withPeriod ? [g.placedInPeriod ?? 0] : []), ...MARKET_REPORT_STATUSES.map((s) => g.byStatus[s])];
    const csv = toCsv(header, [
      ...groups.map((g) => line(g.id === null ? NO_VALUE[q.groupBy] : g.name ?? "(not visible)", g)),
      line("Total", totals),
    ]);
    return { csv, rows: groups.length, truncated: false };
  }
}
