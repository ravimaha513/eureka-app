import { describe, expect, it } from "vitest";
import { csvToRows, parseCsv, tableToRows } from "./csv";

describe("parseCsv", () => {
  it("handles quotes, escaped quotes, commas in fields, CRLF, BOM and blank lines", () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n\r\nlast,')).toEqual([["a", "b"], ["x, y", 'say "hi"'], ["last", ""]]);
  });
});

describe("csvToRows", () => {
  it("maps header aliases in any order and drops empty optional cells", () => {
    expect(csvToRows("Location, Full Name ,E-mail,Title\nDallas,Asha Rao,asha@x.com,\n,Bo,bo@x.com,Lead"))
      .toEqual([
        { email: "asha@x.com", displayName: "Asha Rao", location: "Dallas" },
        { email: "bo@x.com", displayName: "Bo", designation: "Lead" },
      ]);
  });
  it("collects every Role column into roles, skipping blanks", () => {
    expect(tableToRows([
      ["Email", "Name", "Location", "Role 1", "Role 2", "Role 3"],
      ["asha@x.com", "Asha", "Dallas", "Recruiter", "", "Location Incharge"],
      ["bo@x.com", "Bo", "", "", "", ""],
      ["", "", "", "", "", ""],
    ])).toEqual([
      { email: "asha@x.com", displayName: "Asha", location: "Dallas", roles: ["Recruiter", "Location Incharge"] },
      { email: "bo@x.com", displayName: "Bo" },
    ]);
  });
  it("rejects a file without the required columns", () => {
    expect(() => csvToRows("email\na@x.com")).toThrow(/email and name/);
    expect(() => csvToRows("")).toThrow(/empty/);
  });
});
