import { apiFetch } from "../api";

/** A CSV export: the file plus the server's row count and cap flag. */
export interface ExportResult { blob: Blob; filename: string; rows: number; truncated: boolean }

/** Saves a blob as a file through a temporary link. */
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * POSTs to an audited CSV export endpoint. The filename comes from content-disposition
 * (falling back to `fallbackName`); x-export-rows / x-export-truncated give the row cap.
 */
export async function fetchCsv(path: string, body: unknown, fallbackName: string): Promise<ExportResult> {
  const res = await apiFetch(path, { method: "POST", body: JSON.stringify(body) });
  const filename = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? fallbackName;
  return {
    blob: await res.blob(), filename,
    rows: Number(res.headers.get("x-export-rows") ?? 0), truncated: res.headers.get("x-export-truncated") === "true",
  };
}

/** fetchCsv, then saves the file; resolves with the row count and cap flag. */
export async function downloadCsv(path: string, body: unknown, fallbackName: string): Promise<Pick<ExportResult, "rows" | "truncated">> {
  const { blob, filename, rows, truncated } = await fetchCsv(path, body, fallbackName);
  saveBlob(blob, filename);
  return { rows, truncated };
}
