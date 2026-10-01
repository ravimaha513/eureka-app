/** Typed client for the candidate, Hot List and submission API (apps/api/src/modules/candidates, submissions). */
import { api, apiFetch, type Candidate } from "../api";

export interface CandidateProfile extends Candidate {
  marketingStartDate: string | null;
  /** Masked date of birth ("•• / •• / 1994") on the profile only; never on the Hot List. */
  dobMasked: string | null;
  rowVersion: number;
  /** What the caller may do on this record (docs/placements-api.md). Absent on older servers. */
  actions?: CandidateActions;
}

/** Per-record action hints computed by the authorization engine; the server still enforces every rule. */
export interface CandidateActions {
  edit: boolean;
  /** Allowed target statuses. */
  transition: string[];
  visibility: boolean;
  rating: boolean;
  logSubmission: boolean;
}

export interface Page<T> { items: T[]; nextCursor: string | null }

export type Visibility = "team" | "all_teams";
export type Priority = "P1" | "P2" | "P3";

export interface ListFilters {
  search?: string;
  status?: string;
  technology?: string;
  visibility?: Visibility | "";
  cursor?: string | null;
  limit?: number;
}

/** Profile fields a `candidate:update` holder may change (ProfileUpdate schema; strict). */
export interface ProfileUpdate {
  priority?: Priority;
  marketingEmail?: string;
  vitelNumber?: string;
  marketingStartDate?: string;
  inPersonOk?: boolean;
  technologyId?: string;
}

export interface CreateCandidate {
  firstName: string;
  lastName: string;
  phone?: string;
  technologyId: string;
  locationId: string;
}

export interface CreateSubmission {
  candidateId: string;
  jobTitle: string;
  clientId: string;
  vendorId?: string;
  rate?: number;
}

/** Every marketing status in the domain model, in lifecycle order. */
export const STATUSES = [
  "in_training", "active", "on_hold", "full_of_interviews", "confirmation", "bench", "stopped", "placed", "terminated",
] as const;

/** Statuses shown on the Hot List (HOTLIST_STATUSES in @eureka/shared). */
export const HOTLIST_STATUS_OPTIONS = ["active", "on_hold", "full_of_interviews", "confirmation", "bench", "stopped"] as const;

/**
 * Allowed status changes, mirroring authz.transition_candidate (migration 0015).
 * Presentation only: the database decides and answers 422 for anything else.
 */
export const TRANSITIONS: Record<string, readonly string[]> = {
  in_training: ["active", "terminated"],
  active: ["on_hold", "stopped", "full_of_interviews", "confirmation", "terminated"],
  on_hold: ["active", "terminated"],
  full_of_interviews: ["active", "terminated"],
  confirmation: ["active", "terminated"],
  bench: ["active", "terminated"],
  stopped: ["terminated"],
};

export const statusLabel = (s: string) => {
  const t = s.replace(/_/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
};

const enc = encodeURIComponent;
const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });

function listQuery(f: ListFilters): string {
  const q = new URLSearchParams();
  if (f.search) q.set("search", f.search);
  if (f.status) q.set("status", f.status);
  if (f.technology) q.set("technology", f.technology);
  if (f.visibility) q.set("visibility", f.visibility);
  if (f.cursor) q.set("cursor", f.cursor);
  q.set("limit", String(f.limit ?? 50));
  return q.toString();
}

export const salesApi = {
  hotlist: (f: ListFilters) => api<Page<Candidate>>(`/api/v1/hotlist?${listQuery(f)}`),
  candidates: (f: ListFilters) => api<Page<Candidate>>(`/api/v1/candidates?${listQuery(f)}`),
  candidate: (id: string) => api<CandidateProfile>(`/api/v1/candidates/${enc(id)}`),
  create: (b: CreateCandidate) => api<{ id: string }>("/api/v1/candidates", { method: "POST", ...json(b) }),
  update: (id: string, b: ProfileUpdate) => api<{ id: string }>(`/api/v1/candidates/${enc(id)}`, { method: "PATCH", ...json(b) }),
  setVisibility: (id: string, visibility: Visibility) =>
    api<{ id: string; visibility: Visibility }>(`/api/v1/candidates/${enc(id)}/visibility`, { method: "PUT", ...json({ visibility }) }),
  setRating: (id: string, rating: number) =>
    api<{ id: string; technicalRating: number }>(`/api/v1/candidates/${enc(id)}/technical-rating`, { method: "PUT", ...json({ rating }) }),
  transition: (id: string, to: string) =>
    api<{ id: string; status: string }>(`/api/v1/candidates/${enc(id)}/transition`, { method: "POST", ...json({ to }) }),
  submit: (b: CreateSubmission) =>
    api<{ id: string; duplicateWarning: boolean }>("/api/v1/submissions", { method: "POST", ...json(b) }),
};

/** Filters a saved view stores (the Hot List filters, no paging). */
export interface ViewFilters {
  search?: string;
  status?: string;
  technology?: string;
  visibility?: Visibility;
}

export interface SavedView { id: string; name: string; filters: ViewFilters; createdAt: string; updatedAt: string }

/** Statuses offered in bulk (BULK_STATUSES in apps/api/src/modules/hotlist); terminated and confirmation stay per record. */
export const BULK_STATUS_OPTIONS = ["active", "on_hold", "full_of_interviews", "stopped"] as const;

export type BulkError = "not_found" | "forbidden" | "invalid_transition" | "placement_open" | "failed";
export interface BulkResponse { succeeded: number; failed: number; results: { id: string; ok: boolean; error?: BulkError }[] }

export interface ExportResult { blob: Blob; filename: string; rows: number; truncated: boolean }

/** Only the filters the API accepts, with empty values dropped. */
export function viewFilters(f: ListFilters): ViewFilters {
  const out: ViewFilters = {};
  if (f.search) out.search = f.search;
  if (f.status) out.status = f.status;
  if (f.technology) out.technology = f.technology;
  if (f.visibility) out.visibility = f.visibility;
  return out;
}

export const hotlistApi = {
  views: () => api<{ items: SavedView[] }>("/api/v1/hotlist/views"),
  createView: (name: string, filters: ViewFilters) =>
    api<SavedView>("/api/v1/hotlist/views", { method: "POST", ...json({ name, filters }) }),
  updateView: (id: string, b: { name?: string; filters?: ViewFilters }) =>
    api<SavedView>(`/api/v1/hotlist/views/${enc(id)}`, { method: "PATCH", ...json(b) }),
  deleteView: (id: string) => api<void>(`/api/v1/hotlist/views/${enc(id)}`, { method: "DELETE" }),
  bulkStatus: (ids: string[], to: string) =>
    api<BulkResponse>("/api/v1/hotlist/bulk/status", { method: "POST", ...json({ ids, to }) }),
  bulkVisibility: (ids: string[], visibility: Visibility) =>
    api<BulkResponse>("/api/v1/hotlist/bulk/visibility", { method: "POST", ...json({ ids, visibility }) }),
  /** CSV of the current view; the server caps, masks and audits it. */
  exportCsv: async (filters: ViewFilters): Promise<ExportResult> => {
    const res = await apiFetch("/api/v1/hotlist/export", { method: "POST", ...json(filters) });
    const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "hotlist.csv";
    return {
      blob: await res.blob(),
      filename: name,
      rows: Number(res.headers.get("x-export-rows") ?? 0),
      truncated: res.headers.get("x-export-truncated") === "true",
    };
  },
};

export const salesKeys = {
  hotlist: ["hotlist"] as const,
  candidates: ["candidates"] as const,
  candidate: (id: string) => ["candidate", id] as const,
  hotlistViews: ["hotlist-views"] as const,
};
