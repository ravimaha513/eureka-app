/**
 * Minimal RFC 4180 CSV parser for Google Sheets exports: quoted fields,
 * doubled quotes, embedded newlines, CRLF or LF line ends, a UTF-8 BOM.
 * Fully blank lines are dropped.
 */
export interface CsvTable {
  headers: string[];
  /** Data rows as header -> cell; `line` is the 1-based sheet row (header = 1). */
  rows: { line: number; cells: Record<string, string> }[];
}

export function parseCsvRecords(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const out: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const endField = () => { row.push(field); field = ""; };
  const endRow = () => { endField(); out.push(row); row = []; };
  while (i < src.length) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"' && field === "") { quoted = true; i++; continue; }
    if (ch === ",") { endField(); i++; continue; }
    if (ch === "\r" && src[i + 1] === "\n") { endRow(); i += 2; continue; }
    if (ch === "\n" || ch === "\r") { endRow(); i++; continue; }
    field += ch; i++;
  }
  if (quoted) throw new Error("CSV ends inside a quoted field");
  if (field !== "" || row.length > 0) endRow();
  return out;
}

export function parseCsv(text: string): CsvTable {
  const records = parseCsvRecords(text);
  const headerRow = records.shift();
  if (!headerRow) throw new Error("CSV has no header row");
  const headers = headerRow.map((h) => h.trim());
  const seen = new Set<string>();
  for (const h of headers) {
    const k = h.toLowerCase();
    if (h && seen.has(k)) throw new Error(`CSV header "${h}" appears twice`);
    seen.add(k);
  }
  const rows: CsvTable["rows"] = [];
  records.forEach((rec, idx) => {
    if (rec.every((c) => c.trim() === "")) return;
    const cells: Record<string, string> = {};
    headers.forEach((h, j) => { if (h) cells[h] = rec[j] ?? ""; });
    // Cells beyond the header width are kept so they still count in the row key.
    for (let j = headers.length; j < rec.length; j++) if (rec[j]!.trim() !== "") cells[`#${j + 1}`] = rec[j]!;
    rows.push({ line: idx + 2, cells });
  });
  return { headers, rows };
}
