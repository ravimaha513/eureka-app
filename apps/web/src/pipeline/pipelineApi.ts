/**
 * Typed client for submissions (apps/api/src/modules/submissions), interviews
 * (create only) and placements (docs/placements-api.md).
 */
import { api } from "../api";

export interface Page<T> { items: T[]; nextCursor: string | null }
export interface Ref { id: string; name: string }

export const SUBMISSION_STATUSES = [
  "submitted", "under_review", "interview_requested", "interview_scheduled",
  "interview_completed", "selected", "rejected", "withdrawn",
] as const;
export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number];

/** Per-record hints (docs/placements-api.md); the server still enforces every rule. */
export interface SubmissionActions { transition: string[]; createInterview: boolean; createPlacement: boolean }

export interface Submission {
  id: string;
  candidateId: string;
  candidateName: string | null;
  recruiterId: string;
  recruiterName: string | null;
  teamId: string | null;
  locationId: string | null;
  jobTitle: string;
  clientId: string;
  client: string;
  vendorId: string | null;
  /** Present only when rate:read covers the submission; the key is otherwise omitted. */
  rate?: number | null;
  status: string;
  rejectionReason: string | null;
  submittedAt: string;
  statusChangedAt: string | null;
  actions?: SubmissionActions;
}

export interface SubmissionFilters {
  status?: string;
  candidateId?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
}

export const PLACEMENT_STATUSES = ["confirmed", "paperwork", "bgc", "ready", "joined", "backout", "bgc_failed"] as const;
export type PlacementType = "c2c" | "w2" | "1099";
export type WorkMode = "onsite" | "remote" | "hybrid";
export type ContactKind = "vendor_poc" | "invoicing_poc" | "client_manager";

export interface PlacementContact { kind: ContactKind; name: string; email?: string | null; phone?: string | null }
/** One paperwork checklist item, copied from the template of the placement type when the placement was created. */
export interface ChecklistItem { docType: string; ownerRole: string; required: boolean; status: string }
export interface Assignment { assignmentNo: number; startDate: string | null; endDate: string | null; endReason: string | null }

export interface Placement {
  id: string;
  status: string;
  placementType: PlacementType;
  workMode: WorkMode;
  projectCity: string | null;
  projectState: string | null;
  tentativeStart: string;
  isFirstPlacement: boolean;
  /** Present only when rate:read covers the placement (PL-6). */
  rate?: number | null;
  candidate: Ref;
  recruiter: Ref;
  team: Ref;
  location: Ref;
  client: Ref;
  vendor: Ref | null;
  submissionId: string;
  createdAt: string;
  statusChangedAt: string | null;
  allowedTransitions: string[];
  contacts?: PlacementContact[];
  /** Detail only (GET /placements/:id); absent on older servers. */
  checklist?: ChecklistItem[];
  assignment?: Assignment | null;
}

export interface CreatePlacement {
  submissionId: string;
  placementType: PlacementType;
  rate?: number;
  workMode: WorkMode;
  projectCity?: string;
  projectState?: string;
  tentativeStart: string;
  implementationPartnerId?: string;
  contacts?: { kind: ContactKind; name: string; email?: string; phone?: string }[];
}

export interface PlacementFilters { status?: string; from?: string; to?: string; cursor?: string; limit?: number }

export interface CreateInterview {
  submissionId: string; round: string; startsAt: string; endsAt: string; coachId?: string; inviteReceived?: boolean;
}

export const PLACEMENT_TYPE_LABELS: Record<PlacementType, string> = { c2c: "C2C", w2: "W2", "1099": "1099" };
export const WORK_MODE_LABELS: Record<WorkMode, string> = { onsite: "Onsite", remote: "Remote", hybrid: "Hybrid" };
export const CONTACT_KIND_LABELS: Record<ContactKind, string> = {
  vendor_poc: "Vendor POC", invoicing_poc: "Invoicing POC", client_manager: "Client manager",
};
const LABELS: Record<string, string> = { bgc: "BGC", bgc_failed: "BGC failed" };
export const pipelineLabel = (s: string) => {
  if (LABELS[s]) return LABELS[s]!;
  const t = s.replace(/_/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
};

const enc = encodeURIComponent;
const qs = (f: object) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  return q.toString();
};

export const pipelineApi = {
  submissions: (f: SubmissionFilters) => api<Page<Submission>>(`/api/v1/submissions?${qs({ limit: 50, ...f })}`),
  submission: (id: string) => api<Submission>(`/api/v1/submissions/${enc(id)}`),
  changeSubmissionStatus: (id: string, to: string, rejectionReason?: string) =>
    api<{ id: string; status: string }>(`/api/v1/submissions/${enc(id)}/status`, {
      method: "PATCH", body: JSON.stringify({ to, ...(rejectionReason ? { rejectionReason } : {}) }),
    }),
  createInterview: (b: CreateInterview) => api<{ id: string }>("/api/v1/interviews", { method: "POST", body: JSON.stringify(b) }),
  placements: (f: PlacementFilters) => api<Page<Placement>>(`/api/v1/placements?${qs({ limit: 50, ...f })}`),
  placement: (id: string) => api<Placement>(`/api/v1/placements/${enc(id)}`),
  createPlacement: (b: CreatePlacement, idempotencyKey: string) =>
    api<{ id: string; isFirstPlacement: boolean }>("/api/v1/placements", {
      method: "POST", body: JSON.stringify(b), headers: { "Idempotency-Key": idempotencyKey },
    }),
  changePlacementStatus: (id: string, to: string, reason?: string) =>
    api<{ id: string; status: string }>(`/api/v1/placements/${enc(id)}/status`, {
      method: "PATCH", body: JSON.stringify({ to, ...(reason ? { reason } : {}) }),
    }),
};

export const pipelineKeys = {
  submissions: ["submissions"] as const,
  submission: (id: string) => ["submissions", "detail", id] as const,
  placements: ["placements"] as const,
  placement: (id: string) => ["placements", "detail", id] as const,
};

/** Local midnight of a YYYY-MM-DD day (or of the following day) as an ISO instant. */
export function dayBoundary(day: string, next = false) {
  const d = new Date(`${day}T00:00:00`);
  if (next) d.setDate(d.getDate() + 1);
  return d.toISOString();
}

export const fmtDateTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—";

export const fmtRate = (r: number | null | undefined) => (r === null || r === undefined ? "—" : `$${r.toFixed(2)}/hr`);
