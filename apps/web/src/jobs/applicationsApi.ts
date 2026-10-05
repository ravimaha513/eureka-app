/** Typed client for applications, applicants and application interviews (docs/jobs-portal-api.md). */
import { ApiError, api, apiFetch } from "../api";
import type { ApplicationStatus } from "@eureka/shared";
import type { Job, Named } from "./jobsApi";

export interface ApplicantRef { id: string; name: string | null; email: string | null; phone: string | null; phoneMasked: boolean; emailVerified: boolean }

export interface Application {
  id: string;
  status: ApplicationStatus;
  appliedAt: string;
  statusChangedAt: string;
  rowVersion: number;
  overallRating: number | null;
  job: { id: string; title: string | null; kind: string | null };
  company: Named | null;
  applicant: ApplicantRef;
  candidateId: string | null;
  actions: { transition: ApplicationStatus[]; scheduleInterview: boolean; createCandidate: boolean };
}

export interface Scorecard {
  id: string; reviewer: Named; technical: number; communication: number; problemSolving: number; attitude: number; notes: string | null; updatedAt: string;
}

export interface AppInterview {
  id: string; interviewType: string; round: string; lead: Named; panel: { id: string; name: string }[]; startsAt: string;
  durationMinutes: number; meetingLink: string | null; status: string; scorecards: Scorecard[];
  actions: { setStatus: boolean; scorecard: boolean };
}

export interface ApplicationDetail extends Omit<Application, "job"> {
  job: Job | Application["job"];
  interviews: AppInterview[];
  history: { id: string; kind: string; at: string; actor: string | null; fromStatus: string | null; toStatus: string | null; comment: string | null }[];
}

export interface Applicant extends ApplicantRef { createdAt: string; applications: number }

export interface ApplicationFilters { status?: string; jobId?: string; search?: string; cursor?: string; limit?: number }

const qs = (f: object) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};
const post = (body: unknown, headers: Record<string, string> = {}) => ({ method: "POST", body: JSON.stringify(body), headers });

export const applicationKeys = {
  all: ["applications"] as const,
  detail: (id: string) => ["applications", "detail", id] as const,
  applicants: ["applicants"] as const,
};

async function download(path: string, body: unknown, name: string) {
  const res = await apiFetch(path, post(body));
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
  return { rows: Number(res.headers.get("x-export-rows") ?? 0), truncated: res.headers.get("x-export-truncated") === "true" };
}

export const applicationsApi = {
  list: (f: ApplicationFilters) => api<{ items: Application[]; nextCursor: string | null }>(`/api/v1/applications${qs(f)}`),
  get: (id: string) => api<ApplicationDetail>(`/api/v1/applications/${id}`),
  setStatus: (id: string, rowVersion: number, to: ApplicationStatus, comment?: string) =>
    api<{ id: string; status: string; rowVersion: number }>(`/api/v1/applications/${id}/status`,
      post({ to, ...(comment ? { comment } : {}) }, { "if-match": `"${rowVersion}"` })),
  schedule: (id: string, body: { interviewType: string; round: string; leadUserId: string; panelUserIds: string[]; startsAt: string; durationMinutes: number; meetingLink?: string }) =>
    api<{ id: string; applicationStatus: string }>(`/api/v1/applications/${id}/interviews`, post(body)),
  interviewStatus: (id: string, status: string) => api<{ id: string; status: string }>(`/api/v1/application-interviews/${id}/status`, post({ status })),
  setPeople: (id: string, body: { leadUserId: string; panelUserIds: string[] }) =>
    api<{ id: string }>(`/api/v1/application-interviews/${id}/people`, { method: "PUT", body: JSON.stringify(body) }),
  scorecard: (id: string, body: { technical: number; communication: number; problemSolving: number; attitude: number; notes?: string }) =>
    api<{ id: string }>(`/api/v1/application-interviews/${id}/scorecard`, { method: "PUT", body: JSON.stringify(body) }),
  createCandidate: (id: string, body: { technologyId: string; locationId: string; confirmDuplicate?: boolean }) =>
    api<{ candidateId: string }>(`/api/v1/applications/${id}/candidate`, post(body)),
  exportCsv: (f: Omit<ApplicationFilters, "cursor" | "limit">) => download("/api/v1/applications/export", f, "applications.csv"),
  applicants: (f: { search?: string; cursor?: string; limit?: number }) => api<{ items: Applicant[]; nextCursor: string | null }>(`/api/v1/applicants${qs(f)}`),
  exportApplicants: (f: { search?: string }) => download("/api/v1/applicants/export", f, "applicants.csv"),
};

const MESSAGES: Record<string, string> = {
  invalid_transition: "That status change isn't allowed from the current status.",
  stale: "Someone else changed this application meanwhile. Reload it and try again.",
  invalid_interviewer: "Choose active users as the lead and the panel.",
  invalid_slot: "Choose a time that is not in the past.",
  application_closed: "This application is closed; interviews can no longer be scheduled.",
  interview_closed: "This interview was cancelled; it can't be reviewed.",
  application_not_hired: "Only hired applications become candidates.",
  candidate_exists: "A candidate was already created from this application.",
  possible_duplicate: "A candidate with this email or phone may already exist. Check before creating another one.",
  if_match_required: "Reload the application and try again.",
};

export function applicationError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.detail && MESSAGES[e.detail]) return MESSAGES[e.detail]!;
    if (e.status === 412) return MESSAGES.stale!;
    if (e.status === 403) return "You don't have permission to do that.";
    if (e.status === 404) return "This application is not available to you.";
    if (e.status === 422 && e.errors?.length) return e.errors.map((x) => x.message).join(" ");
  }
  return "Something went wrong. Try again.";
}
