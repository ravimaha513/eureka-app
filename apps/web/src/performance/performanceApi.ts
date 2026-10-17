/** Typed client for /api/v1/performance and designation changes (docs/performance-api.md). */
import { ApiError, api } from "../api";

export const KINDS = ["submissions", "interviews", "interviewsCleared", "placements", "joined"] as const;
export type Kind = (typeof KINDS)[number];
export type Counts = Record<Kind, number>;
export interface Ratios { submissionToInterview: number | null; interviewToPlacement: number | null; placement: number | null }

export const KIND_LABELS: Record<Kind, string> = {
  submissions: "Submissions", interviews: "Interviews", interviewsCleared: "Cleared", placements: "Placements", joined: "Joined",
};
export const RATIO_LABELS: Record<keyof Ratios, string> = {
  submissionToInterview: "Submission → interview", interviewToPlacement: "Interview → placement", placement: "Placement ratio",
};

export interface PersonRow {
  user: { id: string; name: string; designation: string | null; active: boolean };
  team: { id: string; name: string } | null;
  counts: Counts;
  ratios: Ratios;
}
export interface Summary {
  period: { from: string; to: string };
  kinds: Kind[];
  totals: { counts: Counts; ratios: Ratios };
  people: PersonRow[];
}

export interface ActivityItem {
  id: string; at: string; candidate: { id: string; name: string | null }; recruiter: { id: string; name: string | null };
  team: string | null; client: string | null; status: string; detail: Record<string, string | null>;
}
export interface Activity { kind: Kind; total: number; items: ActivityItem[] }

export interface ActiveCandidate {
  placementId: string; assignmentId: string; candidate: { id: string; name: string | null }; client: string; vendor: string | null;
  implementationPartner: string | null; workMode: string; joiningDate: string; endDate: string | null;
  recruiter: { id: string; name: string | null }; team: string | null; location: string | null;
}
export interface ActiveCandidates { total: number; truncated: boolean; items: ActiveCandidate[] }

export const PERIOD_KINDS = ["week", "month", "quarter"] as const;
export type PeriodKind = (typeof PERIOD_KINDS)[number];
export const PERIOD_KIND_LABELS: Record<PeriodKind, string> = { week: "Week", month: "Month", quarter: "Quarter" };
export type TargetMetric = "submissions" | "interviews" | "placements";
export const TARGET_METRICS: TargetMetric[] = ["submissions", "interviews", "placements"];

export interface Target {
  id: string;
  user: { id: string; name: string | null };
  periodKind: PeriodKind;
  periodStart: string;
  periodEnd: string;
  targets: Record<TargetMetric, number | null>;
  actuals: Record<TargetMetric, number | null>;
  status: "met" | "below" | "inProgress" | "unknown";
  setBy: { id: string; name: string | null };
  updatedAt: string;
  canManage: boolean;
}
export const STATUS_LABELS: Record<Target["status"], string> = { met: "Met", below: "Below target", inProgress: "In progress", unknown: "Not available" };

export interface Person {
  id: string; name: string; designation: string | null; team: { id: string; name: string } | null; memberOfTeamId: string | null;
  canSetTarget: boolean; canChangeDesignation: boolean; canMoveTeam: boolean;
}
export interface People { people: Person[]; moveTeams: { id: string; name: string }[] }

export interface SetTargetBody {
  userId: string; periodKind: PeriodKind; periodStart: string; submissions: number | null; interviews: number | null; placements: number | null;
}

const enc = encodeURIComponent;
const json = (b: unknown) => ({ body: JSON.stringify(b) });
const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Local calendar dates [from, through] as instants: local midnight of `from` to the midnight after `through`. */
export function dayRange(from: string, through: string): { from: string; to: string } {
  const [y1, m1, d1] = from.split("-").map(Number) as [number, number, number];
  const [y2, m2, d2] = through.split("-").map(Number) as [number, number, number];
  return { from: new Date(y1, m1 - 1, d1).toISOString(), to: new Date(y2, m2 - 1, d2 + 1).toISOString() };
}

const period = (r: { from: string; to: string }) => new URLSearchParams({ from: r.from, to: r.to, tz: tz() });

export const performanceKeys = {
  all: ["performance"] as const,
  summary: (r: { from: string; to: string }) => ["performance", "summary", r] as const,
  activity: (r: { from: string; to: string }, kind: Kind, userId: string | null, offset: number) => ["performance", "activity", r, kind, userId, offset] as const,
  active: (r: { from: string; to: string }) => ["performance", "active", r] as const,
  targets: (from: string, through: string) => ["performance", "targets", from, through] as const,
  people: ["performance", "people"] as const,
};

export const ACTIVITY_PAGE = 50;

export const performanceApi = {
  summary: (r: { from: string; to: string }) => api<Summary>(`/api/v1/performance/summary?${period(r).toString()}`),
  activity: (r: { from: string; to: string }, kind: Kind, userId: string | null, offset: number) => {
    const p = period(r);
    p.set("kind", kind);
    if (userId) p.set("userId", userId);
    p.set("offset", String(offset));
    p.set("limit", String(ACTIVITY_PAGE));
    return api<Activity>(`/api/v1/performance/activity?${p.toString()}`);
  },
  active: (r: { from: string; to: string }) => api<ActiveCandidates>(`/api/v1/performance/active-candidates?${period(r).toString()}`),
  targets: (from: string, through: string) =>
    api<{ truncated: boolean; items: Target[] }>(`/api/v1/performance/targets?${new URLSearchParams({ from, through }).toString()}`),
  people: () => api<People>("/api/v1/performance/people"),
  setTarget: (b: SetTargetBody) => api<{ created: boolean; target: Target }>("/api/v1/performance/targets", { method: "PUT", ...json(b) }),
  deleteTarget: (id: string) => api<void>(`/api/v1/performance/targets/${enc(id)}`, { method: "DELETE" }),
  setDesignation: (userId: string, designation: string | null) =>
    api<{ id: string; designation: string | null }>(`/api/v1/users/${enc(userId)}/designation`, { method: "PUT", ...json({ designation }) }),
  moveMember: (fromTeamId: string, userId: string, toTeamId: string) =>
    api<{ movedCandidates: number; reassignedTo: { id: string; displayName: string | null } }>(
      `/api/v1/teams/${enc(fromTeamId)}/move-member`, { method: "POST", ...json({ userId, toTeamId }) }),
};

const MESSAGES: Record<string, string> = {
  not_in_scope: "That person is outside your hierarchy.",
  self_change: "You can't change your own target or designation. Ask your manager.",
  user_inactive: "That person's account is deactivated.",
  invalid_target: "Check the period start and the target numbers.",
  invalid_designation: "Use at most 120 characters, without line breaks.",
  same_team: "They are already in that team.",
  not_a_member: "They are no longer a member of that team. Refresh and try again.",
};

export function performanceError(e: unknown): string {
  if (!(e instanceof ApiError)) return e instanceof Error ? e.message : "Something went wrong.";
  if (e.detail && MESSAGES[e.detail]) return MESSAGES[e.detail]!;
  switch (e.status) {
    case 401: return "Your session ended. Sign in again.";
    case 403: return "You don't have permission to do that.";
    case 404: return "That record no longer exists or is outside your scope. Refresh and try again.";
    case 422: return e.errors?.length ? e.errors.map((x) => x.message).join(" ") : "Check the values and try again.";
    case 429: return e.detail ?? "Too many requests. Try again in a minute.";
    case 503: return e.detail ?? "The report took too long. Choose a shorter period.";
    default: return e.detail ?? e.title ?? e.message ?? "Something went wrong.";
  }
}

/** "66.7%" or "—" when there is nothing to divide by. */
export const pct = (r: number | null) => (r === null ? "—" : `${Math.round(r * 1000) / 10}%`);

/** The start of the period kind that contains `day` (Monday, the 1st, or the quarter's first day). */
export function periodStartOf(kind: PeriodKind, day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  if (kind === "week") d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  else if (kind === "month") d.setUTCDate(1);
  else { d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - (d.getUTCMonth() % 3)); }
  return d.toISOString().slice(0, 10);
}
