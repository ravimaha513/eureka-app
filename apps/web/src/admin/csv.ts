/** Minimal RFC 4180 CSV reader for the bulk user import: quoted fields, "" escapes, CRLF, BOM. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field); field = "";
      rows.push(row); row = [];
    } else field += ch;
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

export interface BulkRow { email: string; displayName: string; designation?: string; location?: string }

const HEADERS: Record<string, keyof BulkRow> = {
  email: "email", "e-mail": "email",
  name: "displayName", displayname: "displayName", "display name": "displayName", "full name": "displayName",
  designation: "designation", title: "designation",
  location: "location", "primary location": "location", primarylocation: "location",
};

/** Maps a header row to BulkRow fields. Throws a readable message when `email` or `name` is missing. */
export function csvToRows(text: string): BulkRow[] {
  const [head, ...body] = parseCsv(text);
  if (!head) throw new Error("The file is empty.");
  const cols = head.map((h) => HEADERS[h.trim().toLowerCase()]);
  if (!cols.includes("email") || !cols.includes("displayName")) {
    throw new Error("The first row must be a header with at least the columns email and name.");
  }
  return body.map((cells) => {
    const r: BulkRow = { email: "", displayName: "" };
    cols.forEach((key, i) => {
      const v = (cells[i] ?? "").trim();
      if (key && v) r[key] = v;
    });
    return r;
  });
}

export const CSV_TEMPLATE = "email,name,designation,location\nasha.rao@example.com,Asha Rao,Recruiter,Dallas\n";
