/** Typed client for paperwork documents and step-up (apps/api/src/modules/documents, identity/step-up; FR-PPR-01 to 03). */
import {
  DOCUMENT_CONTENT_TYPES, DOCUMENT_MAX_BYTES, DOCUMENT_TYPES, isDocumentContentType,
  type DocumentClassification, type DocumentContentType, type DocumentFileStatus, type DocumentType,
} from "@eureka/shared";
import { ApiError, api } from "../api";
import type { UploadTicket } from "../sales/resumesApi";

export interface DocumentItem {
  /** Stable document id (the paperwork checklist links to it). */
  id: string;
  candidateId: string;
  placementId: string | null;
  docType: DocumentType;
  docTypeLabel: string;
  classification: DocumentClassification;
  status: DocumentFileStatus;
  reason: string | null;
  contentType: DocumentContentType;
  sizeBytes: number;
  sha256: string | null;
  uploadedBy: { id: string; name: string | null };
  createdAt: string;
  scannedAt: string | null;
}

/** The can* flags are hints for this candidate; the server decides. */
export interface DocumentList { items: DocumentItem[]; canUpload: boolean; canUploadRestricted: boolean; canViewRestricted: boolean }

export type DocumentOwner = { kind: "candidate"; id: string } | { kind: "placement"; id: string };

export interface StepUpStatus { active: boolean; expiresAt: string | null; method: string | null; mode: "google" | "dev" | "password"; ttlMinutes: number }

export interface AccessLogEntry {
  id: string; documentId: string; docType: string; classification: DocumentClassification;
  user: { id: string; name: string | null }; action: string; steppedUp: boolean; at: string;
}

const enc = encodeURIComponent;
const json = (b: unknown) => ({ body: JSON.stringify(b) });
const base = (o: DocumentOwner) => `/api/v1/${o.kind === "candidate" ? "candidates" : "placements"}/${enc(o.id)}/documents`;

export const documentsApi = {
  list: (o: DocumentOwner) => api<DocumentList>(base(o)),
  requestUpload: (o: DocumentOwner, docType: DocumentType, contentType: DocumentContentType, size: number) =>
    api<{ id: string; fileId: string; classification: DocumentClassification; status: "pending"; upload: UploadTicket }>(base(o),
      { method: "POST", ...json({ docType, contentType, size }) }),
  downloadLink: (documentId: string) =>
    api<{ url: string; expiresAt: string }>(`/api/v1/documents/${enc(documentId)}/download`, { method: "POST" }),
  accessLog: (documentId: string) => api<{ items: AccessLogEntry[] }>(`/api/v1/document-access?documentId=${enc(documentId)}`),
  stepUpStatus: () => api<StepUpStatus>("/api/auth/step-up"),
  /** Google: returns the URL to send the browser to; it comes back to `returnTo`. */
  startStepUp: (returnTo: string) => api<{ redirectUrl: string }>("/api/auth/step-up/start", { method: "POST", ...json({ returnTo }) }),
  /** Development only (the server refuses it elsewhere). */
  /** Staging/local: re-enter the password; the database verifies it. */
  passwordStepUp: (password: string) => api<{ active: true; expiresAt: string }>("/api/auth/step-up/password", { method: "POST", ...json({ password }) }),
  devStepUp: () => api<{ active: true; expiresAt: string }>("/api/auth/step-up/dev", { method: "POST" }),
};

export const documentKeys = {
  list: (o: DocumentOwner) => ["documents", o.kind, o.id] as const,
  stepUp: ["step-up"] as const,
  accessLog: (documentId: string) => ["document-access", documentId] as const,
};

/** Browser hooks the tests replace (jsdom cannot navigate). */
export const pageNav = {
  assign(url: string) { window.location.assign(url); },
};

export const isStepUpRequired =(e: unknown) => e instanceof ApiError && e.status === 403 && e.detail === "step_up_required";

/** Same-origin path to come back to after Google (mirrors the server's ReturnPath rule); "/" when unusable. */
export function returnPath(loc: { pathname: string; search: string } = window.location): string {
  const p = `${loc.pathname}${loc.search}`;
  return /^\/[A-Za-z0-9/_.?=&%-]{0,200}$/.test(p) && !p.startsWith("//") ? p : "/";
}

/** The allowed type of a picked file: its MIME type, else its extension. */
export function documentTypeOf(file: { name: string; type: string }): DocumentContentType | null {
  if (isDocumentContentType(file.type)) return file.type;
  const ext = file.name.toLowerCase().split(".").pop();
  const alias = ext === "jpeg" ? "jpg" : ext;
  const match = (Object.entries(DOCUMENT_CONTENT_TYPES) as [DocumentContentType, { ext: string }][]).find(([, v]) => v.ext === alias);
  return file.type === "" || file.type === "application/octet-stream" ? match?.[0] ?? null : null;
}

/** Client-side check for early feedback; the presigned policy and the worker check again. */
export function documentFileProblem(file: { name: string; type: string; size: number }): string | null {
  if (!documentTypeOf(file)) return "Choose a PDF, Word (.docx), PNG or JPEG file.";
  if (file.size === 0) return "That file is empty.";
  if (file.size > DOCUMENT_MAX_BYTES) return "That file is larger than 15 MB.";
  return null;
}

/** Types this user may upload here: restricted ones only with canUploadRestricted. */
export function uploadableTypes(list: Pick<DocumentList, "canUploadRestricted">): DocumentType[] {
  return (Object.keys(DOCUMENT_TYPES) as DocumentType[]).filter((t) => DOCUMENT_TYPES[t].classification !== "restricted" || list.canUploadRestricted);
}
