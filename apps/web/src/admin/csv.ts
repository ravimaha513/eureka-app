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

export interface BulkRow { email: string; displayName: string; designation?: string; location?: string; manager?: string; team?: string; roles?: string[] }

type Field = Exclude<keyof BulkRow, "roles"> | "role";
const HEADERS: Record<string, Field> = {
  email: "email", "e-mail": "email",
  name: "displayName", displayname: "displayName", "display name": "displayName", "full name": "displayName",
  designation: "designation", title: "designation",
  location: "location", "primary location": "location", primarylocation: "location",
  manager: "manager", "manager email": "manager", "reports to": "manager",
  team: "team", "team name": "team",
  role: "role", "role 1": "role", "role 2": "role", "role 3": "role", "role 4": "role", "role 5": "role",
};

/**
 * Maps a table whose first row is the header to BulkRow fields; every Role column adds one role.
 * Throws a readable message when `email` or `name` is missing.
 */
export function tableToRows(table: string[][]): BulkRow[] {
  const [head, ...body] = table.filter((r) => r.some((c) => c.trim() !== ""));
  if (!head) throw new Error("The file is empty.");
  const cols = head.map((h) => HEADERS[h.trim().toLowerCase()]);
  if (!cols.includes("email") || !cols.includes("displayName")) {
    throw new Error("The first row must be a header with at least the columns email and name.");
  }
  return body.map((cells) => {
    const r: BulkRow = { email: "", displayName: "" };
    cols.forEach((key, i) => {
      const v = (cells[i] ?? "").trim();
      if (!key || !v) return;
      if (key === "role") (r.roles ??= []).push(v);
      else r[key] = v;
    });
    return r;
  });
}

export function csvToRows(text: string): BulkRow[] {
  return tableToRows(parseCsv(text));
}
