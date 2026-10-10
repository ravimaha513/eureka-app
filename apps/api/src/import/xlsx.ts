/**
 * Excel (.xlsx) input for the sheet import. People keep their sheets in
 * different templates, so this only turns a workbook into plain tables; what
 * the columns mean is decided by the mapping (hand-written or proposed by
 * llm-mapper.ts and confirmed by an admin). Everything downstream still sees
 * CSV text, so hashing, row numbers and analysis are unchanged.
 */
import { strFromU8, unzipSync } from "fflate";
import readExcelFile from "read-excel-file/node";

/** Upload guards: an .xlsx is a zip, so bound what we are willing to expand. */
export const XLSX_LIMITS = { bytes: 10 * 1024 * 1024, rows: 50_000, cols: 100 } as const;

export interface WorkbookSheet {
  name: string;
  /** Rows above the header row (titles, notes) are dropped; cells are display strings. */
  headerRow: number;
  headers: string[];
  rows: string[][];
  /**
   * Where the tab's data comes from, when it is a Google Sheets export of an
   * IMPORTRANGE formula ("=IMPORTRANGE(id, \"Submissions!A:I\")"): the cells hold
   * the formula's cached results (read as values here), and the range names
   * the source tab, which identifies what the tab holds.
   */
  source?: SheetSource;
}

export interface SheetSource { spreadsheetId: string; range: string; tab: string }

type Cell = string | number | boolean | Date | null | undefined;

function cellText(v: Cell): string {
  if (v === null || v === undefined) return "";
  // Dates become ISO dates: the normalizer reads them unambiguously whatever the locale of the author.
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? "" : v.toISOString().slice(0, 10);
  // Error results of formulas (#VALUE!, #N/A, #REF!) are not data.
  const t = String(v).trim();
  return /^#(VALUE!|N\/A|REF!|DIV\/0!|NAME\?|NUM!|NULL!|ERROR!)$/i.test(t) ? "" : t;
}

const XML_DECODE: Record<string, string> = { "&quot;": '"', "&apos;": "'", "&lt;": "<", "&gt;": ">", "&amp;": "&" };
const decodeXml = (s: string) => s.replace(/&(quot|apos|lt|gt|amp);/g, (m) => XML_DECODE[m]!);

/** The IMPORTRANGE source in a formula, also inside Google's export wrapper __xludf.DUMMYFUNCTION("..."). */
export function importRangeSource(formula: string): SheetSource | undefined {
  const f = formula.replaceAll('""', '"');
  const m = /IMPORTRANGE\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\)/i.exec(f);
  if (!m) return undefined;
  const range = m[2]!.trim();
  const bang = range.lastIndexOf("!");
  const tab = (bang > 0 ? range.slice(0, bang) : "").replace(/^'(.*)'$/, "$1").trim();
  return { spreadsheetId: m[1]!.trim(), range, tab };
}

/**
 * IMPORTRANGE sources per sheet name, read from the workbook XML (only the
 * workbook, its relationships and the first formula of each sheet; no cell
 * values). Best effort: a workbook it cannot read simply has no sources.
 */
export function workbookSources(input: Buffer): Map<string, SheetSource> {
  const out = new Map<string, SheetSource>();
  try {
    const files = unzipSync(new Uint8Array(input), {
      filter: (f) => f.originalSize <= 64 * 1024 * 1024
        && (f.name === "xl/workbook.xml" || f.name === "xl/_rels/workbook.xml.rels" || /^xl\/worksheets\/[^/]+\.xml$/.test(f.name)),
    });
    const wb = files["xl/workbook.xml"];
    const rels = files["xl/_rels/workbook.xml.rels"];
    if (!wb || !rels) return out;
    const targets = new Map<string, string>();
    for (const m of strFromU8(rels).matchAll(/<Relationship\b[^>]*>/g)) {
      const id = /\bId="([^"]+)"/.exec(m[0])?.[1];
      const target = /\bTarget="([^"]+)"/.exec(m[0])?.[1];
      if (id && target) targets.set(id, target.replace(/^\/?(xl\/)?/, "xl/"));
    }
    for (const m of strFromU8(wb).matchAll(/<sheet\b[^>]*>/g)) {
      const name = /\bname="([^"]*)"/.exec(m[0])?.[1];
      const rid = /\br:id="([^"]+)"/.exec(m[0])?.[1];
      const xml = rid ? files[targets.get(rid) ?? ""] : undefined;
      if (name === undefined || !xml) continue;
      const formula = /<f\b[^>]*>([^<]*IMPORTRANGE[^<]*)<\/f>/i.exec(strFromU8(xml));
      const src = formula ? importRangeSource(decodeXml(formula[1]!)) : undefined;
      if (src) out.set(decodeXml(name), src);
    }
  } catch {
    // Not fatal: sources only help classify tabs.
  }
  return out;
}

/** First row within the top 20 with at least 3 non-empty cells that are mostly text: the header, not a title or a data row. */
export function detectHeaderRow(rows: Cell[][]): number {
  const need = Math.min(3, Math.max(1, ...rows.slice(0, 20).map((r) => r.filter((c) => cellText(c) !== "").length)));
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const filled = rows[i]!.filter((c) => cellText(c) !== "");
    if (filled.length < need) continue;
    if (filled.filter((c) => typeof c === "string").length * 2 >= filled.length) return i;
  }
  return 0;
}

export async function readWorkbook(input: Buffer): Promise<WorkbookSheet[]> {
  if (input.length > XLSX_LIMITS.bytes) throw new Error(`Workbook is larger than ${XLSX_LIMITS.bytes / 1024 / 1024} MB`);
  if (input.length < 4 || input[0] !== 0x50 || input[1] !== 0x4b) throw new Error("Not an .xlsx file (expected a zip container)");
  const sheets = await readExcelFile(input);
  const sources = workbookSources(input);
  const out: WorkbookSheet[] = [];
  for (const s of sheets) {
    const data = s.data as Cell[][];
    if (data.length === 0) continue;
    if (data.length > XLSX_LIMITS.rows) throw new Error(`Sheet "${s.sheet}" has more than ${XLSX_LIMITS.rows} rows`);
    const h = detectHeaderRow(data);
    const headers = data[h]!.map(cellText);
    if (headers.length > XLSX_LIMITS.cols) throw new Error(`Sheet "${s.sheet}" has more than ${XLSX_LIMITS.cols} columns`);
    const rows = data.slice(h + 1).map((r) => headers.map((_, j) => cellText(r[j])));
    const source = sources.get(s.sheet);
    out.push({ name: s.sheet, headerRow: h + 1, headers, rows: rows.filter((r) => r.some((c) => c !== "")), ...(source ? { source } : {}) });
  }
  if (out.length === 0) throw new Error("Workbook has no data");
  return out;
}

function csvField(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/**
 * CSV text for one sheet, parsed by the existing parseCsv. Row numbers there
 * count from the header, so a sheet whose header is not on row 1 is refused
 * rather than reported with shifted row numbers in the review queue.
 */
export function sheetToCsv(sheet: WorkbookSheet): string {
  if (sheet.headerRow !== 1) {
    throw new Error(`Sheet "${sheet.name}": the header is on row ${sheet.headerRow}; delete the rows above it so review row numbers match the sheet`);
  }
  return [sheet.headers, ...sheet.rows].map((r) => r.map(csvField).join(",")).join("\n") + "\n";
}

/** First sheet (or the named one) of a workbook as CSV text. */
export async function xlsxToCsv(input: Buffer, sheetName?: string): Promise<string> {
  const sheets = await readWorkbook(input);
  const s = sheetName ? sheets.find((x) => x.name === sheetName) : sheets[0];
  if (!s) throw new Error(`Workbook has no sheet "${sheetName}" (has: ${sheets.map((x) => x.name).join(", ")})`);
  return sheetToCsv(s);
}
