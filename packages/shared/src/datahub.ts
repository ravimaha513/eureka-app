import { DOCUMENT_CONTENT_TYPES, DOCUMENT_MAX_BYTES, type DocumentContentType } from "./documents.js";

/**
 * DataHub (docs/datahub-api.md, migration 0075): organisation folders and
 * files on the document storage and malware scan. Shared by the API (request
 * validation, download names) and the web app (early feedback). The database
 * enforces the same limits.
 */

/** Security levels (reference screen: Internal – All employees, Confidential – Specific roles, Restricted – Limited access). */
export const DATAHUB_LEVELS = ["internal", "confidential", "restricted"] as const;
export type DatahubLevel = (typeof DATAHUB_LEVELS)[number];

export const DATAHUB_LEVEL_LABELS: Record<DatahubLevel, { label: string; audience: string; help: string }> = {
  internal: { label: "Internal", audience: "All employees", help: "Accessible to all employees in the organisation." },
  confidential: { label: "Confidential", audience: "Specific roles", help: "Only people holding one of the chosen roles can open it." },
  restricted: {
    label: "Restricted", audience: "Limited access",
    help: "Only the named people can open it. Every download asks them to confirm it's them and is logged.",
  },
};

export const DATAHUB_FOLDER_NAME_MAX = 80;
export const DATAHUB_FILE_NAME_MAX = 200;
export const DATAHUB_DESCRIPTION_MAX = 500;
export const DATAHUB_MAX_ROLES = 16;
export const DATAHUB_MAX_MEMBERS = 200;

/** Upload types and size: the document allowlist (PDF, DOCX, PNG, JPEG; 15 MB). */
export const DATAHUB_MAX_BYTES = DOCUMENT_MAX_BYTES;

const CONTROL_OR_SLASH = /[\u0000-\u001f\u007f/\\]/;

/** A folder name: 1–80 characters, no leading/trailing spaces, no control characters or slashes. */
export function datahubFolderNameProblem(name: string): string | null {
  if (name.length === 0) return "Enter a folder name.";
  if (name !== name.trim()) return "Remove the spaces at the start or end.";
  if (name.length > DATAHUB_FOLDER_NAME_MAX) return `Use at most ${DATAHUB_FOLDER_NAME_MAX} characters.`;
  if (CONTROL_OR_SLASH.test(name)) return "A folder name can't contain slashes.";
  return null;
}

/** Extensions accepted for each content type (the name's extension must match the type). */
export const DATAHUB_EXTENSIONS: Record<DocumentContentType, readonly string[]> = {
  "application/pdf": ["pdf"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ["docx"],
  "image/png": ["png"],
  "image/jpeg": ["jpg", "jpeg"],
};

export function datahubExtension(name: string): string | null {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name);
  return m ? m[1]!.toLowerCase() : null;
}

/** A file name: 1–200 characters, no control characters or slashes, an extension matching the type. */
export function datahubFileNameProblem(name: string, contentType: DocumentContentType): string | null {
  if (name.length === 0 || name === "." || name === "..") return "The file needs a name.";
  if (name !== name.trim()) return "Remove the spaces at the start or end of the file name.";
  if (name.length > DATAHUB_FILE_NAME_MAX) return `Use a file name of at most ${DATAHUB_FILE_NAME_MAX} characters.`;
  if (CONTROL_OR_SLASH.test(name)) return "A file name can't contain slashes.";
  const ext = datahubExtension(name);
  if (!ext || !DATAHUB_EXTENSIONS[contentType].includes(ext)) {
    return `The file name must end in .${DATAHUB_EXTENSIONS[contentType].join(" or .")}.`;
  }
  return null;
}

/**
 * Download name (Content-Disposition): ASCII letters, digits, dot, dash and
 * underscore only, so it can never inject a header parameter; the version and
 * the type's own extension are appended. Example: "Leave policy.pdf" v2 ->
 * "Leave-policy-v2.pdf".
 */
export function datahubDownloadName(name: string, version: number, contentType: DocumentContentType): string {
  const ext = DOCUMENT_CONTENT_TYPES[contentType].ext;
  const stem = name.replace(/\.[A-Za-z0-9]{1,8}$/, "");
  const safe = stem.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 80) || "file";
  return `${safe}-v${Math.max(1, Math.trunc(version))}.${ext}`;
}
