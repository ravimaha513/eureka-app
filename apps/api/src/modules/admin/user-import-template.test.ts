import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { TEMPLATE_HEADERS, buildUserImportTemplate } from "./user-import-template.js";

async function load(roles: string[], locations: string[], teams: string[] = []) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await buildUserImportTemplate(roles, locations, teams)) as unknown as ExcelJS.Buffer);
  return wb;
}

describe("user import template", () => {
  it("has the header row, an empty data sheet and a hidden list sheet", async () => {
    const wb = await load(["Recruiter", "HR"], ["Dallas", "Hyderabad"]);
    const users = wb.getWorksheet("Users")!;
    expect((users.getRow(1).values as unknown[]).slice(1)).toEqual([...TEMPLATE_HEADERS]);
    expect(users.getCell("A2").value).toBeNull();
    const lists = wb.getWorksheet("Lists")!;
    expect(lists.state).toBe("veryHidden");
    expect([lists.getCell("A2").value, lists.getCell("A3").value]).toEqual(["Recruiter", "HR"]);
    expect([lists.getCell("B2").value, lists.getCell("B3").value]).toEqual(["Dallas", "Hyderabad"]);
  });

  it("puts role and location dropdowns on every data row", async () => {
    const users = (await load(["Recruiter", "HR", "CEO"], ["Dallas"])).getWorksheet("Users")!;
    for (const ref of ["G2", "H2", "I501"]) {
      expect(users.getCell(ref).dataValidation).toMatchObject({ type: "list", formulae: ["Lists!$A$2:$A$4"] });
    }
    expect(users.getCell("D2").dataValidation).toMatchObject({ type: "list", formulae: ["Lists!$B$2:$B$2"] });
    expect(users.getCell("A2").dataValidation).toBeUndefined();
    expect(users.getCell("E2").dataValidation).toBeUndefined();
  });

  it("puts a team dropdown on the Team column", async () => {
    const wb = await load(["Recruiter"], ["Dallas"], ["Team Anjali", "Team Rohit"]);
    expect(wb.getWorksheet("Lists")!.getCell("C3").value).toBe("Team Rohit");
    const users = wb.getWorksheet("Users")!;
    expect(users.getCell("F2").dataValidation).toMatchObject({ type: "list", formulae: ["Lists!$C$2:$C$3"] });
    expect(users.getCell("F501").dataValidation).toMatchObject({ type: "list" });
  });

  it("leaves Location free text when there are no locations", async () => {
    const users = (await load(["Recruiter"], [])).getWorksheet("Users")!;
    expect(users.getCell("D2").dataValidation).toBeUndefined();
    expect(users.getCell("F2").dataValidation).toBeUndefined();
  });
});
