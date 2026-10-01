import { describe, expect, it } from "vitest";
import { normalizeEmail, normalizePhoneE164 } from "./normalize.js";

describe("normalizePhoneE164", () => {
  it.each([
    ["+14695550142", "+14695550142"],
    [" +1 (469) 555-0142 ", "+14695550142"],
    ["+1.469.555.0142", "+14695550142"],
    ["0091 98765 43210", "+919876543210"],
    ["+91-98765-43210", "+919876543210"],
  ])("%s -> %s", (input, out) => expect(normalizePhoneE164(input)).toBe(out));

  it.each(["4695550142", "(469) 555-0142", "+0 469 555 0142", "+1 469 555 0142 ext 12", "+1234567", "+1234567890123456", "", "phone"])(
    "refuses %j (no country code, or not a phone number)", (input) => expect(normalizePhoneE164(input)).toBeNull());
});

describe("normalizeEmail", () => {
  it("trims and lower-cases", () => expect(normalizeEmail("  Asha.Iyer@Example.COM ")).toBe("asha.iyer@example.com"));
});
