import { describe, expect, it } from "vitest";
import { parseCsv, parseCsvRecords } from "./csv.js";

describe("CSV parser", () => {
  it("handles quotes, doubled quotes, embedded commas and newlines, CRLF and a BOM", () => {
    const text = '﻿Name,Note\r\n"Kumar, Ravi","said ""hi""\nthen left"\r\nAsha,plain\r\n';
    expect(parseCsvRecords(text)).toEqual([["Name", "Note"], ["Kumar, Ravi", 'said "hi"\nthen left'], ["Asha", "plain"]]);
  });

  it("maps cells by header, skips blank lines and keeps row numbers", () => {
    const t = parseCsv("A,B\n1,2\n,\n3\n4,5,extra\n");
    expect(t.headers).toEqual(["A", "B"]);
    expect(t.rows).toEqual([
      { line: 2, cells: { A: "1", B: "2" } },
      { line: 4, cells: { A: "3", B: "" } },
      { line: 5, cells: { A: "4", B: "5", "#3": "extra" } },
    ]);
  });

  it("rejects duplicate headers, a missing header row and an unterminated quote", () => {
    expect(() => parseCsv("A,a\n1,2")).toThrow(/appears twice/);
    expect(() => parseCsv("")).toThrow(/no header/);
    expect(() => parseCsvRecords('A\n"open')).toThrow(/quoted field/);
  });
});
