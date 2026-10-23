import readExcelFile from "read-excel-file/browser";

/** An .xlsx is a zip: refuse anything bigger than a 500-row user list could plausibly be. */
const MAX_BYTES = 5 * 1024 * 1024;

type Cell = string | number | boolean | Date | null | undefined;
const text = (v: Cell) => (v === null || v === undefined ? "" : v instanceof Date ? v.toISOString().slice(0, 10) : String(v));

/** The bulk import sheet as text cells: the template's "Users" sheet, else the first sheet. */
export async function readUserSheet(file: File): Promise<string[][]> {
  if (file.size > MAX_BYTES) throw new Error("The file is larger than 5 MB.");
  let sheets: { sheet: string; data: Cell[][] }[];
  try {
    sheets = (await readExcelFile(file)) as { sheet: string; data: Cell[][] }[];
  } catch {
    throw new Error("This file could not be read as an Excel workbook (.xlsx).");
  }
  const sheet = sheets.find((s) => s.sheet === "Users") ?? sheets[0];
  if (!sheet) throw new Error("The file is empty.");
  return sheet.data.map((row) => row.map(text));
}

export const isXlsx = (file: File) => /\.xlsx$/i.test(file.name);
