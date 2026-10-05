/** Typed client for jobs (docs/jobs-portal-api.md "Jobs"). */
import { ApiError, api } from "../api";
import type { JobKind, RichDoc } from "@eureka/shared";

export interface Named { id: string; name: string | null }
export interface Pay { amount: number; frequency: string; currency: string }

export interface Job {
  id: string;
  kind: JobKind;
  title: string;
  category: string;
  experienceLevel: string;
  employmentType: string;
  workMode: string;
  status: string;
  deadline: string | null;
  workHours: number | null;
  pay: Pay | null;
  payHidden: boolean;
  client: Named | null;
  company: Named | null;
  location: string | null;
  skills: string[];
  requirements: RichDoc | null;
  description: RichDoc | null;
  hiringManager: Named | null;
  publishedToPortal: boolean;
  owner: Named;
  team: Named | null;
  applicants: number;
  createdAt: string;
  updatedAt: string;
  postedAt: string | null;
  rowVersion: number;
  actions: { edit: boolean };
}

export interface JobOptions {
  kinds: JobKind[];
  clients: { id: string; name: string }[];
  staff: { id: string; name: string }[];
}

export interface JobFilters { kind?: string; status?: string; clientId?: string; search?: string; mine?: boolean; cursor?: string; limit?: number }

/** What the job form sends (create: with kind; update: any subset). */
export interface JobInput {
  kind?: JobKind;
  title: string;
  category: string;
  experienceLevel: string;
  employmentType: string;
  workMode: string;
  status: string;
  deadline: string | null;
  workHours: number | null;
  pay: Pay | null;
  clientId: string | null;
  companyId: string | null;
  location: string | null;
  skills: string[];
  requirements: RichDoc | null;
  description: RichDoc | null;
  hiringManagerId: string | null;
  publishedToPortal: boolean;
}

const qs = (f: object) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== "" && v !== false) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

export const jobKeys = { all: ["jobs"] as const, detail: (id: string) => ["jobs", "detail", id] as const, options: ["jobs", "options"] as const, companyOptions: ["jobs", "company-options"] as const };

export const jobsApi = {
  list: (f: JobFilters) => api<{ items: Job[]; nextCursor: string | null }>(`/api/v1/jobs${qs(f)}`),
  get: (id: string) => api<Job>(`/api/v1/jobs/${id}`),
  options: () => api<JobOptions>("/api/v1/jobs/options"),
  /** Company picker (id and name only) for internal openings: HR (job:manage, org scope). */
  companyOptions: () => api<{ companies: { id: string; name: string }[] }>("/api/v1/jobs/company-options"),
  create: (body: JobInput, idempotencyKey: string) =>
    api<{ id: string; rowVersion: number }>("/api/v1/jobs", { method: "POST", body: JSON.stringify(body), headers: { "idempotency-key": idempotencyKey } }),
  update: (id: string, rowVersion: number, body: Partial<JobInput>) =>
    api<Job>(`/api/v1/jobs/${id}`, { method: "PATCH", body: JSON.stringify(body), headers: { "if-match": `"${rowVersion}"` } }),
};

const MESSAGES: Record<string, string> = {
  invalid_skill: "A skill is empty or too long (40 characters at most).",
  invalid_hiring_manager: "Choose an active user as the hiring manager.",
  invalid_client: "Choose a client from the list.",
  client_required: "Choose the client this requirement is for.",
  portal_internal_only: "Only internal openings can be published to the careers portal.",
  idempotency_key_reused: "This job was already submitted with different details. Reload and try again.",
  stale: "Someone else changed this job meanwhile. Close the form and open it again.",
};

export function jobError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.detail && MESSAGES[e.detail]) return MESSAGES[e.detail]!;
    if (e.status === 412) return MESSAGES.stale!;
    if (e.status === 403) return "You don't have permission to do that.";
    if (e.status === 404) return "This job is not available to you.";
    if (e.status === 422) return "Some fields are not valid. Check the form and try again.";
  }
  return "Something went wrong. Try again.";
}
