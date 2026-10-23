import { describe, expect, it } from "vitest";
import { DOCUMENTS_FILTERS, ELIGIBILITY_LIST, VISA_CATEGORY_LIST, marketingStatusLabel } from "./candidates.js";

describe("marketingStatusLabel (spec values, derived)", () => {
  it("Active/Remote, Active/All Teams and both", () => {
    expect(marketingStatusLabel("active", "team", false)).toBe("Active");
    expect(marketingStatusLabel("active", "team", true)).toBe("Active/Remote");
    expect(marketingStatusLabel("active", "all_teams", false)).toBe("Active/All Teams");
    expect(marketingStatusLabel("active", "all_teams", true)).toBe("Active/Remote/All Teams");
  });

  it("N/A before marketing; other statuses keep their own label", () => {
    expect(marketingStatusLabel("in_training", "all_teams", true)).toBe("N/A");
    expect(marketingStatusLabel("on_hold", "all_teams", true)).toBe("On hold");
    expect(marketingStatusLabel("full_of_interviews", "team", false)).toBe("Full of interviews");
  });
});

describe("vocabularies", () => {
  it("eligibility includes in person; keys are database-safe", () => {
    expect(ELIGIBILITY_LIST).toContain("in_person");
    for (const k of [...ELIGIBILITY_LIST, ...VISA_CATEGORY_LIST]) expect(k).toMatch(/^[a-z][a-z0-9_]{1,39}$/);
    expect(DOCUMENTS_FILTERS).toContain("none");
  });
});
