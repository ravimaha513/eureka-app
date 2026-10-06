import { describe, expect, it } from "vitest";
import { parseCsv } from "./csv.js";
import { detectHeaderRow, readWorkbook, sheetToCsv, XLSX_LIMITS } from "./xlsx.js";

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
});
