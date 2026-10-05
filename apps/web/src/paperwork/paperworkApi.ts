/**
 * Typed client for paperwork progress, background checks and checklist
 * templates (docs/paperwork-api.md, migration 0044).
 */
import { api } from "../api";
import type { Page, Ref } from "../pipeline/pipelineApi";

export const CHECKLIST_STATUSES = ["pending", "received", "verified", "waived"] as const;
export const BGC_STATUSES = ["not_started", "initiated", "in_progress", "cleared", "failed"] as const;
export const OUTSTANDING = new Set(["pending", "received"]);
/** Targets that need a reason (mirrors CHECKLIST_REASON_REQUIRED / BGC_REASON_REQUIRED in @eureka/shared). */
export const ITEM_REASON_REQUIRED = new Set(["waived", "pending"]);
export const BGC_REASON_REQUIRED = new Set(["failed"]);

export interface QueueRow {
  placementId: string;
  candidate: { id: string; name: string | null };
  recruiter: { id: string; name: string | null };
  /** null when the caller cannot read the placement record itself (e.g. Immigration). */
  placement: { status: string; placementType: string; tentativeStart: string; client: Ref | null } | null;
  checklist: { total: number; open: number; requiredOpen: number; overdue: number; nextDue: string | null };
  bgc: { status: string };
}

export interface ItemActions { transition: string[]; editNotes: boolean; assign: boolean }
export interface PaperworkItem {
  id: string;
  docType: string;
  ownerRole: string;
  required: boolean;
  status: string;
  statusReason: string | null;
  statusChangedAt: string | null;
  assignee: Ref | null;
  dueOn: string | null;
  overdue: boolean;
  notes: string | null;
  documentId: string | null;
  version: number;
  templateVersion: number | null;
  actions: ItemActions;
}

export interface HistoryEntry {
  at: string;
  actor: Ref | null;
  from: string | null;
  to: string | null;
  changed: string[];
  reason: string | null;
  details?: Record<string, { from: unknown; to: unknown }>;
}

export interface BgcActions { update: boolean; transition: string[]; failPlacement: boolean }
export interface Bgc {
  status: string;
  bgcCompany: string | null;
  initiatedOn: string | null;
  completedOn: string | null;
  helpedBy: Ref | null;
  educationLevel: string | null;
  employmentYears: number | null;
  addressYears: number | null;
  notes: string | null;
  statusReason: string | null;
  statusChangedAt: string | null;
  version: number | null;
  history: HistoryEntry[];
  actions: BgcActions;
}

export interface PaperworkDetail extends QueueRow { items: PaperworkItem[]; bgc: Bgc }

export interface QueueFilters {
  view?: "outstanding" | "overdue" | "all";
  ownerRole?: string;
  mine?: boolean;
  bgcStatus?: string;
  placementStatus?: string;
  placementType?: string;
  cursor?: string;
  limit?: number;
}

export interface ItemChange {
  status?: string;
  reason?: string;
  ownerRole?: string;
  assigneeId?: string | null;
  dueOn?: string | null;
  notes?: string | null;
  documentId?: string | null;
  expectedVersion?: number;
}

export interface BgcChange {
  status?: string;
  reason?: string;
  bgcCompany?: string | null;
  initiatedOn?: string | null;
  completedOn?: string | null;
  educationLevel?: string | null;
  employmentYears?: number | null;
  addressYears?: number | null;
  notes?: string | null;
  failPlacement?: boolean;
  expectedVersion?: number;
}

export interface TemplateItem { docType: string; ownerRole: string; required: boolean }
export interface TemplateVersion {
  kind: "paperwork" | "onboarding";
  placementType: "c2c" | "w2" | "1099";
  version: number;
  publishedAt: string;
  publishedBy: Ref | null;
  items: TemplateItem[];
}

const enc = encodeURIComponent;
const qs = (f: object) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== null && v !== "" && v !== false) q.set(k, String(v));
  return q.toString();
};

export const paperworkApi = {
  queue: (f: QueueFilters) => api<Page<QueueRow>>(`/api/v1/paperwork?${qs({ limit: 50, ...f })}`),
  detail: (placementId: string) => api<PaperworkDetail>(`/api/v1/paperwork/placements/${enc(placementId)}`),
  updateItem: (id: string, b: ItemChange) =>
    api<PaperworkItem>(`/api/v1/paperwork/items/${enc(id)}`, { method: "PATCH", body: JSON.stringify(b) }),
  itemHistory: (id: string) => api<{ items: HistoryEntry[] }>(`/api/v1/paperwork/items/${enc(id)}/history`),
  updateBgc: (placementId: string, b: BgcChange) =>
    api<Bgc>(`/api/v1/paperwork/placements/${enc(placementId)}/bgc`, { method: "PATCH", body: JSON.stringify(b) }),
  templates: () => api<{ canPublish: boolean; templates: TemplateVersion[] }>("/api/v1/paperwork/templates"),
  publishTemplate: (b: { kind: string; placementType: string; items: TemplateItem[]; expectedVersion: number }) =>
    api<{ kind: string; placementType: string; version: number }>("/api/v1/paperwork/templates", { method: "POST", body: JSON.stringify(b) }),
};

export const paperworkKeys = {
  all: ["paperwork"] as const,
  queue: (f: QueueFilters) => ["paperwork", "queue", f] as const,
  detail: (id: string) => ["paperwork", "detail", id] as const,
  history: (id: string) => ["paperwork", "history", id] as const,
  templates: ["paperwork", "templates"] as const,
};

const LABELS: Record<string, string> = { not_started: "Not started", in_progress: "In progress", bgc: "BGC", bgc_failed: "BGC failed" };
export const paperworkLabel = (s: string) => {
  if (LABELS[s]) return LABELS[s]!;
  const t = s.replace(/_/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
};

/** Friendly text for the `detail` codes of the paperwork API. */
export const PAPERWORK_ERRORS: Record<string, string> = {
  invalid_transition: "That status change isn't allowed from the current status. Refresh to see the latest status.",
  reason_required: "Give a reason for this change.",
  invalid_assignee: "The assignee must be an active user who holds the item's owner role.",
  invalid_owner_role: "Pick an existing role as the owner.",
  invalid_due_date: "Pick a due date between 2000 and 2100.",
  invalid_change: "One of the values isn't valid. Check the fields and try again.",
  invalid_helper: "The person who helped must be an active user.",
  invalid_document: "That document can't be linked: it must belong to this candidate or placement, be readable by you and not be blocked by the scan.",
  placement_closed: "This placement was backed out; its paperwork can no longer change.",
  version_mismatch: "Someone else changed this in the meantime. Close and reopen to see the latest version.",
  invalid_checklist_template: "The template isn't valid: document types must be snake_case and unique, owners existing roles.",
  not_permitted: "You don't have permission to do that for this record.",
};
