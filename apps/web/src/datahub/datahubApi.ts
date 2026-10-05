/** Typed client for DataHub (apps/api/src/modules/datahub; docs/datahub-api.md). */
import {
  DATAHUB_MAX_BYTES, datahubFileNameProblem, type DatahubLevel, type DocumentContentType, type Role,
} from "@eureka/shared";
import { ApiError, api } from "../api";
import { documentTypeOf } from "../documents/documentsApi";
import type { UploadTicket } from "../sales/resumesApi";

export interface FolderActions { read: boolean; upload: boolean; manage: boolean; createSubfolder: boolean }
export interface Folder {
  id: string;
  parentId: string | null;
  name: string;
  description: string | null;
  level: DatahubLevel;
  roleKeys: Role[];
  membersCanUpload: boolean;
  locationId: string | null;
  fileCount: number;
  memberCount: number | null;
  isMember: boolean;
  rowVersion: number;
  createdAt: string;
  updatedAt: string;
  actions: FolderActions;
}
export interface FolderList { items: Folder[]; canCreate: boolean; createScope: { org: boolean; locationIds: string[] } }

export type ScanStatus = "pending" | "clean" | "infected" | "failed" | "rejected" | "expired";
export interface Version {
  id: string;
  version: number;
  status: ScanStatus;
  reason: string | null;
  contentType: DocumentContentType;
  sizeBytes: number;
  uploadedBy: { id: string; name: string | null };
  createdAt: string;
  scannedAt: string | null;
}
export interface FileItem { id: string; folderId: string; name: string; versionCount: number; latestVersion: Version; actions: { download: boolean; delete: boolean } }
export interface FileList { items: FileItem[]; nextCursor: string | null }
export interface SearchResult {
  folders: { id: string; parentId: string | null; name: string; level: DatahubLevel }[];
  files: { id: string; folderId: string; folderName: string; level: DatahubLevel; name: string; latestVersion: Version }[];
}
export interface Member { id: string; name: string | null; addedAt: string }
export interface Person { id: string; name: string }
export interface AccessEntry {
  id: string; at: string; user: { id: string; name: string | null }; fileId: string; fileName: string | null;
  version: number; level: DatahubLevel; steppedUp: boolean;
}

export interface FolderInput {
  name: string;
  description?: string | null;
  level: DatahubLevel;
  roleKeys?: Role[];
  memberIds?: string[];
  membersCanUpload?: boolean;
  parentId?: string | null;
  locationId?: string | null;
}

const enc = encodeURIComponent;
const json = (b: unknown) => ({ body: JSON.stringify(b) });
const B = "/api/v1/datahub";

export const datahubApi = {
  folders: () => api<FolderList>(`${B}/folders`),
  createFolder: (body: FolderInput, idempotencyKey: string) =>
    api<{ id: string; rowVersion: number }>(`${B}/folders`, { method: "POST", ...json(body), headers: { "idempotency-key": idempotencyKey } }),
  updateFolder: (id: string, rowVersion: number, body: Partial<FolderInput>) =>
    api<{ id: string; rowVersion: number }>(`${B}/folders/${enc(id)}`, { method: "PATCH", ...json(body), headers: { "if-match": `"${rowVersion}"` } }),
  deleteFolder: (id: string, rowVersion: number) =>
    api<void>(`${B}/folders/${enc(id)}`, { method: "DELETE", headers: { "if-match": `"${rowVersion}"` } }),
  files: (folderId: string, cursor?: string) =>
    api<FileList>(`${B}/folders/${enc(folderId)}/files${cursor ? `?cursor=${enc(cursor)}` : ""}`),
  versions: (fileId: string) => api<{ items: Version[] }>(`${B}/files/${enc(fileId)}/versions`),
  requestUpload: (folderId: string, name: string, contentType: DocumentContentType, size: number) =>
    api<{ fileId: string; versionId: string; version: number; status: "pending"; upload: UploadTicket }>(
      `${B}/folders/${enc(folderId)}/files`, { method: "POST", ...json({ name, contentType, size }) }),
  deleteFile: (fileId: string) => api<void>(`${B}/files/${enc(fileId)}`, { method: "DELETE" }),
  downloadLink: (versionId: string) => api<{ url: string; expiresAt: string }>(`${B}/versions/${enc(versionId)}/download`, { method: "POST" }),
  search: (q: string) => api<SearchResult>(`${B}/search?q=${enc(q)}`),
  members: (folderId: string) => api<{ items: Member[] }>(`${B}/folders/${enc(folderId)}/members`),
  addMember: (folderId: string, userId: string) => api<void>(`${B}/folders/${enc(folderId)}/members/${enc(userId)}`, { method: "PUT" }),
  removeMember: (folderId: string, userId: string) => api<void>(`${B}/folders/${enc(folderId)}/members/${enc(userId)}`, { method: "DELETE" }),
  people: (q: string) => api<{ items: Person[] }>(`${B}/people?q=${enc(q)}`),
  accessLog: (folderId: string) => api<{ items: AccessEntry[]; nextCursor: string | null }>(`${B}/folders/${enc(folderId)}/access-log`),
};

export const datahubKeys = {
  all: ["datahub"] as const,
  folders: ["datahub", "folders"] as const,
  files: (folderId: string) => ["datahub", "files", folderId] as const,
  versions: (fileId: string) => ["datahub", "versions", fileId] as const,
  members: (folderId: string) => ["datahub", "members", folderId] as const,
  log: (folderId: string) => ["datahub", "log", folderId] as const,
  search: (q: string) => ["datahub", "search", q] as const,
  people: (q: string) => ["datahub", "people", q] as const,
};

/**
 * Sends the file to the presigned target with upload progress (XMLHttpRequest:
 * fetch has no upload progress). The signed fields first, the file last, no
 * cookies. Tests replace `storage.post`.
 */
export const storage = {
  post(ticket: UploadTicket, file: Blob, onProgress: (fraction: number) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const form = new FormData();
      for (const [k, v] of Object.entries(ticket.fields)) form.append(k, v);
      form.append("file", file);
      const xhr = new XMLHttpRequest();
      xhr.open("POST", ticket.url);
      xhr.withCredentials = false;
      xhr.upload.onprogress = (e) => { if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total); };
      xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new ApiError(xhr.status, "upload_failed", "upload_failed")));
      xhr.onerror = () => reject(new ApiError(0, "upload_failed", "upload_failed"));
      xhr.send(form);
    });
  },
};

/** Client-side check for early feedback; the server, the presigned policy and the worker check again. */
export function datahubFileProblem(file: { name: string; type: string; size: number }): string | null {
  const type = documentTypeOf(file);
  if (!type) return "Choose a PDF, Word (.docx), PNG or JPEG file.";
  if (file.size === 0) return "That file is empty.";
  if (file.size > DATAHUB_MAX_BYTES) return "That file is larger than 15 MB.";
  return datahubFileNameProblem(file.name.trim(), type);
}

/** Plain-language scan status of one version. */
export function scanStatusText(v: Pick<Version, "status">): string {
  switch (v.status) {
    case "pending": return "Scanning";
    case "clean": return "Clean";
    case "infected": return "Blocked: malware";
    case "rejected": return "Rejected";
    case "expired": return "Not received";
    default: return "Scan failed";
  }
}

export function datahubError(e: unknown): string {
  if (!(e instanceof ApiError)) return e instanceof Error ? e.message : "Something went wrong.";
  switch (e.detail) {
    case "upload_failed": return "The file could not be sent to storage. Try again; the link is valid for 2 minutes.";
    case "name_taken": return "A folder with this name already exists here.";
    case "folder_not_empty": return "Delete or move the files and subfolders first.";
    case "too_many_pending": return "Ten of your uploads are still being scanned. Wait for them to finish.";
    case "stale": return "Someone changed this folder meanwhile. Close and try again.";
    case "location_required": return "Choose the location this folder belongs to.";
    case "invalid_member": return "Only active staff can be added to a restricted folder.";
    case "invalid_roles": return "Choose at least one role for a confidential folder.";
    case "not_available": return "This version isn't available (it is still being scanned or did not pass).";
    case "not_member": return "You aren't a member of this restricted folder.";
    default: break;
  }
  switch (e.status) {
    case 401: return "Your session ended. Sign in again.";
    case 403: return "You aren't allowed to do that here.";
    case 404: return "This isn't available from your account.";
    case 422: return e.errors?.[0]?.message ?? "Check the highlighted fields.";
    case 429: return e.detail ?? "Too many requests. Try again in a minute.";
    default: return e.detail ?? "Something went wrong.";
  }
}

/** A random Idempotency-Key for one create attempt (kept across retries of the same dialog). */
export function newIdempotencyKey(): string {
  const a = new Uint8Array(16);
  globalThis.crypto.getRandomValues(a);
  return `dh-${[...a].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}
