import { describe, expect, it } from "vitest";
import { redactChanges } from "./audit.service.js";

describe("audit redaction (rule 5)", () => {
  it("redacts phones, emails, VITEL numbers, DOB and rates in either spelling; keeps the rest", () => {
    expect(redactChanges({
      priority: "P1", marketingEmail: "a@mkt.example", marketing_email: "a@mkt.example", vitelNumber: "+14695550100",
      email: "a@example.com", personalEmail: "a@example.com", phone: "+14695550101", rate: 55, technologyId: "t1",
    })).toEqual({
      priority: "P1", marketingEmail: "[redacted]", marketing_email: "[redacted]", vitelNumber: "[redacted]",
      email: "[redacted]", personalEmail: "[redacted]", phone: "[redacted]", rate: "[redacted]", technologyId: "t1",
    });
    expect(redactChanges({ number: "EAC2190012345", numberEnc: "x", number_enc: "x", workAuthNumber: "A1", type: "h1b" }))
      .toEqual({ number: "[redacted]", numberEnc: "[redacted]", number_enc: "[redacted]", workAuthNumber: "[redacted]", type: "h1b" });
    expect(redactChanges(undefined)).toBeNull();
  });
});
