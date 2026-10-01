/** Typed client for candidate resumes (apps/api/src/modules/resumes, FR-CAN-07). */
import { RESUME_CONTENT_TYPES, RESUME_MAX_BYTES, isResumeContentType, type ResumeContentType, type ResumeStatus } from "@eureka/shared";
import { ApiError, api } from "../api";

export interface Resume {
  id: string;
  status: ResumeStatus;
  /** Why a scan did not pass (e.g. THREATS_FOUND, TIMEOUT, BAD_CONTENT); null when clean or pending. */
  reason: string | null;
  version: number | null;
  isCurrent: boolean;
  contentType: ResumeContentType;
  sizeBytes: number;
  sha256: string | null;
  uploadedBy: { id: string; name: string | null };
  createdAt: string;
  scannedAt: string | null;
}

/** `canUpload` is a hint (document:upload over this candidate); the server decides. */
export interface ResumeList { items: Resume[]; canUpload: boolean }

export interface UploadTicket { url: string; fields: Record<string, string>; expiresAt: string }

const enc = encodeURIComponent;
const json = (b: unknown) => ({ body: JSON.stringify(b) });

export const resumesApi = {
  list: (candidateId: string) => api<ResumeList>(`/api/v1/candidates/${enc(candidateId)}/resumes`),
  requestUpload: (candidateId: string, contentType: ResumeContentType, size: number) =>
    api<{ id: string; status: "pending"; upload: UploadTicket }>(`/api/v1/candidates/${enc(candidateId)}/resumes`,
      { method: "POST", ...json({ contentType, size }) }),
  downloadLink: (candidateId: string, resumeId: string) =>
    api<{ url: string; expiresAt: string }>(`/api/v1/candidates/${enc(candidateId)}/resumes/${enc(resumeId)}/download`, { method: "POST" }),
};

export const resumeKeys = { list: (candidateId: string) => ["candidate", candidateId, "resumes"] as const };

/**
 * Sends the file to the presigned target (S3 in AWS, the API's local driver in
 * development): the signed fields first, the file last, no cookies. The bytes
 * never pass through the API.
 */
export async function postToStorage(ticket: UploadTicket, file: Blob): Promise<void> {
  const form = new FormData();
  for (const [k, v] of Object.entries(ticket.fields)) form.append(k, v);
  form.append("file", file);
  const res = await fetch(ticket.url, { method: "POST", body: form, credentials: "omit" });
  if (!res.ok) throw new ApiError(res.status, "upload_failed", "upload_failed");
}

/** Browser hooks the tests replace (jsdom cannot navigate). */
export const browser = {
  download(url: string) { window.location.assign(url); },
};

/** The allowed type of a picked file: its MIME type, else its extension (some systems send none for .docx). */
export function resumeTypeOf(file: { name: string; type: string }): ResumeContentType | null {
  if (isResumeContentType(file.type)) return file.type;
  const ext = file.name.toLowerCase().split(".").pop();
  const match = (Object.entries(RESUME_CONTENT_TYPES) as [ResumeContentType, { ext: string }][]).find(([, v]) => v.ext === ext);
  return file.type === "" || file.type === "application/octet-stream" ? match?.[0] ?? null : null;
}

/** Client-side check for early feedback; the presigned policy and the worker check again. */
export function resumeFileProblem(file: { name: string; type: string; size: number }): string | null {
  if (!resumeTypeOf(file)) return "Choose a PDF or Word (.docx) file.";
  if (file.size === 0) return "That file is empty.";
  if (file.size > RESUME_MAX_BYTES) return "That file is larger than 15 MB.";
  return null;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const REASONS: Record<string, string> = {
  THREATS_FOUND: "malware was found; the file was deleted",
  TIMEOUT: "the malware scan did not finish",
  NOT_UPLOADED: "the file never arrived",
  BAD_CONTENT: "the file is not the PDF or Word document it claims to be",
  ACTIVE_CONTENT: "the file contains macros, scripts, embedded files or external links",
  SIZE_MISMATCH: "the file size did not match",
  UNSUPPORTED: "the file could not be scanned",
};

/** Plain-language status of one upload. */
export function resumeStatusText(r: Pick<Resume, "status" | "reason">): string {
  switch (r.status) {
    case "pending": return "Scanning";
    case "clean": return "Ready";
    case "infected": return "Blocked: malware found";
    case "rejected": return `Rejected: ${REASONS[r.reason ?? ""] ?? "the file failed checks"}`;
    case "expired": return "Upload not received";
    default: return `Scan failed: ${REASONS[r.reason ?? ""] ?? "try uploading again"}`;
  }
}
