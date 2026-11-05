import { HttpException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { optionalIfMatch, parseIfMatch } from "./if-match.js";

describe("optionalIfMatch", () => {
  it("no header, empty or * means no check", () => {
    for (const h of [undefined, "", "  ", "*", " * "]) expect(optionalIfMatch(h)).toBeNull();
  });
  it("accepts N, \"N\" and W/\"N\", including 0", () => {
    expect(optionalIfMatch("3")).toBe(3);
    expect(optionalIfMatch('"3"')).toBe(3);
    expect(optionalIfMatch('W/"12"')).toBe(12);
    expect(optionalIfMatch('"0"')).toBe(0);
  });
  it("a malformed tag is 412 stale, never a silent skip", () => {
    for (const h of ["abc", "-1", '"01"', "1.5", '"1', "1234567890", "1, 2"]) {
      try {
        optionalIfMatch(h);
        expect.fail(`accepted ${h}`);
      } catch (e) {
        expect(e).toBeInstanceOf(HttpException);
        expect([(e as HttpException).getStatus(), (e as HttpException).getResponse()]).toEqual([412, "stale"]);
      }
    }
  });
  it("parseIfMatch (required-header routes) is unchanged", () => {
    expect(parseIfMatch('"0"')).toBeNull();
    expect(parseIfMatch("abc")).toBeNull();
    expect(parseIfMatch('"4"')).toBe(4);
  });
});
