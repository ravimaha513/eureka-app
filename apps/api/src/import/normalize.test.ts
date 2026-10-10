import { describe, expect, it } from "vitest";
import {
  clean, labelKey, lookupLabel, nameKey, normalizeColor, normalizeEmail, normalizeName, normalizePhone,
  normalizePlacementType, normalizeState, normalizeText, normalizeWorkMode, parseDate, parseRate, parseTime,
  plausibleDob, splitFullName, validTimeZone,
} from "./normalize.js";

const v = <T>(r: { ok: true; value: T } | { ok: false; reason: string }) => (r.ok ? r.value : `!${r.reason}`);

describe("clean", () => {
  it("trims, collapses whitespace and removes control characters", () => {
    expect(clean("  Asha \t\n Verma\u0007 ")).toBe("Asha Verma");
    expect(clean(null)).toBe("");
  });
});

describe("normalizeName", () => {
  it.each([
    ["ASHA", "Asha"], ["asha", "Asha"], ["  mary  ann ", "Mary Ann"], ["o'brien-smith", "O'Brien-Smith"],
    ["McDonald", "McDonald"], ["DeSouza", "DeSouza"], ["José", "José"], ["", null], ["Verma,", "Verma"],
  ])("%j -> %j", (input, out) => expect(v(normalizeName(input))).toBe(out));
  it.each(["Asha2", "a@b", "---", "x".repeat(81)])("rejects %j", (input) => expect(v(normalizeName(input))).toBe("!invalid_name"));
});

describe("splitFullName", () => {
  it("splits First Last, First Middle Last and Last, First", () => {
    expect(v(splitFullName("Asha Verma"))).toEqual({ first: "Asha", last: "Verma" });
    expect(v(splitFullName("mary ann  KUMAR"))).toEqual({ first: "Mary Ann", last: "Kumar" });
    expect(v(splitFullName("Kumar, Ravi"))).toEqual({ first: "Ravi", last: "Kumar" });
    expect(v(splitFullName(""))).toBe(null);
  });
  it("sends incomplete or odd names to review", () => {
    expect(v(splitFullName("Cher"))).toBe("!incomplete_name");
    expect(v(splitFullName("a, b, c"))).toBe("!invalid_name");
    expect(v(splitFullName("Kumar,"))).toBe("!incomplete_name");
  });
});

describe("normalizePhone without a default region", () => {
  it("requires the country code", () => {
    expect(v(normalizePhone("214-555-0101", null))).toBe("!phone_needs_country_code");
    expect(v(normalizePhone("+1 214 555 0101", null))).toBe("+12145550101");
  });
});

describe("plausibleDob", () => {
  it("accepts ages 16 to 80", () => {
    expect(plausibleDob("1995-03-15", "2026-10-01")).toBe(true);
    expect(plausibleDob("2010-10-02", "2026-10-01")).toBe(false);
    expect(plausibleDob("1940-01-01", "2026-10-01")).toBe(false);
  });
});

describe("nameKey", () => {
  it("is Unicode-aware and empty-safe", () => {
    expect(nameKey("राम", "शर्मा")).not.toBe(nameKey("सीता", "वर्मा"));
    expect(nameKey("---", "Kumar")).toBe(null);
  });
  it("ignores case, accents, punctuation and spacing", () => {
    expect(nameKey("José", "O'Brien")).toBe(nameKey("JOSE", "obrien"));
    expect(nameKey("Mary Ann", "Kumar")).toBe("maryann|kumar");
  });
});

describe("normalizeEmail", () => {
  it.each([
    ["Asha.M@Mktg.Example", "asha.m@mktg.example"], [" mailto:x@y.io ", "x@y.io"], ["<x@y.io>", "x@y.io"], ["", null],
  ])("%j -> %j", (input, out) => expect(v(normalizeEmail(input))).toBe(out));
  it.each([["a@b", "!invalid_email"], ["a..b@c.io", "!invalid_email"], ["no at sign", "!invalid_email"],
    ["a@b.io; c@d.io", "!multiple_emails"], ["a@b.io, c@d.io", "!multiple_emails"]])("%j -> %j", (input, out) =>
    expect(v(normalizeEmail(input))).toBe(out));
});

describe("normalizePhone (E.164, US default)", () => {
  it.each([
    ["(214) 555-0101", "+12145550101"], ["214.555.0102", "+12145550102"], ["+1 214 555 0103", "+12145550103"],
    ["2145550104", "+12145550104"], ["1-214-555-0105", "+12145550105"], ["214-555-0106 x204", "+12145550106"],
    ["+91 98765 43210", "+919876543210"], ["0091 98765 43210", "+919876543210"], ["+44 20 7946 0958", "+442079460958"], ["", null],
  ])("%j -> %j", (input, out) => expect(v(normalizePhone(input))).toBe(out));
  it.each(["555-01", "98765 43210 1", "123-555-0101", "214-155-0101", "call me", "+1 214 555 010", "21+4555", "9876543210 91",
    "9876543210", "(987) 654-3210", "+44 (0)20 7946 0958", "+91 098765 43210", "+1 555 555 0101"])(
    "rejects %j", (input) => expect(v(normalizePhone(input))).toBe("!invalid_phone"));
});

describe("parseDate (mixed formats, per-row day/month detection)", () => {
  it.each([
    ["2026-08-03", "2026-08-03"], ["2026/8/3", "2026-08-03"], ["03/15/1995", "1995-03-15"], ["21/07/1993", "1993-07-21"],
    ["4-Aug-2026", "2026-08-04"], ["4 August 2026", "2026-08-04"], ["Aug 4, 2026", "2026-08-04"], ["Tue, Aug 4th 2026", "2026-08-04"],
    ["Sep 25, 2026", "2026-09-25"], ["07.07.2026", "2026-07-07"], ["13/09/26", "2026-09-13"], ["3/15/95", "1995-03-15"],
    ["46000", "2025-12-09"], ["2026-08-03 10:30", "2026-08-03"], ["", null],
  ])("%j -> %j", (input, out) => expect(v(parseDate(input))).toBe(out));
  it("sends ambiguous day/month to review unless an order is configured", () => {
    expect(v(parseDate("05/06/1992"))).toBe("!ambiguous_date");
    expect(v(parseDate("05/06/1992", "MDY"))).toBe("1992-05-06");
    expect(v(parseDate("05/06/1992", "DMY"))).toBe("1992-06-05");
    expect(v(parseDate("13/05/2026", "MDY"))).toBe("!date_order_conflict"); // contradicts the column's order
    expect(v(parseDate("13/05/2026"))).toBe("2026-05-13"); // detect: a part above 12 decides it per row
  });
  it.each(["31/02/2026", "13/13/2026", "2026-02-30", "Foo 3, 2026", "yesterday", "1850-01-01"])("rejects %j", (input) =>
    expect(v(parseDate(input))).toBe("!invalid_date"));
  it("two-digit years use the pivot", () => {
    expect(v(parseDate("1/13/30", "detect", 30))).toBe("2030-01-13");
    expect(v(parseDate("1/13/31", "detect", 30))).toBe("1931-01-13");
  });
});

describe("parseTime", () => {
  it.each([["10:00 AM", "10:00"], ["10am", "10:00"], ["2:30 p.m.", "14:30"], ["12:15 am", "00:15"], ["12 pm", "12:00"],
    ["14:30", "14:30"], ["10.30 am", "10:30"], ["9:05:00", "09:05"], ["", null]])("%j -> %j", (input, out) =>
    expect(v(parseTime(input))).toBe(out));
  it.each(["25:00", "13 pm", "10", "10:75", "noon"])("rejects %j", (input) => expect(v(parseTime(input))).toBe("!invalid_time"));
});

describe("labels, colours and enums", () => {
  it("labelKey normalizes status text", () => {
    expect(labelKey("  Active / All   Teams ")).toBe("active/all teams");
    expect(labelKey("Full-of - Interviews")).toBe("full-of-interviews");
  });
  it("lookupLabel distinguishes mapped, placeholder (SRS Q6), unmapped and empty", () => {
    const map = { active: "active", hot: null } as Record<string, string | null>;
    expect(lookupLabel(map, "ACTIVE")).toEqual({ kind: "mapped", value: "active" });
    expect(lookupLabel(map, "Hot")).toEqual({ kind: "placeholder" });
    expect(lookupLabel(map, "Warm")).toEqual({ kind: "unmapped" });
    expect(lookupLabel(map, " ")).toEqual({ kind: "empty" });
    expect(lookupLabel(map, "constructor")).toEqual({ kind: "unmapped" });
  });
  it("normalizeColor", () => {
    expect(v(normalizeColor("#00FF00"))).toBe("#00ff00");
    expect(v(normalizeColor("0f0"))).toBe("#00ff00");
    expect(v(normalizeColor("Light Green"))).toBe("light green");
    expect(v(normalizeColor("#ffffff"))).toBe(null);
    expect(v(normalizeColor("rgb(1,2,3)"))).toBe("!invalid_row_color");
  });
  it("parseRate takes hourly rates only", () => {
    expect(v(parseRate("$65/hr"))).toBe(65);
    expect(v(parseRate("80 per hour"))).toBe(80);
    expect(v(parseRate("72.50"))).toBe(72.5);
    for (const [cell, n] of [["60hr", 60], ["60/Hr", 60], ["$70/", 70], ["70/", 70]] as const) expect(v(parseRate(cell)), cell).toBe(n);
    expect(v(parseRate(""))).toBe(null);
    for (const bad of ["$120k", "0", "1500", "65/day", "sixty"]) expect(v(parseRate(bad)), bad).toBe("!invalid_rate");
  });
  it("placement type, work mode and state", () => {
    expect(v(normalizePlacementType("Corp to Corp"))).toBe("c2c");
    expect(v(normalizePlacementType("W-2"))).toBe("w2");
    expect(v(normalizePlacementType("contract"))).toBe("!invalid_placement_type");
    expect(v(normalizeWorkMode("On-Site"))).toBe("onsite");
    expect(v(normalizeWorkMode("WFH"))).toBe("remote");
    expect(v(normalizeWorkMode("sometimes"))).toBe("!invalid_work_mode");
    expect(v(normalizeState("Texas"))).toBe("TX");
    expect(v(normalizeState("tx"))).toBe("TX");
    expect(v(normalizeState("Ontario"))).toBe("!invalid_state");
    expect(v(normalizeText("x".repeat(5), 4))).toBe("!text_too_long");
  });
  it("validTimeZone", () => {
    expect(validTimeZone("America/Chicago")).toBe(true);
    expect(validTimeZone("Mars/Base")).toBe(false);
  });
});
