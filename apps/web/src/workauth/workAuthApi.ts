/** Typed client for work authorization records (apps/api/src/modules/work-authorization, FR-VIS-01). */
import type { WorkAuthStatus, WorkAuthType } from "@eureka/shared";
import { api } from "../api";

export interface WorkAuthorization {
  id: string;
  type: WorkAuthType;
  /** A fixed mask when a number is stored; the number itself only through `reveal`. */
  numberMasked: string | null;
  hasNumber: boolean;
  validFrom: string | null;
  validTo: string | null;
  status: WorkAuthStatus;
  expired: boolean;
  daysToExpiry: number | null;
  rowVersion: number;
  createdAt: string;
  updatedAt: string;
  updatedBy: { id: string; name: string | null };
}

/** `canEdit` and `canReveal` are hints (visa:update / visa:read over this candidate); the server decides. */
export interface WorkAuthList { items: WorkAuthorization[]; canEdit: boolean; canReveal: boolean }

export interface WorkAuthInput {
  type: WorkAuthType;
  status: WorkAuthStatus;
  validFrom: string | null;
  validTo: string | null;
  /** Create: optional. Update: omitted keeps the stored number, null removes it. */
  number?: string | null;
}

const enc = encodeURIComponent;
const base = (candidateId: string) => `/api/v1/candidates/${enc(candidateId)}/work-authorizations`;

export const workAuthApi = {
  list: (candidateId: string) => api<WorkAuthList>(base(candidateId)),
  create: (candidateId: string, body: WorkAuthInput) =>
    api<{ id: string; rowVersion: number }>(base(candidateId), { method: "POST", body: JSON.stringify(body) }),
  /** If-Match carries the version the user edited; 412 when someone else saved first. */
  update: (candidateId: string, id: string, rowVersion: number, body: Partial<WorkAuthInput>) =>
    api<{ id: string; rowVersion: number }>(`${base(candidateId)}/${enc(id)}`, {
      method: "PATCH", body: JSON.stringify(body), headers: { "if-match": `"${rowVersion}"` },
    }),
  /** Audited on the server; needs a step-up of this session (403 `step_up_required` otherwise). */
  reveal: (candidateId: string, id: string) =>
    api<{ id: string; number: string }>(`${base(candidateId)}/${enc(id)}/reveal`, { method: "POST" }),
};

export const workAuthKeys = { list: (candidateId: string) => ["candidate", candidateId, "work-authorizations"] as const };
