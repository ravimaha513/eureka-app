/** Typed client for the pipeline report, assessments, "not responding" flags and preferred vendors (docs/pipeline-vendors-api.md). */
import { ApiError, api } from "../api";

export interface Named { id: string; name: string | null }

export const PIPELINE_STAGES = ["not_started", "marketing", "submitted", "interviewing", "assessment", "confirmed", "paperwork", "joined"] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];
export const STAGE_LABELS: Record<PipelineStage, string> = {
  not_started: "Not started", marketing: "Marketing", submitted: "Submitted", interviewing: "Interviewing",
  assessment: "Assessment", confirmed: "Confirmed", paperwork: "Paperwork", joined: "Joined",
};
/** Funnel tiles in pipeline order (stages reached; the API's `funnel` keys). */
export const FUNNEL = [
  ["marketing", "Marketing started"], ["submitted", "Submitted"], ["interviewing", "Interviewed"], ["assessment", "Assessments"],
  ["confirmed", "Confirmed"], ["paperwork", "Paperwork"], ["joined", "Joined"],
] as const;

export interface PipelineItem {
  candidate: Named;
  technology: Named;
  team: Named;
  recruiter: Named | null;
  location: Named;
  marketingStatus: string;
  marketingStartDate: string | null;
  submissions: { count: number; lastAt: string | null };
  interviews: { count: number; cleared: number; lastAt: string | null };
  assessments: { count: number; passed: number; lastOn: string | null };
  placement: {
    id: string; status: string; confirmedAt: string; tentativeStart: string | null; joinedAt: string | null;
    paperwork: { done: number; total: number } | null;
  } | null;
  notResponding: boolean;
  stage: PipelineStage;
}

export interface PipelineReport {
  period: { from: string; to: string } | null;
  total: number;
  funnel: Record<(typeof FUNNEL)[number][0], number>;
  notResponding: number;
  byStage: Partial<Record<PipelineStage, number>>;
  items: PipelineItem[];
  limit: number;
  offset: number;
}

export interface PipelineFilters {
  from?: string; to?: string; technologyId?: string; locationId?: string; stage?: string; notResponding?: boolean;
  limit?: number; offset?: number;
}

export const ASSESSMENT_PLATFORMS = ["glider", "hackerrank", "codility", "vendor_portal", "other"] as const;
export const ASSESSMENT_STATUSES = ["assigned", "completed", "passed", "failed", "expired", "cancelled"] as const;
export const PLATFORM_LABELS: Record<string, string> = {
  glider: "Glider", hackerrank: "HackerRank", codility: "Codility", vendor_portal: "Vendor portal", other: "Other",
};
export const ASSESSMENT_STATUS_LABELS: Record<string, string> = {
  assigned: "Assigned", completed: "Completed", passed: "Passed", failed: "Failed", expired: "Expired", cancelled: "Cancelled",
};

export interface Assessment {
  id: string; submissionId: string; candidateId: string; platform: string; status: string;
  assignedOn: string; dueOn: string | null; completedOn: string | null; score: number | null;
  createdAt: string; updatedAt: string; rowVersion: number;
}
export interface AssessmentInput {
  platform: string; status: string; assignedOn: string; dueOn: string | null; completedOn: string | null; score: number | null;
}

export const NONRESPONSE_REASONS = ["no_reply_calls", "no_reply_messages", "missed_interview", "missed_assessment", "other"] as const;
export const REASON_LABELS: Record<string, string> = {
  no_reply_calls: "Not answering calls", no_reply_messages: "Not replying to messages", missed_interview: "Missed an interview",
  missed_assessment: "Missed an assessment", other: "Other",
};
export const RESOLUTION_LABELS: Record<string, string> = { responded: "Candidate responded", flagged_in_error: "Flagged in error" };

export interface NonResponseFlag {
  id: string; reason: string; status: "open" | "resolved"; resolution: string | null;
  flaggedAt: string; flaggedBy: string | null; resolvedAt: string | null; holdReachedAt: string | null;
  candidateWarnedAt: string | null; candidateHoldNoticeAt: string | null;
}
export interface NonResponseState {
  current: NonResponseFlag | null;
  history: NonResponseFlag[];
  actions: { flag: boolean; resolve: boolean };
}

export interface PreferredVendor {
  id: string;
  owner: Named;
  vendorName: string;
  vendor: Named | null;
  contactName: string | null; contactEmail: string | null; contactPhone: string | null;
  technology: Named | null;
  clients: string | null; notes: string | null; archived: boolean;
  createdAt: string; updatedAt: string; rowVersion: number;
  actions: { edit: boolean; archive: boolean };
}
export interface PreferredVendorInput {
  vendorName: string; vendorId: string | null; contactName: string | null; contactEmail: string | null; contactPhone: string | null;
  technologyId: string | null; clients: string | null; notes: string | null;
}
export interface PreferredVendorList { items: PreferredVendor[]; total: number; owners: Named[]; actions: { create: boolean } }

const qs = (o: Record<string, string | number | boolean | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};
const json = (method: string, body: unknown, headers: Record<string, string> = {}): RequestInit =>
  ({ method, body: JSON.stringify(body), headers });

export const pvKeys = {
  report: (f: PipelineFilters) => ["pipeline-report", f] as const,
  assessments: (submissionId: string) => ["assessments", submissionId] as const,
  nonResponse: (candidateId: string) => ["non-response", candidateId] as const,
  vendors: ["preferred-vendors"] as const,
  vendorList: (f: Record<string, string | boolean>) => ["preferred-vendors", f] as const,
};

export const pvApi = {
  report: (f: PipelineFilters) => api<PipelineReport>(`/api/v1/reports/pipeline${qs({ ...f })}`),
  assessments: (submissionId: string) =>
    api<{ items: Assessment[]; actions: { create: boolean; update: boolean } }>(`/api/v1/submissions/${submissionId}/assessments`),
  createAssessment: (submissionId: string, body: AssessmentInput) =>
    api<Assessment>(`/api/v1/submissions/${submissionId}/assessments`, json("POST", body)),
  updateAssessment: (a: Pick<Assessment, "id" | "rowVersion">, body: AssessmentInput) =>
    api<Assessment>(`/api/v1/assessments/${a.id}`, json("PATCH", body, { "if-match": `"${a.rowVersion}"` })),
  nonResponse: (candidateId: string) => api<NonResponseState>(`/api/v1/candidates/${candidateId}/non-response`),
  flag: (candidateId: string, reason: string) => api<{ id: string }>(`/api/v1/candidates/${candidateId}/non-response`, json("POST", { reason })),
  resolve: (candidateId: string, resolution: string) =>
    api<{ id: string }>(`/api/v1/candidates/${candidateId}/non-response/resolve`, json("POST", { resolution })),
  vendors: (f: { q?: string; ownerId?: string; archived?: boolean }) => api<PreferredVendorList>(`/api/v1/preferred-vendors${qs(f)}`),
  createVendor: (body: PreferredVendorInput) => api<PreferredVendor>("/api/v1/preferred-vendors", json("POST", body)),
  updateVendor: (v: Pick<PreferredVendor, "id" | "rowVersion">, body: PreferredVendorInput) =>
    api<PreferredVendor>(`/api/v1/preferred-vendors/${v.id}`, json("PATCH", body, { "if-match": `"${v.rowVersion}"` })),
  archiveVendor: (id: string) => api<void>(`/api/v1/preferred-vendors/${id}`, { method: "DELETE" }),
};

/** A readable message for an API error from these endpoints. */
export function pvError(e: unknown): string {
  if (!(e instanceof ApiError)) return "Something went wrong. Try again.";
  switch (e.detail) {
    case "stale": return "Someone else changed this in the meantime. Reload and try again.";
    case "already_flagged": return "The candidate is already flagged as not responding.";
    case "not_flagged": return "The candidate is not flagged as not responding.";
    case "candidate_not_marketed": return "Only candidates in marketing can be flagged.";
    case "submission_closed": return "The submission is closed (rejected or withdrawn).";
    case "completed_on_required": return "Enter the completion date for a completed, passed or failed assessment.";
    case "vendor_exists": return "You already have a preferred vendor with this name.";
    case "limit_reached": return "The limit for this list is reached.";
  }
  if (e.status === 404) return "Not found, or you no longer have access.";
  if (e.status === 403) return "You are not allowed to do this.";
  if (e.status === 422) return e.errors?.[0]?.message ? `Check the form: ${e.errors[0].message}` : "Check the form and try again.";
  if (e.status === 429) return "Too many requests. Try again in a minute.";
  return e.message || "Something went wrong. Try again.";
}
