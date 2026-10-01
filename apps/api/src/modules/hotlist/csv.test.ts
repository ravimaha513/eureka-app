import { describe, expect, it } from "vitest";
import { csvCell, toCsv } from "./csv.js";

describe("CSV", () => {
  it("quotes separators, quotes and line breaks", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
    expect(csvCell(null)).toBe("");
    expect(csvCell(42)).toBe("42");
  });

  it.each(["=HYPERLINK(\"x\")", "+1", "-2+3", "@SUM(A1)", "\tx", "\rx"])("neutralizes formula-looking text %j", (v) => {
    expect(csvCell(v).replace(/^"/, "")).toMatch(/^'/);
  });

  it("leaves numbers and masked phones alone", () => {
    expect(csvCell(-3)).toBe("-3");
    expect(csvCell("•••-•••-42")).toBe("•••-•••-42");
  });

  it("writes a BOM, a header and CRLF rows", () => {
    expect(toCsv(["A", "B"], [["1", null]])).toBe("﻿A,B\r\n1,\r\n");
  });
});
