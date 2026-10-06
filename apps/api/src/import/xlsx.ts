/**
 * Excel (.xlsx) input for the sheet import. People keep their sheets in
 * different templates, so this only turns a workbook into plain tables; what
 * the columns mean is decided by the mapping (hand-written or proposed by
 * llm-mapper.ts and confirmed by an admin). Everything downstream still sees
 * CSV text, so hashing, row numbers and analysis are unchanged.
 */
import readExcelFile from "read-excel-file/node";

/** Upload guards: an .xlsx is a zip, so bound what we are willing to expand. */
export const XLSX_LIMITS = { bytes: 10 * 1024 * 1024, rows: 50_000, cols: 100 } as const;

export interface WorkbookSheet {
  name: string;
  /** Rows above the header row (titles, notes) are dropped; cells are display strings. */
  headerRow: number;
  headers: string[];
  rows: string[][];
}

type Cell = string | number | boolean | Date | null | undefined;

function cellText(v: Cell): string {
  if (v === null || v === undefined) return "";
  // Dates become ISO dates: the normalizer reads them unambiguously whatever the locale of the author.
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? "" : v.toISOString().slice(0, 10);
  return String(v).trim();
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
  const out: WorkbookSheet[] = [];
  for (const s of sheets) {
    const data = s.data as Cell[][];
    if (data.length === 0) continue;
    if (data.length > XLSX_LIMITS.rows) throw new Error(`Sheet "${s.sheet}" has more than ${XLSX_LIMITS.rows} rows`);
    const h = detectHeaderRow(data);
    const headers = data[h]!.map(cellText);
    if (headers.length > XLSX_LIMITS.cols) throw new Error(`Sheet "${s.sheet}" has more than ${XLSX_LIMITS.cols} columns`);
    const rows = data.slice(h + 1).map((r) => headers.map((_, j) => cellText(r[j])));
    out.push({ name: s.sheet, headerRow: h + 1, headers, rows: rows.filter((r) => r.some((c) => c !== "")) });
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
