import { describe, expect, it } from "vitest";
import { normalizeEmail, normalizePhoneE164, phoneProblem } from "./normalize.js";

describe("normalizePhoneE164", () => {
  it.each([
    ["+14695550142", "+14695550142"],
    [" +1 (469) 555-0142 ", "+14695550142"],
    ["+1.469.555.0142", "+14695550142"],
    ["0091 98765 43210", "+919876543210"],
    ["+91-98765-43210", "+919876543210"],
    // The bracketed national trunk prefix is dropped.
    ["+44 (0)20 7946 0018", "+442079460018"],
    ["+44(0)20 7946 0018", "+442079460018"],
    ["0044 (0)20 7946 0018", "+442079460018"],
    // Italy keeps its leading 0 in international format, so it is not refused.
    ["+39 06 6988 1234", "+390669881234"],
  ])("%s -> %s", (input, out) => expect(normalizePhoneE164(input)).toBe(out));

  it.each([
    ["4695550142", "missing_country_code"],
    ["(469) 555-0142", "missing_country_code"],
    ["+91 098765 43210", "trunk_zero"],
    ["+44 020 7946 0018", "trunk_zero"],
    ["+61 02 9374 4000", "trunk_zero"],
    ["+0 469 555 0142", "invalid"],
    ["+1 469 555 0142 ext 12", "invalid"],
    ["+1234567", "invalid"],
    ["+1234567890123456", "invalid"],
    ["", "invalid"],
    ["phone", "invalid"],
  ])("refuses %j (%s)", (input, problem) => {
    expect(normalizePhoneE164(input)).toBeNull();
    expect(phoneProblem(input)).toBe(problem);
  });
});

describe("normalizeEmail", () => {
  it("trims and lower-cases", () => expect(normalizeEmail("  Asha.Iyer@Example.COM ")).toBe("asha.iyer@example.com"));
});
