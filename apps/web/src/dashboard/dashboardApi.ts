/** Typed client for GET /api/v1/dashboard (docs/dashboards-api.md). */
import { api } from "../api";
import { fetchCsv } from "../lib/download";

export const METRICS = [
  "submissions", "interviewsScheduled", "interviewsCleared", "placementsCreated", "placementsJoined", "candidatesAdded",
] as const;
export type Metric = (typeof METRICS)[number];
/**
 * `manager` (sales reports by manager) and `candidate` (location sales view) since migration 0160;
 * `coach` and `technology` (placements only) since migration 0580.
 */
export type GroupBy = "recruiter" | "team" | "location" | "manager" | "candidate" | "coach" | "technology";
/** Groupings that count placements only. */
export const PLACEMENT_GROUPS: readonly GroupBy[] = ["coach", "technology"];

/** Placement filters (ids). Either one, or a coach/technology grouping, keeps placement metrics only. */
export interface DashboardFilters { technologyId?: string; coachId?: string }
export interface FilterOptions { coaches: { id: string; name: string }[]; technologies: { id: string; name: string }[] }
export const placementsOnly = (f: DashboardFilters, groupBy: GroupBy | undefined) =>
  Boolean(f.technologyId || f.coachId || (groupBy && PLACEMENT_GROUPS.includes(groupBy)));
export type AttentionKind = "submissionStale" | "interviewFeedbackMissing" | "placementStalled";

export interface AttentionItem {
  id: string;
  candidate: { id: string; name: string | null };
  recruiter: { id: string; name: string | null };
  since: string;
  ageDays: number;
  status: string;
  detail: Record<string, string | null>;
}

export interface Dashboard {
  period: { from: string; to: string };
  groupBy: GroupBy;
  /** Metrics the caller can list; others are absent from totals and groups. */
  metrics: Metric[];
  totals: Partial<Record<Metric, number>>;
  groups: { id: string | null; name: string | null; counts: Partial<Record<Metric, number>> }[];
  /** True when more groups had activity than the server returns (the most active ones are kept); totals stay exact. */
  groupsTruncated?: boolean;
  /** One entry per local day of the period (zero-filled), for the activity-over-time chart. */
  series: { date: string; counts: Partial<Record<Metric, number>> }[];
  needsAttention: {
    thresholds: { staleSubmissionDays: number; feedbackGraceHours: number; feedbackLookbackDays: number; placementStallDays: number };
    sections: { kind: AttentionKind; total: number; items: AttentionItem[] }[];
  };
}

export const METRIC_LABELS: Record<Metric, string> = {
  submissions: "Submissions",
  interviewsScheduled: "Interviews",
  interviewsCleared: "Interviews cleared",
  placementsCreated: "Placements",
  placementsJoined: "Joined",
  candidatesAdded: "Candidates added",
};

/** What each count means (shown under the tile). */
export const METRIC_HINTS: Record<Metric, string> = {
  submissions: "submitted in the period",
  interviewsScheduled: "held or scheduled in the period",
  interviewsCleared: "rounds cleared (L1, L2…) in the period; not placements",
  placementsCreated: "final round passed and confirmed by the client in the period",
  placementsJoined: "candidates who joined",
  candidatesAdded: "new candidate profiles",
};

export const GROUP_LABELS: Record<GroupBy, string> = {
  recruiter: "Recruiter", team: "Team", manager: "Manager", location: "Location", candidate: "Candidate",
  coach: "Coach", technology: "Technology",
};
export const UNGROUPED: Record<GroupBy, string> = {
  recruiter: "Unassigned", team: "No team", manager: "No manager", location: "No location", candidate: "Not visible to you",
  coach: "No coach", technology: "No technology",
};

export const PERIODS = [
  { days: 7, label: "Last 7 days" },
  { days: 30, label: "Last 30 days" },
  { days: 90, label: "Last 90 days" },
] as const;

/** The last `days` whole local days, today included: [midnight days-1 ago, next midnight). */
export function periodRange(days: number, now = new Date()): { from: string; to: string } {
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const from = new Date(to.getFullYear(), to.getMonth(), to.getDate() - days);
  return { from: from.toISOString(), to: to.toISOString() };
}

type DashboardRequest = { from: string; to: string; groupBy?: GroupBy } & DashboardFilters;
/** The optional parameters that are set, as an object. */
const optional = (q: DashboardRequest) => Object.fromEntries(
  (["groupBy", "technologyId", "coachId"] as const).flatMap((k) => (q[k] ? [[k, q[k]!]] : [])));

export const dashboardApi = {
  get: (q: DashboardRequest) => {
    const p = new URLSearchParams({ from: q.from, to: q.to, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, ...optional(q) });
    return api<Dashboard>(`/api/v1/dashboard?${p.toString()}`);
  },
  /** Coach and technology choices: those of the placements the caller counts. */
  filters: () => api<FilterOptions>("/api/v1/dashboard/filters"),
  /** Sales report CSV (grouped counts and a total row); audited by the server, needs report:export. */
  exportCsv: (q: DashboardRequest) =>
    fetchCsv("/api/v1/dashboard/export", {
      from: q.from, to: q.to, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, ...optional(q),
    }, "sales-report.csv"),
};
