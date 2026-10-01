/** Typed client for the candidate, Hot List and submission API (apps/api/src/modules/candidates, submissions). */
import { api, type Candidate } from "../api";

export interface CandidateProfile extends Candidate {
  marketingStartDate: string | null;
  /** Masked date of birth ("•• / •• / 1994") on the profile only; never on the Hot List. */
  dobMasked: string | null;
  rowVersion: number;
  /** What the caller may do on this record (docs/placements-api.md). Absent on older servers. */
  actions?: CandidateActions;
  /** Training batch (FR-CAN-02); absent on older servers. */
  batch?: { id: string; label: string } | null;
}

export type BatchStatus = "planned" | "in_training" | "completed" | "cancelled";

/** GET /api/v1/batches item (any candidate:read holder). */
export interface Batch {
  id: string;
  /** "Java · Dallas · Nov 2026" */
  label: string;
  location: { id: string; name: string };
  technology: { id: string; name: string };
  /** YYYY-MM */
  startMonth: string;
  sizePlanned: number | null;
  status: BatchStatus;
  /** Candidates in the batch that the caller can read. */
  candidatesInScope: number;
}

/** `canCreate` is a hint (Sales leadership); the server decides. */
export interface BatchList { items: Batch[]; canCreate: boolean }

export interface CreateBatch { locationId: string; technologyId: string; startMonth: string; sizePlanned?: number }

/** Batches a candidate can join: planned or in training. */
export const OPEN_BATCH_STATUSES: readonly BatchStatus[] = ["planned", "in_training"];

/** One timeline entry (GET /api/v1/candidates/:id/timeline): ids and state identifiers only. */
export interface TimelineEvent {
  id: string;
  type: string;
  at: string;
  actor: { id: string; name: string | null } | null;
  ref: { type: "submission" | "interview" | "placement" | "team" | "batch"; id: string | null; label: string | null } | null;
  from: string | null;
  to: string | null;
}

/**
 * A likely duplicate (POST /api/v1/candidates/duplicate-check): the owning
 * team and a contact; `candidateId` only when the caller can open that profile.
 */
export interface Duplicate { candidateId: string | null; team: string; contact: string | null; matchedOn: ("email" | "phone")[] }

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
  /** Candidates list only. */
  batchId?: string;
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
  /** null removes the candidate from its batch. */
  batchId?: string | null;
}

export interface CreateCandidate {
  firstName: string;
  lastName: string;
  /** E.164; the server normalizes formatting but needs the country code. */
  phone?: string;
  email?: string;
  technologyId: string;
  locationId: string;
  batchId?: string;
  /** Create despite a 409 possible_duplicate. */
  confirmDuplicate?: boolean;
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
  if (f.batchId) q.set("batchId", f.batchId);
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
  duplicateCheck: (b: Pick<CreateCandidate, "firstName" | "lastName" | "phone" | "email">) =>
    api<{ duplicates: Duplicate[] }>("/api/v1/candidates/duplicate-check", { method: "POST", ...json(b) }),
  timeline: (id: string, cursor?: string | null) =>
    api<Page<TimelineEvent>>(`/api/v1/candidates/${enc(id)}/timeline?limit=50${cursor ? `&cursor=${enc(cursor)}` : ""}`),
  batches: (locationId?: string) =>
    api<BatchList>(`/api/v1/batches${locationId ? `?locationId=${enc(locationId)}` : ""}`),
  createBatch: (b: CreateBatch) => api<{ id: string }>("/api/v1/batches", { method: "POST", ...json(b) }),
};

export const salesKeys = {
  hotlist: ["hotlist"] as const,
  candidates: ["candidates"] as const,
  candidate: (id: string) => ["candidate", id] as const,
  timeline: (id: string) => ["candidate", id, "timeline"] as const,
  batches: ["batches"] as const,
};

/** Plain-language timeline line, e.g. "Status changed from Active to On hold". */
export function describeEvent(e: TimelineEvent): string {
  const s = (v: string | null) => (v ? statusLabel(v) : "");
  switch (e.type) {
    case "candidate.created": return "Candidate created";
    case "candidate.status_changed": return `Status changed from ${s(e.from)} to ${s(e.to)}`;
    case "candidate.visibility_changed": return e.to === "all_teams" ? "Opened to all teams" : "Made visible to the team only";
    case "candidate.rating_changed": return e.to ? `Technical rating set to ${e.to} of 5` : "Technical rating cleared";
    case "candidate.assigned": return e.ref?.label ? `Assigned to ${e.ref.label}` : "Team or recruiter changed";
    case "candidate.batch_changed": return e.ref?.id ? `Added to batch ${e.ref.label ?? ""}`.trim() : "Removed from batch";
    case "submission.created": return "Submission logged";
    case "submission.status_changed": return `Submission moved to ${s(e.to)}`;
    case "interview.scheduled": return "Interview scheduled";
    case "interview.status_changed": return `Interview ${s(e.to).toLowerCase()}`;
    case "interview.cleared": return e.to === "cleared" ? "Interview cleared" : "Interview marked not cleared";
    case "placement.created": return "Placement confirmed";
    case "placement.status_changed": return `Placement moved to ${s(e.to)}`;
    default: return statusLabel(e.type.replace(".", " "));
  }
}
