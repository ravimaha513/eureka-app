/** Typed client for GET /api/v1/dashboard (docs/dashboards-api.md). */
import { api } from "../api";

export const METRICS = [
  "submissions", "interviewsScheduled", "interviewsCleared", "placementsCreated", "placementsJoined", "candidatesAdded",
] as const;
export type Metric = (typeof METRICS)[number];
export type GroupBy = "recruiter" | "team" | "location";
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
  interviewsCleared: "marked cleared in the period",
  placementsCreated: "confirmed in the period",
  placementsJoined: "candidates who joined",
  candidatesAdded: "new candidate profiles",
};

export const GROUP_LABELS: Record<GroupBy, string> = { recruiter: "Recruiter", team: "Team", location: "Location" };
export const UNGROUPED: Record<GroupBy, string> = { recruiter: "Unassigned", team: "No team", location: "No location" };

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

export const dashboardApi = {
  get: (q: { from: string; to: string; groupBy?: GroupBy }) => {
    const p = new URLSearchParams({ from: q.from, to: q.to });
    if (q.groupBy) p.set("groupBy", q.groupBy);
    return api<Dashboard>(`/api/v1/dashboard?${p.toString()}`);
  },
};
