import { describe, expect, it } from "vitest";
import { csvToRows, parseCsv } from "./csv";

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
  it("rejects a file without the required columns", () => {
    expect(() => csvToRows("email\na@x.com")).toThrow(/email and name/);
    expect(() => csvToRows("")).toThrow(/empty/);
  });
});
