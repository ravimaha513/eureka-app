import type { Scope, UserAccess } from "@eureka/shared";
import { describe, expect, it } from "vitest";
import { leadTeamCovered, leadTeamReach } from "./team-scope.js";

const ME = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const T_LED = "10000000-0000-4000-8000-000000000001";
const T_BELOW = "10000000-0000-4000-8000-000000000002";
const T_ELSEWHERE = "10000000-0000-4000-8000-000000000003";

function caller(scope: Scope | null) {
  const access: UserAccess = {
    userId: ME,
    roles: scope ? [{ role: "c_test", grants: { "team:add_member": scope } }] : [],
    teamIds: [T_LED], subordinateUserIds: [OTHER], subtreeTeamIds: [T_LED, T_BELOW],
    coachedTeamIds: [], subtreeCoachedTeamIds: [],
  };
  return { id: ME, access };
}

describe("leadTeamCovered (AD-10 team:add_member rule)", () => {
  it("org grant covers any team", () => {
    expect(leadTeamCovered(caller("org"), T_ELSEWHERE, OTHER)).toBe(true);
  });

  it("the team's lead is covered whatever the grant kind", () => {
    expect(leadTeamCovered(caller("team"), T_LED, ME)).toBe(true);
    expect(leadTeamCovered(caller(null), T_LED, ME)).toBe(true);
  });

  it("hierarchy grant covers teams led below, not others", () => {
    expect(leadTeamCovered(caller("hierarchy"), T_BELOW, OTHER)).toBe(true);
    expect(leadTeamCovered(caller("hierarchy"), T_ELSEWHERE, OTHER)).toBe(false);
  });

  it("team grant does not reach a team led by someone else", () => {
    expect(leadTeamCovered(caller("team"), T_BELOW, OTHER)).toBe(false);
  });
});

describe("leadTeamReach", () => {
  it("org: all", () => {
    expect(leadTeamReach(caller("org"))).toEqual({ all: true, hierarchyTeamIds: [] });
  });

  it("hierarchy: the subtree teams", () => {
    expect(leadTeamReach(caller("hierarchy"))).toEqual({ all: false, hierarchyTeamIds: [T_LED, T_BELOW] });
  });

  it("team: led teams only (no hierarchy ids)", () => {
    expect(leadTeamReach(caller("team"))).toEqual({ all: false, hierarchyTeamIds: [] });
  });
});
