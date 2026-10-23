import ExcelJS from "exceljs";

/** Columns of the bulk user import template; the web reader maps these headers back (apps/web/src/admin/csv.ts). */
export const TEMPLATE_HEADERS = ["Email", "Name", "Designation", "Location", "Role 1", "Role 2", "Role 3"] as const;
/** Matches the API's row limit (BulkCreateUsers). */
const ROWS = 500;

/**
 * The .xlsx users fill in for a bulk import (docs/admin-api.md). The Location and
 * Role columns get dropdowns from a hidden "Lists" sheet (a list range, because an
 * inline list is capped at 255 characters). Nothing in it is personal data, and the
 * data sheet starts empty so a forgotten example row can never be imported.
 */
export async function buildUserImportTemplate(roleLabels: string[], locations: string[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Eureka";
  const users = wb.addWorksheet("Users", { views: [{ state: "frozen", ySplit: 1 }] });
  const lists = wb.addWorksheet("Lists", { state: "veryHidden" });
  const help = wb.addWorksheet("Instructions");

  users.columns = TEMPLATE_HEADERS.map((h) => ({ header: h, key: h, width: h === "Email" ? 32 : h.startsWith("Role") ? 30 : 22 }));
  users.getRow(1).font = { bold: true };

  lists.getCell("A1").value = "Roles";
  roleLabels.forEach((r, i) => { lists.getCell(i + 2, 1).value = r; });
  lists.getCell("B1").value = "Locations";
  locations.forEach((l, i) => { lists.getCell(i + 2, 2).value = l; });

  const list = (col: "A" | "B", n: number, title: string): ExcelJS.DataValidation => ({
    type: "list",
    allowBlank: true,
    formulae: [`Lists!$${col}$2:$${col}$${n + 1}`],
    showErrorMessage: true,
    errorStyle: "stop",
    errorTitle: title,
    error: `Choose a ${title.toLowerCase()} from the list.`,
  });
  for (let r = 2; r <= ROWS + 1; r++) {
    if (locations.length > 0) users.getCell(r, 4).dataValidation = list("B", locations.length, "Location");
    for (let col = 5; col <= 7; col++) users.getCell(r, col).dataValidation = list("A", roleLabels.length, "Role");
  }

  help.columns = [{ width: 110 }];
  [
    "Bulk user import",
    "",
    "Fill in the Users sheet, one person per row (at most 500). Email and Name are required.",
    "Location: the person's primary location. Location Incharge and Location Ops Admin are granted for this location, so it is required for them.",
    "Role 1-3: pick from the dropdown; leave blank for fewer roles. Org Admin cannot be combined with another role.",
    "Restricted roles (for example HR, Accounts, CEO) are requested, not granted: another admin approves them under Users & Access > Approvals.",
    "Nothing is created unless every row is valid. Upload the file in Users & Access > Import users to preview it first.",
  ].forEach((line, i) => {
    const cell = help.getCell(i + 1, 1);
    cell.value = line;
    if (i === 0) cell.font = { bold: true, size: 14 };
  });

  return Buffer.from(await wb.xlsx.writeBuffer());
}
