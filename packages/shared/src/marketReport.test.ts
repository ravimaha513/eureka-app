import { describe, expect, it } from "vitest";
import { GRANTS, RESTRICTED_PERMISSIONS, ORG_SENSITIVE_PERMISSIONS, ROLES } from "./authz/catalog.js";
import { MARKETABLE_STATUSES } from "./authz/engine.js";
import { CANDIDATE_STATUSES } from "./authz/state-machines.js";
import { IN_MARKET_STATUSES, MARKET_REPORT_STATUSES, PLACED_STATUSES } from "./marketReport.js";

describe("market reports (gap L3)", () => {
  it("report.market:read: CEO org, AD and manager hierarchy, lead team, location roles their location; nobody else", () => {
    // Hand-written from the spec ("Scopes: CEO org; AD and manager hierarchy; lead team; location incharge /
    // location ops admin their location"), not generated from the catalog.
    const holders = Object.fromEntries(ROLES.filter((r) => GRANTS[r]["report.market:read"]).map((r) => [r, GRANTS[r]["report.market:read"]]));
    expect(holders).toEqual({
      lead: "team", manager: "hierarchy", assoc_director: "hierarchy", ceo: "org",
      location_incharge: "location", location_ops_admin: "location",
    });
    expect(RESTRICTED_PERMISSIONS).not.toContain("report.market:read");
    expect(ORG_SENSITIVE_PERMISSIONS).not.toContain("report.market:read");
  });

  it("every holder can also open the Reports page (report:read) and read the candidates it counts", () => {
    for (const role of ROLES) {
      const s = GRANTS[role]["report.market:read"];
      if (!s) continue;
      expect(GRANTS[role]["report:read"], role).toBeDefined();
      expect(GRANTS[role]["candidate:read"], role).toBe(s);
    }
  });

  it("in market is the actively marketed set; placed is on a project; the breakdown covers every status", () => {
    expect(new Set(IN_MARKET_STATUSES)).toEqual(MARKETABLE_STATUSES);
    expect(PLACED_STATUSES).toEqual(["placed"]);
    expect([...MARKET_REPORT_STATUSES]).toEqual([...CANDIDATE_STATUSES]);
  });
});
