import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { CANDIDATE_TEMPLATE_HEADERS, buildCandidateImportTemplate } from "./candidate-import-template.js";

describe("batch candidates template", () => {
  it("has only the mandatory columns, as text, and an empty data sheet", async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await buildCandidateImportTemplate()) as unknown as ExcelJS.Buffer);
    const sheet = wb.getWorksheet("Candidates")!;
    expect((sheet.getRow(1).values as unknown[]).slice(1)).toEqual([...CANDIDATE_TEMPLATE_HEADERS]);
    expect(CANDIDATE_TEMPLATE_HEADERS).toEqual(["First Name", "Last Name", "Phone", "Personal Email"]);
    expect(sheet.getCell("A2").value).toBeNull();
    expect(sheet.getColumn(3).numFmt).toBe("@");
  });
});
