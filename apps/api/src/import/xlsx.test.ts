import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { parseCsv } from "./csv.js";
import { detectHeaderRow, importRangeSource, readWorkbook, sheetToCsv, workbookSources, XLSX_LIMITS } from "./xlsx.js";

/** A minimal workbook zip: only the parts workbookSources reads. */
function workbookZip(sheets: { name: string; formula?: string }[]): Buffer {
  const files: Record<string, Uint8Array> = {
    "xl/workbook.xml": strToU8(`<workbook><sheets>${sheets.map((s, i) =>
      `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<Relationships>${sheets.map((_, i) =>
      `<Relationship Id="rId${i + 1}" Type="worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}</Relationships>`),
  };
  sheets.forEach((s, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(`<worksheet><sheetData><row r="1"><c r="A1" t="str">${
      s.formula ? `<f>${s.formula}</f>` : ""}<v>Date</v></c></row></sheetData></worksheet>`);
  });
  return Buffer.from(zipSync(files));
}

describe("xlsx helpers", () => {
  it("finds the header below title rows, not a data row", () => {
    expect(detectHeaderRow([["Hot list Q3"], [], ["Name", "Phone", "Tech"], ["Asha", 5551234567, "Java"]])).toBe(2);
    expect(detectHeaderRow([["Name", "Phone", "Tech"], ["Asha", "x", "y"]])).toBe(0);
  });

  it("round-trips through parseCsv with quoting", () => {
    const csv = sheetToCsv({ name: "S", headerRow: 1, headers: ["Name", "Note"], rows: [["Rao, Asha", 'said "hi"'], ["Ben", ""]] });
    expect(parseCsv(csv).rows).toEqual([
      { line: 2, cells: { Name: "Rao, Asha", Note: 'said "hi"' } },
      { line: 3, cells: { Name: "Ben", Note: "" } },
    ]);
  });

  it("refuses a header that is not on row 1 so review row numbers stay true", () => {
    expect(() => sheetToCsv({ name: "S", headerRow: 3, headers: ["A"], rows: [] })).toThrow(/header is on row 3/);
  });

  it("rejects non-zip and oversized input before parsing", async () => {
    await expect(readWorkbook(Buffer.from("a,b\n1,2\n"))).rejects.toThrow(/Not an .xlsx/);
    await expect(readWorkbook(Buffer.alloc(XLSX_LIMITS.bytes + 1))).rejects.toThrow(/larger than/);
  });

  it("reads the IMPORTRANGE source of a Google Sheets export, inside its DUMMYFUNCTION wrapper", () => {
    const f = '=IFERROR(__xludf.DUMMYFUNCTION("IMPORTRANGE(""1AbC-x_9"", ""Submissions!A:I"")"),"Date")';
    expect(importRangeSource(f)).toEqual({ spreadsheetId: "1AbC-x_9", range: "Submissions!A:I", tab: "Submissions" });
    expect(importRangeSource(`=IMPORTRANGE("k", "'Team Interviews'!A1:K")`)).toMatchObject({ tab: "Team Interviews" });
    expect(importRangeSource('=IFERROR(__xludf.DUMMYFUNCTION("""COMPUTED_VALUE"""),"Name")')).toBeUndefined();
  });

  it("maps sheet names to their sources from the workbook XML, XML-escaped as Excel writes it", () => {
    const xml = 'IFERROR(__xludf.DUMMYFUNCTION(&quot;IMPORTRANGE(&quot;&quot;id1&quot;&quot;, &quot;&quot;Placements!A:O&quot;&quot;)&quot;),&quot;Date&quot;)';
    const m = workbookSources(workbookZip([{ name: "R &amp; D Placements", formula: xml }, { name: "Pasted" }]));
    expect([...m.entries()]).toEqual([["R & D Placements", { spreadsheetId: "id1", range: "Placements!A:O", tab: "Placements" }]]);
    expect(workbookSources(Buffer.from("PK not a zip")).size).toBe(0);
  });
});
