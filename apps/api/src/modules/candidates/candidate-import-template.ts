import ExcelJS from "exceljs";

/** Columns of the batch candidates template; the web reader maps these headers back (apps/web/src/training/candidateSheet.ts). */
export const CANDIDATE_TEMPLATE_HEADERS = ["First Name", "Last Name", "Phone", "Personal Email"] as const;

/**
 * The .xlsx users fill in to add new candidates to a batch (docs/candidates-api.md).
 * Only the fields a new candidate must have; technology and location come from the
 * batch. Cells are text so Excel keeps a phone's leading "+". The data sheet starts
 * empty so a forgotten example row can never be imported.
 */
export async function buildCandidateImportTemplate(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Eureka";
  const sheet = wb.addWorksheet("Candidates", { views: [{ state: "frozen", ySplit: 1 }] });
  const help = wb.addWorksheet("Instructions");

  sheet.columns = CANDIDATE_TEMPLATE_HEADERS.map((h) => ({ header: h, key: h, width: h === "Personal Email" ? 34 : 22, style: { numFmt: "@" } }));
  sheet.getRow(1).font = { bold: true };

  help.columns = [{ width: 110 }];
  [
    "Add candidates to a batch",
    "",
    "Fill in the Candidates sheet, one new candidate per row (at most 500). All four columns are required.",
    "Phone: with the country code, e.g. +1 469 555 0142. One candidate per phone.",
    "Personal Email: one candidate per email.",
    "Technology and location come from the batch.",
    "Nothing is created unless every row is valid. You see a preview before anything is created.",
  ].forEach((line, i) => {
    const cell = help.getCell(i + 1, 1);
    cell.value = line;
    if (i === 0) cell.font = { bold: true, size: 14 };
  });

  return Buffer.from(await wb.xlsx.writeBuffer());
}
