import { ForbiddenException, HttpException, HttpStatus, Injectable, ServiceUnavailableException } from "@nestjs/common";
import type pg from "pg";
import { z } from "zod";
import { GRANTS, resolveScope, type EffectiveScope, type Permission, type UserAccess } from "@eureka/shared";
import { AuditService } from "../../platform/audit.service.js";
import type { AuthedUser } from "../../platform/auth.guard.js";
import { DbService } from "../../platform/db.service.js";
import { RateLimiter } from "../../platform/rate-limit.js";
import { validTimeZone } from "../../platform/time-zone.js";
import { scopePredicate } from "../candidates/candidates.service.js";
import { toCsv } from "../hotlist/csv.js";
import { EXPORTS_PER_WINDOW, EXPORT_WINDOW_MS } from "../hotlist/hotlist.service.js";
import { activityPredicate } from "../submissions/submissions.service.js";
import { QueryInstant } from "../submissions/pipeline.js";
import {
  DASHBOARD_THRESHOLDS,
  DEFAULT_PERIOD_DAYS,
  MAX_PERIOD_DAYS,
  DASHBOARD_REQUESTS_PER_MINUTE,
  MAX_GROUPS,
  NEEDS_ATTENTION_LIMIT,
} from "./dashboard.config.js";

const DAY_MS = 86_400_000;

/**
 * `manager` (sales reports by manager) and `candidate` (location sales view:
 * submissions, interviews and cleared calls per candidate) since migration 0160.
 */
export const GROUP_BY = ["recruiter", "team", "location", "manager", "candidate"] as const;
export type GroupBy = (typeof GROUP_BY)[number];

export const DashboardQuery = z
  .object({
    from: QueryInstant.optional(),
    to: QueryInstant.optional(),
    groupBy: z.enum(GROUP_BY).optional(),
    /** IANA time zone the daily series is bucketed in (the client's); default UTC. */
    tz: z.string().max(64).refine(validTimeZone, "unknown time zone").optional(),
  })
  .strict();
export type DashboardQuery = z.infer<typeof DashboardQuery>;

/**
 * Activity metrics. Each is counted over the rows the caller could list with
 * the read permission named here (same predicate as the list endpoint, and
 * RLS underneath), narrowed to the caller's report:read scope.
 */
export const METRICS = {
  submissions: "submission:read",
  interviewsScheduled: "interview:read",
  interviewsCleared: "interview:read",
  placementsCreated: "placement:read",
  placementsJoined: "placement:read",
  candidatesAdded: "candidate:read",
} as const satisfies Record<string, Permission>;
export type Metric = keyof typeof METRICS;
const METRIC_KEYS = Object.keys(METRICS) as Metric[];

/** Must match the partial indexes in migration 0027. */
const OPEN_SUBMISSION_SQL = `('submitted', 'under_review', 'interview_requested', 'interview_scheduled', 'interview_completed')`;
const OPEN_PLACEMENT_SQL = `('confirmed', 'paperwork', 'bgc', 'ready')`;
/** Interviews that happen (or happened): not cancelled, rescheduled or without an invite. */
const LIVE_INTERVIEW_SQL = `NOT IN ('cancelled', 'rescheduled', 'no_invite')`;

const SCOPE_RANK = { own: 0, coached: 0, coached_hierarchy: 0, team: 0, hierarchy: 1, location: 2, org: 3 } as const;

/**
 * The natural grouping for the caller's broadest report:read grant: recruiters for a lead, teams for a manager,
 * candidates for a location role (the location sales view, migration 0160), locations at org scope.
 */
export function defaultGroupBy(access: UserAccess): GroupBy {
  let rank = 0;
  for (const a of access.roles) {
    const s = GRANTS[a.role]["report:read"];
    if (s) rank = Math.max(rank, SCOPE_RANK[s]);
  }
  return rank === 3 ? "location" : rank === 2 ? "candidate" : rank === 1 ? "team" : "recruiter";
}

/** Normalizes the period: default the last DEFAULT_PERIOD_DAYS; from < to; at most MAX_PERIOD_DAYS. */
export function resolvePeriod(q: Pick<DashboardQuery, "from" | "to">, now = Date.now()): { from: Date; to: Date } {
  const to = q.to ? new Date(q.to) : new Date(now);
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - DEFAULT_PERIOD_DAYS * DAY_MS);
  if (!(from.getTime() < to.getTime())) throw new z.ZodError([{ code: "custom", path: ["to"], message: "to must be after from" }]);
  if (to.getTime() - from.getTime() > MAX_PERIOD_DAYS * DAY_MS) {
    throw new z.ZodError([{ code: "custom", path: ["from"], message: `the period can cover at most ${MAX_PERIOD_DAYS} days` }]);
  }
  return { from, to };
}

/** CSV headings and the label of the null group, per grouping. */
const GROUP_LABELS: Record<GroupBy, string> = {
  recruiter: "Recruiter", team: "Team", location: "Location", manager: "Manager", candidate: "Candidate",
};
const UNGROUPED: Record<GroupBy, string> = {
  recruiter: "Unassigned", team: "No team", location: "No location", manager: "No manager", candidate: "No candidate",
};
const METRIC_LABELS: Record<Metric, string> = {
  submissions: "Submissions", interviewsScheduled: "Interviews", interviewsCleared: "Interviews cleared",
  placementsCreated: "Placements", placementsJoined: "Joined", candidatesAdded: "Candidates added",
};

type Params = unknown[];
const bind = (params: Params) => (v: unknown) => { params.push(v); return `$${params.length}`; };

/** Ownership-only predicate on a candidate alias (no all-teams rule), for the report:read narrowing. */
const ownsCandidateSql = (scope: EffectiveScope, params: Params, alias: string) =>
  scope.all ? "true" : scopePredicate({ ...scope, allTeams: false, hotlistOpen: false }, params, alias);

interface Scopes {
  report: EffectiveScope;
  read: Partial<Record<Permission, EffectiveScope>>;
}

/** WHERE fragments for an activity table: the list predicate for `perm`, narrowed to report:read. */
function activityWhere(s: Scopes, perm: Permission, params: Params, alias: string): string | null {
  const read = s.read[perm];
  if (!read) return null;
  const parts = [activityPredicate(read, params, alias, "c")];
  if (!s.report.all) parts.push(activityPredicate(s.report, params, alias, "c"));
  return parts.join(" AND ");
}

/** `by`: 'k' rows are per group key, 'd' rows are per local day (`d` is a yyyy-mm-dd string). */
interface CountRow { by: "k" | "d"; m: Metric; k: string | null; d: string | null; n: number }

/** Every yyyy-mm-dd from the local day of `from` to the local day of the last instant before `to`. */
export function localDays(from: Date, to: Date, tz: string): string[] {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const first = fmt.format(from);
  const last = fmt.format(new Date(to.getTime() - 1));
  const out: string[] = [];
  for (let t = Date.parse(`${first}T00:00:00Z`); t <= Date.parse(`${last}T00:00:00Z`); t += DAY_MS) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

export interface AttentionItem {
  id: string;
  candidate: { id: string; name: string | null };
  recruiter: { id: string; name: string | null };
  /** When the clock started: last status change, or interview end. */
  since: string;
  ageDays: number;
  status: string;
  detail: Record<string, string | null>;
}
export type AttentionKind = "submissionStale" | "interviewFeedbackMissing" | "placementStalled";

@Injectable()
export class DashboardService {
  /** Per-user limit on these expensive queries (design A6.5). */
  private readonly limiter = new RateLimiter(DASHBOARD_REQUESTS_PER_MINUTE, 60_000);
  private readonly exportLimiter = new RateLimiter(EXPORTS_PER_WINDOW, EXPORT_WINDOW_MS);

  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  async get(user: AuthedUser, q: DashboardQuery) {
    return this.run(user, q, "view");
  }

  /**
   * Sales report CSV (migration 0160): the grouped activity counts of the
   * dashboard for the same period, grouping and scope, plus a total row.
   * report:read and report:export; rate-limited and audited (grouping,
   * period and counts only).
   */
  async exportCsv(user: AuthedUser, q: DashboardQuery): Promise<{ csv: string; rows: number; truncated: boolean }> {
    if (!resolveScope(user.access, "report:export")) throw new ForbiddenException();
    const d = await this.run(user, q, "export");
    const csv = toCsv(
      [GROUP_LABELS[d.groupBy], ...d.metrics.map((m) => METRIC_LABELS[m])],
      [
        ...d.groups.map((g) => [g.id === null ? UNGROUPED[d.groupBy] : g.name ?? "(not visible)", ...d.metrics.map((m) => g.counts[m])]),
        ["Total", ...d.metrics.map((m) => d.totals[m])],
      ],
    );
    return { csv, rows: d.groups.length, truncated: d.groupsTruncated };
  }

  private async run(user: AuthedUser, q: DashboardQuery, mode: "view" | "export") {
    const report = resolveScope(user.access, "report:read");
    if (!report) throw new ForbiddenException();
    const { from, to } = resolvePeriod(q);
    const limiter = mode === "export" ? this.exportLimiter : this.limiter;
    if (!limiter.take(user.id)) {
      throw new HttpException(mode === "export" ? "Too many exports; try again in a few minutes"
        : "Too many dashboard requests; try again in a minute", HttpStatus.TOO_MANY_REQUESTS);
    }
    const groupBy = q.groupBy ?? defaultGroupBy(user.access);
    const read: Scopes["read"] = {};
    for (const perm of new Set(Object.values(METRICS))) {
      const scope = resolveScope(user.access, perm);
      if (scope) read[perm] = scope;
    }
    const scopes: Scopes = { report, read };
    const metrics = METRIC_KEYS.filter((m) => read[METRICS[m]]);

    try {
      return await this.load(user, scopes, metrics, groupBy, from, to, q.tz ?? "UTC", mode);
    } catch (err) {
      // query_canceled: the statement timeout fired. Mapped here, not globally, so other endpoints keep their behaviour.
      if ((err as { code?: string }).code === "57014") {
        throw new ServiceUnavailableException("The report took too long; narrow the period and try again");
      }
      throw err;
    }
  }

  private async load(user: AuthedUser, scopes: Scopes, metrics: Metric[], groupBy: GroupBy, from: Date, to: Date, tz: string,
    mode: "view" | "export") {
    const report = scopes.report;
    return this.db.withUser(user.id, async (c) => {
      // Org-wide reports get the longer report timeout (design B4.8 N9).
      if (report.all) await c.query("SET LOCAL statement_timeout = '60s'");
      let counts = metrics.length ? await this.counts(c, scopes, groupBy, from, to, tz) : [];
      if (groupBy === "manager") counts = await this.toManagers(c, counts);
      const names = await this.names(c, groupBy, [...new Set(counts.map((r) => r.k).filter((k): k is string => k !== null))]);
      const zero = () => Object.fromEntries(metrics.map((m) => [m, 0])) as Record<Metric, number>;
      const totals = zero();
      const groups = new Map<string | null, Record<Metric, number>>();
      const days = new Map(localDays(from, to, tz).map((d) => [d, zero()]));
      for (const r of counts) {
        if (r.by === "d") {
          const day = days.get(r.d!);
          if (day) day[r.m] += r.n;
          continue;
        }
        totals[r.m] += r.n;
        const g = groups.get(r.k) ?? zero();
        g[r.m] += r.n;
        groups.set(r.k, g);
      }
      let groupList = [...groups].map(([id, counts]) => ({ id, name: id === null ? null : names.get(id) ?? null, counts }));
      // Per-candidate (or very wide) groupings: keep the MAX_GROUPS most active groups; totals stay exact.
      const groupsTruncated = groupList.length > MAX_GROUPS;
      if (groupsTruncated) {
        const sum = (g: (typeof groupList)[number]) => metrics.reduce((n, m) => n + g.counts[m], 0);
        groupList = groupList.sort((a, b) => sum(b) - sum(a) || String(a.id).localeCompare(String(b.id))).slice(0, MAX_GROUPS);
      }
      groupList.sort((a, b) => (a.name === null ? 1 : b.name === null ? -1 : a.name.localeCompare(b.name) || String(a.id).localeCompare(String(b.id))));
      const period = { from: from.toISOString(), to: to.toISOString() };
      if (mode === "export") {
        await this.audit.record(c, {
          actorId: user.id, action: "dashboard.export", entityType: "report",
          changes: { groupBy, from: period.from, to: period.to, rows: groupList.length, truncated: groupsTruncated, metrics },
        });
        return { period, groupBy, metrics, totals, groups: groupList, groupsTruncated, series: [], needsAttention: null };
      }
      return {
        period,
        groupBy,
        metrics,
        totals,
        groups: groupList,
        /** True when more than MAX_GROUPS groups had activity; `groups` then holds the most active ones. */
        groupsTruncated,
        /** One entry per local day of the period, zero-filled, for the activity-over-time chart. */
        series: [...days].map(([date, counts]) => ({ date, counts })),
        needsAttention: {
          thresholds: DASHBOARD_THRESHOLDS,
          sections: await this.attention(c, scopes),
        },
      };
    });
  }

  /** One round trip: per metric and group key, under RLS with the list predicates. */
  private async counts(c: pg.PoolClient, s: Scopes, groupBy: GroupBy, from: Date, to: Date, tz: string): Promise<CountRow[]> {
    const params: Params = [];
    const p = bind(params);
    const $from = p(from.toISOString());
    const $to = p(to.toISOString());
    const $tz = p(tz);
    /** Group key of an activity row (alias a) or of a candidate row (cand = true), as text. */
    const key = (a: string, cand = false): string => {
      switch (groupBy) {
        case "recruiter": return `${a}.recruiter_id::text`;
        case "team": return `${a}.team_id::text`;
        case "location": return `${a}.location_id::text`;
        case "candidate": return cand ? `${a}.id::text` : `${a}.candidate_id::text`;
        // Resolved to the manager in toManagers: the team's lead, or the recruiter when there is no team.
        case "manager": return `CASE WHEN ${a}.team_id IS NOT NULL THEN 't:' || ${a}.team_id ELSE 'r:' || ${a}.recruiter_id END`;
      }
    };
    const inPeriod = (expr: string) => `${expr} >= ${$from}::timestamptz AND ${expr} < ${$to}::timestamptz`;
    const branches: string[] = [];

    const sub = activityWhere(s, "submission:read", params, "s");
    if (sub) branches.push(`SELECT 'submissions' AS m, ${key("s")} AS k, s.submitted_at AS ts FROM eureka.submission s
      LEFT JOIN eureka.candidate c ON c.id = s.candidate_id WHERE ${sub} AND ${inPeriod("s.submitted_at")}`);

    const int = activityWhere(s, "interview:read", params, "i");
    if (int) {
      branches.push(`SELECT 'interviewsScheduled', ${key("i")}, i.starts_at FROM eureka.interview i
        LEFT JOIN eureka.candidate c ON c.id = i.candidate_id
        WHERE ${int} AND ${inPeriod("i.starts_at")} AND i.call_status ${LIVE_INTERVIEW_SQL}`);
      branches.push(`SELECT 'interviewsCleared', ${key("i")}, i.cleared_at FROM eureka.interview i
        LEFT JOIN eureka.candidate c ON c.id = i.candidate_id
        WHERE ${int} AND i.cleared AND ${inPeriod("i.cleared_at")}`);
    }

    const pl = activityWhere(s, "placement:read", params, "pl");
    if (pl) {
      branches.push(`SELECT 'placementsCreated', ${key("pl")}, pl.created_at FROM eureka.placement pl
        LEFT JOIN eureka.candidate c ON c.id = pl.candidate_id WHERE ${pl} AND ${inPeriod("pl.created_at")}`);
      branches.push(`SELECT 'placementsJoined', ${key("pl")}, pl.joined_at FROM eureka.placement pl
        LEFT JOIN eureka.candidate c ON c.id = pl.candidate_id
        WHERE ${pl} AND pl.joined_at IS NOT NULL AND ${inPeriod("pl.joined_at")}`);
    }

    const candRead = s.read["candidate:read"];
    if (candRead) {
      const where = [scopePredicate(candRead, params, "c")];
      if (!s.report.all) where.push(ownsCandidateSql(s.report, params, "c"));
      branches.push(`SELECT 'candidatesAdded', ${key("c", true)}, c.created_at FROM eureka.candidate c
        WHERE ${where.join(" AND ")} AND ${inPeriod("c.created_at")}`);
    }

    // One scan, two groupings: per group key, and per local day in the caller's time zone.
    const sql = `SELECT CASE WHEN GROUPING(k) = 0 THEN 'k' ELSE 'd' END AS by, m, k, d::text AS d, count(*)::int AS n
      FROM (SELECT m, k, (ts AT TIME ZONE ${$tz}::text)::date AS d FROM (${branches.join("\nUNION ALL\n")}) x(m, k, ts)) y
      GROUP BY GROUPING SETS ((m, k), (m, d))`;
    return (await c.query<CountRow>(sql, params)).rows;
  }

  /**
   * Sales reports by manager: each team (snapshot) maps to the nearest user at
   * or above its lead in the current reporting lines who holds the manager
   * role; activity without a team maps from its recruiter the same way. No
   * such user: the "No manager" group (null). Org reference tables only.
   */
  private async toManagers(c: pg.PoolClient, rows: CountRow[]): Promise<CountRow[]> {
    const keys = [...new Set(rows.map((r) => r.k).filter((k): k is string => k !== null))];
    if (!keys.length) return rows;
    const teams = keys.filter((k) => k.startsWith("t:")).map((k) => k.slice(2));
    const users = keys.filter((k) => k.startsWith("r:")).map((k) => k.slice(2));
    const { rows: map } = await c.query<{ key: string; manager_id: string | null }>(
      `WITH start AS (
         SELECT 't:' || t.id AS key, t.lead_id AS u FROM eureka.team t WHERE t.id = ANY($1::uuid[])
         UNION ALL SELECT 'r:' || r, r FROM pg_catalog.unnest($2::uuid[]) r)
       SELECT st.key, (
         SELECT m.id FROM (SELECT st.u AS id, 0 AS depth
                           UNION ALL SELECT rc.ancestor_id, rc.depth FROM eureka.reporting_closure rc WHERE rc.descendant_id = st.u) m
         WHERE EXISTS (SELECT 1 FROM eureka.user_role ur
                       WHERE ur.user_id = m.id AND ur.role_key = 'manager' AND ur.valid @> pg_catalog.now())
         ORDER BY m.depth, m.id LIMIT 1) AS manager_id
       FROM start st`, [teams, users]);
    const managerOf = new Map(map.map((r) => [r.key, r.manager_id]));
    return rows.map((r) => ({ ...r, k: r.k === null ? null : managerOf.get(r.k) ?? null }));
  }

  private async names(c: pg.PoolClient, groupBy: GroupBy, ids: string[]): Promise<Map<string, string>> {
    if (!ids.length) return new Map();
    const sql = {
      recruiter: `SELECT id, display_name AS name FROM eureka.app_user WHERE id = ANY($1::uuid[])`,
      manager: `SELECT id, display_name AS name FROM eureka.app_user WHERE id = ANY($1::uuid[])`,
      team: `SELECT id, name FROM eureka.team WHERE id = ANY($1::uuid[])`,
      location: `SELECT id, name FROM eureka.location WHERE id = ANY($1::uuid[])`,
      // Under RLS: a candidate the caller cannot read keeps its counts but no name.
      candidate: `SELECT c.id, p.first_name || ' ' || p.last_name AS name FROM eureka.candidate c
                  JOIN eureka.person p ON p.id = c.person_id WHERE c.id = ANY($1::uuid[])`,
    }[groupBy];
    return new Map((await c.query<{ id: string; name: string }>(sql, [ids])).rows.map((r) => [r.id, r.name]));
  }

  /** Current state, independent of the period. Each list carries its exact total and the oldest rows first. */
  private async attention(c: pg.PoolClient, s: Scopes) {
    const t = DASHBOARD_THRESHOLDS;
    const sections: { kind: AttentionKind; total: number; items: AttentionItem[] }[] = [];
    type Row = {
      id: string; candidate_id: string; candidate_name: string | null; recruiter_id: string; recruiter_name: string | null;
      since: Date; status: string; total: number; d1: string | null; d2: string | null;
    };
    const run = async (kind: AttentionKind, build: (params: Params) => string | null, detail: (r: Row) => Record<string, string | null>) => {
      const params: Params = [];
      const sql = build(params);
      if (!sql) return;
      params.push(NEEDS_ATTENTION_LIMIT);
      const rows = (await c.query<Row>(`${sql} LIMIT $${params.length}`, params)).rows;
      const now = Date.now();
      sections.push({
        kind,
        total: rows[0]?.total ?? 0,
        items: rows.map((r) => ({
          id: r.id,
          candidate: { id: r.candidate_id, name: r.candidate_name },
          recruiter: { id: r.recruiter_id, name: r.recruiter_name },
          since: r.since.toISOString(),
          ageDays: Math.max(0, Math.floor((now - r.since.getTime()) / DAY_MS)),
          status: r.status,
          detail: detail(r),
        })),
      });
    };
    const people = (alias: string) => `
      ${alias}.candidate_id, CASE WHEN p.id IS NOT NULL THEN p.first_name || ' ' || p.last_name END AS candidate_name,
      ${alias}.recruiter_id, ru.display_name AS recruiter_name, count(*) OVER ()::int AS total`;
    const joins = (alias: string) => `
      LEFT JOIN eureka.candidate c ON c.id = ${alias}.candidate_id
      LEFT JOIN eureka.person p ON p.id = c.person_id
      LEFT JOIN eureka.app_user ru ON ru.id = ${alias}.recruiter_id`;

    await run("submissionStale", (params) => {
      const where = activityWhere(s, "submission:read", params, "s");
      if (!where) return null;
      const p = bind(params);
      return `SELECT s.id, coalesce(s.status_changed_at, s.submitted_at) AS since, s.status, cl.name AS d1, s.job_title AS d2, ${people("s")}
        FROM eureka.submission s ${joins("s")} JOIN eureka.client cl ON cl.id = s.client_id
        WHERE ${where} AND s.status IN ${OPEN_SUBMISSION_SQL}
          AND coalesce(s.status_changed_at, s.submitted_at) < now() - make_interval(days => ${p(t.staleSubmissionDays)}::int)
        ORDER BY since, s.id`;
    }, (r) => ({ client: r.d1, jobTitle: r.d2 }));

    await run("interviewFeedbackMissing", (params) => {
      const where = activityWhere(s, "interview:read", params, "i");
      if (!where) return null;
      const p = bind(params);
      // interview_feedback is readable wherever the interview is (0017), so NOT EXISTS sees every staff note.
      return `SELECT i.id, i.ends_at AS since, i.call_status AS status, i.round AS d1, cl.name AS d2, ${people("i")}
        FROM eureka.interview i ${joins("i")} LEFT JOIN eureka.client cl ON cl.id = i.client_id
        WHERE ${where} AND i.call_status ${LIVE_INTERVIEW_SQL}
          AND i.ends_at < now() - make_interval(hours => ${p(t.feedbackGraceHours)}::int)
          AND i.ends_at >= now() - make_interval(days => ${p(t.feedbackLookbackDays)}::int)
          AND NOT EXISTS (SELECT 1 FROM eureka.interview_feedback f WHERE f.interview_id = i.id AND f.kind <> 'candidate')
        ORDER BY since, i.id`;
    }, (r) => ({ round: r.d1, client: r.d2 }));

    await run("placementStalled", (params) => {
      const where = activityWhere(s, "placement:read", params, "pl");
      if (!where) return null;
      const p = bind(params);
      return `SELECT pl.id, coalesce(pl.status_changed_at, pl.created_at) AS since, pl.status,
          pl.tentative_start::text AS d1,
          CASE WHEN pl.tentative_start < current_date THEN 'start_date_passed' ELSE 'no_progress' END AS d2, ${people("pl")}
        FROM eureka.placement pl ${joins("pl")}
        WHERE ${where} AND pl.status IN ${OPEN_PLACEMENT_SQL}
          AND (coalesce(pl.status_changed_at, pl.created_at) < now() - make_interval(days => ${p(t.placementStallDays)}::int)
               OR pl.tentative_start < current_date)
        ORDER BY since, pl.id`;
    }, (r) => ({ tentativeStart: r.d1, reason: r.d2 }));

    return sections;
  }
}
